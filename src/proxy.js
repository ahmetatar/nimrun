import http from 'node:http';
import { NIM_BASE_URL } from './config.js';
import { anthropicToOpenAI, openAIToAnthropic, estimateTokens } from './translate.js';
import { AnthropicStreamWriter, createSSEParser } from './stream.js';

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
export function createProxy({ apiKey, model, smallModel, maxTokens, token, debug = false, stats = null }) {
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

    let upstreamRes;
    try {
      upstreamRes = await fetch(`${NIM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: upstream.stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(upstream),
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      if (stats) stats.errors += 1;
      return anthropicError(res, 502, `NIM request failed: ${err.message}`);
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => '');
      log(`<- ${upstreamRes.status} ${text.slice(0, 400)}`);
      if (stats) stats.errors += 1;
      const status = [400, 401, 403, 404, 429].includes(upstreamRes.status) ? upstreamRes.status : 502;
      const type = status === 429 ? 'rate_limit_error'
        : status === 401 || status === 403 ? 'authentication_error'
        : status === 400 ? 'invalid_request_error'
        : 'api_error';
      return anthropicError(res, status, `NIM ${upstreamRes.status}: ${text.slice(0, 800)}`, type);
    }

    if (!upstream.stream) {
      const json = await upstreamRes.json();
      const converted = openAIToAnthropic(json, body.model || target);
      count(converted.usage);
      return sendJSON(res, 200, converted);
    }

    const writer = new AnthropicStreamWriter(res, body.model || target);
    const parser = createSSEParser((payload) => writer.chunk(payload));

    try {
      const decoder = new TextDecoder();
      for await (const piece of upstreamRes.body) {
        parser.push(decoder.decode(piece, { stream: true }));
      }
      writer.end();
      count(writer.usage);
    } catch (err) {
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
