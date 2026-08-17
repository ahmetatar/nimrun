// Upstream failures must arrive as well-formed Anthropic errors, and the arg
// parser must not silently swallow unknown flags.
import http from 'node:http';
import assert from 'node:assert/strict';

let status = 429;
const fake = http.createServer((req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'too many requests' } }));
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.NIM_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;

const { createProxy, listen } = await import('../src/proxy.js');
const server = createProxy({ apiKey: 'k', model: 'm', token: null, retries: 0 });
const port = await listen(server);
const url = `http://127.0.0.1:${port}/v1/messages`;
const H = { 'Content-Type': 'application/json' };
const body = JSON.stringify({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });

for (const [code, type] of [[429, 'rate_limit_error'], [401, 'authentication_error'], [400, 'invalid_request_error'], [500, 'api_error']]) {
  status = code;
  const res = await fetch(url, { method: 'POST', headers: H, body });
  const json = await res.json();
  assert.equal(res.status, code === 500 ? 502 : code, `status for upstream ${code}`);
  assert.equal(json.type, 'error');
  assert.equal(json.error.type, type, `error type for upstream ${code}`);
  // the 429 body NIM returns says nothing actionable, so nimrun replaces it
  assert.match(json.error.message, code === 429 ? /rate limit on m/ : /too many requests/);
}

// malformed body
const badJson = await fetch(url, { method: 'POST', headers: H, body: '{nope' });
assert.equal(badJson.status, 400);
assert.equal((await badJson.json()).error.type, 'invalid_request_error');

// unknown route
const notFound = await fetch(`http://127.0.0.1:${port}/v1/complete`, { method: 'POST', headers: H, body: '{}' });
assert.equal(notFound.status, 404);

// a burst-rejected request should be retried, not surfaced as a failed turn
let attempts = 0;
const flaky = http.createServer((req, res) => {
  attempts += 1;
  if (attempts < 3) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '0.05' });
    res.end('{"status":429}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }], usage: {} }));
});
await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
process.env.NIM_BASE_URL = `http://127.0.0.1:${flaky.address().port}/v1`;

const retrying = createProxy({ apiKey: 'k', model: 'm', token: null, retries: 4 });
const rport = await listen(retrying);
const recovered = await (await fetch(`http://127.0.0.1:${rport}/v1/messages`, { method: 'POST', headers: H, body })).json();
assert.equal(attempts, 3, 'retried until the upstream accepted');
assert.equal(recovered.content[0].text, 'recovered', 'a transient 429 never reaches the client');

// only one request may be in flight upstream at a time by default
let peak = 0, live = 0;
const counting = http.createServer((req, res) => {
  live += 1; peak = Math.max(peak, live);
  setTimeout(() => {
    live -= 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }));
  }, 60);
});
await new Promise((r) => counting.listen(0, '127.0.0.1', r));
process.env.NIM_BASE_URL = `http://127.0.0.1:${counting.address().port}/v1`;
const serial = createProxy({ apiKey: 'k', model: 'm', token: null });
const sport = await listen(serial);
await Promise.all([1, 2, 3, 4].map(() =>
  fetch(`http://127.0.0.1:${sport}/v1/messages`, { method: 'POST', headers: H, body })));
assert.equal(peak, 1, `default concurrency must serialise upstream calls, saw ${peak} in flight`);

const { parseArgs } = await import('../src/cli.js');
const a = parseArgs(['qwen/qwen3-coder', '--small', 'meta/llama-3.1-8b-instruct', '--debug', '--', '-p', 'hello --all']);
assert.deepEqual(a._, ['qwen/qwen3-coder']);
assert.equal(a.flags.small, 'meta/llama-3.1-8b-instruct');
assert.equal(a.flags.debug, true);
assert.deepEqual(a.claudeArgs, ['-p', 'hello --all'], 'args after -- belong to claude, flags and all');
assert.throws(() => parseArgs(['--nope']), /unknown option/);

fake.close(); flaky.close(); counting.close();
await Promise.all([server, retrying, serial].map((s) => new Promise((r) => s.close(r))));
console.log('✔ error mapping + arg parsing assertions passed');
