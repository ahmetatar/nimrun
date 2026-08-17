import http from 'node:http';
import { nimBaseUrl } from './config.js';
import { anthropicToOpenAI, openAIToAnthropic, estimateTokens } from './translate.js';
import { AnthropicStreamWriter, createSSEParser } from './stream.js';

/**
 * Caps how many requests are in flight upstream at once. NIM enforces a
 * per-model concurrency limit — several models allow exactly one — and Claude
 * Code fires background calls alongside the main query, so without this the
 * very first turn can 429.
 */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < max && waiting.length) {
      active += 1;
      waiting.shift()();
    }
  };
  return {
    acquire() {
      return new Promise((resolve) => {
        let released = false;
        waiting.push(() => resolve(() => {
          if (released) return;
          released = true;
          active -= 1;
          pump();
        }));
        pump();
      });
    },
    get queued() { return waiting.length; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function anthropicError(res, status, message, type = 'api_error') {
  sendJSON(res, status, { type: 'error', error: { type, message } });
}

/**
 * Local Anthropic-compatible endpoint that forwards to NIM. Bound to loopback and
 * gated on a per-run token so nothing else on the machine can use it.
 */
export function createProxy({
  apiKey, model, smallModel, maxTokens, token,
  debug = false, stats = null, concurrency = 1, retries = 4,
}) {
  const limiter = createLimiter(Math.max(1, concurrency));
  const log = (...a) => { if (debug) process.stderr.write(`[nimrun] ${a.join(' ')}\n`); };
  const count = (usage) => {
    if (!stats || !usage) return;
    stats.inputTokens += usage.input_tokens || 0;
    stats.outputTokens += usage.output_tokens || 0;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') return sendJSON(res, 200, { ok: true, model });

    if (token) {
      const provided = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (provided !== token) return anthropicError(res, 401, 'nimrun: bad local token', 'authentication_error');
    }

    if (req.method !== 'POST') return anthropicError(res, 404, `no route for ${req.method} ${url.pathname}`, 'not_found_error');

    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      return anthropicError(res, 400, `invalid JSON body: ${err.message}`, 'invalid_request_error');
    }

    if (url.pathname.endsWith('/count_tokens')) {
      return sendJSON(res, 200, { input_tokens: estimateTokens(body) });
    }

    if (!url.pathname.endsWith('/messages')) {
      return anthropicError(res, 404, `no route for ${url.pathname}`, 'not_found_error');
    }

    // Claude Code addresses its cheap background model by name; route those to
    // the small model so the expensive pick is not spent on title generation.
    const wantsSmall = /haiku/i.test(body.model || '');
    const target = wantsSmall && smallModel ? smallModel : model;

    const upstream = anthropicToOpenAI(body, { model: target, maxTokens });
    log(`-> ${target} stream=${upstream.stream} msgs=${upstream.messages.length} tools=${upstream.tools?.length || 0}`);

    if (stats) stats.requests += 1;

    const abort = new AbortController();
    req.on('close', () => { if (!res.writableEnded) abort.abort(); });

    if (limiter.queued) log(`queued behind ${limiter.queued} request(s)`);
    const release = await limiter.acquire();
    if (abort.signal.aborted) { release(); return; }

    const callUpstream = () => fetch(`${nimBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: upstream.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(upstream),
      signal: abort.signal,
    });

    let upstreamRes;
    try {
      upstreamRes = await callUpstream();
      // NIM rejects bursts rather than queueing them, so absorb 429s here instead
      // of surfacing a failed turn to Claude Code.
      for (let attempt = 0; upstreamRes.status === 429 && attempt < retries; attempt++) {
        const header = Number.parseFloat(upstreamRes.headers.get('retry-after') || '');
        const wait = Number.isFinite(header) ? header * 1000 : 2 ** attempt * 1000 + Math.random() * 400;
        log(`429 from upstream, retrying in ${Math.round(wait)}ms (${attempt + 1}/${retries})`);
        await upstreamRes.body?.cancel().catch(() => {});
        await sleep(wait);
        if (abort.signal.aborted) { release(); return; }
        upstreamRes = await callUpstream();
      }
    } catch (err) {
      release();
      if (abort.signal.aborted) return;
      if (stats) stats.errors += 1;
      return anthropicError(res, 502, `NIM request failed: ${err.message}`);
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => '');
      log(`<- ${upstreamRes.status} ${text.slice(0, 400)}`);
      if (stats) stats.errors += 1;
      release();
      const status = [400, 401, 403, 404, 429].includes(upstreamRes.status) ? upstreamRes.status : 502;
      const type = status === 429 ? 'rate_limit_error'
        : status === 401 || status === 403 ? 'authentication_error'
        : status === 400 ? 'invalid_request_error'
        : 'api_error';
      // NIM's 429 body is just {"status":429,"title":"Too Many Requests"}, which
      // tells the user nothing about what to do next.
      const message = status === 429
        ? `NIM rate limit on ${target} after ${retries} retries. NVIDIA enforces a per-model `
          + `request quota per account; this model is exhausted for now. Wait, or run nimrun `
          + `with a different model.`
        : `NIM ${upstreamRes.status}: ${text.slice(0, 800)}`;
      return anthropicError(res, status, message, type);
    }

    if (!upstream.stream) {
      try {
        const json = await upstreamRes.json();
        const converted = openAIToAnthropic(json, body.model || target);
        count(converted.usage);
        return sendJSON(res, 200, converted);
      } finally {
        release();
      }
    }

    const writer = new AnthropicStreamWriter(res, body.model || target);
    const parser = createSSEParser((payload) => writer.chunk(payload));

    // Open the SSE response as soon as the upstream accepts the request. A cold
    // NIM model can take minutes to emit its first token, and a client that has
    // not seen response headers by then gives up with a headers timeout.
    writer.start();
    const ping = setInterval(() => writer.ping(), 15000);

    try {
      const decoder = new TextDecoder();
      for await (const piece of upstreamRes.body) {
        parser.push(decoder.decode(piece, { stream: true }));
      }
      clearInterval(ping);
      release();
      writer.end();
      count(writer.usage);
    } catch (err) {
      clearInterval(ping);
      release();
      if (abort.signal.aborted) return;
      if (stats) stats.errors += 1;
      writer.fail(err.message);
    }
  });

  return server;
}

export function listen(server, { host = '127.0.0.1', port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}
