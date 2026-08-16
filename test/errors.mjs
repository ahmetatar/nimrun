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
const server = createProxy({ apiKey: 'k', model: 'm', token: null });
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
  assert.match(json.error.message, /too many requests/);
}

// malformed body
const badJson = await fetch(url, { method: 'POST', headers: H, body: '{nope' });
assert.equal(badJson.status, 400);
assert.equal((await badJson.json()).error.type, 'invalid_request_error');

// unknown route
const notFound = await fetch(`http://127.0.0.1:${port}/v1/complete`, { method: 'POST', headers: H, body: '{}' });
assert.equal(notFound.status, 404);

const { parseArgs } = await import('../src/cli.js');
const a = parseArgs(['qwen/qwen3-coder', '--small', 'meta/llama-3.1-8b-instruct', '--debug', '--', '-p', 'hello --all']);
assert.deepEqual(a._, ['qwen/qwen3-coder']);
assert.equal(a.flags.small, 'meta/llama-3.1-8b-instruct');
assert.equal(a.flags.debug, true);
assert.deepEqual(a.claudeArgs, ['-p', 'hello --all'], 'args after -- belong to claude, flags and all');
assert.throws(() => parseArgs(['--nope']), /unknown option/);

fake.close();
await new Promise((r) => server.close(r));
console.log('✔ error mapping + arg parsing assertions passed');
