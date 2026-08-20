// Full chain: fake NIM upstream <- proxy <- spawned child using only the env
// vars palimorph injects. Proves the child can reach the proxy with nothing but
// ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN, and that stats survive the round trip.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'c1',
    choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 8 },
  }));
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.NIM_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;
process.env.PALIMORPH_NO_BANNER = '1';

const out = path.join(os.tmpdir(), `palimorph-session-${process.pid}.json`);
const child = path.join(os.tmpdir(), `palimorph-child-${process.pid}.mjs`);
fs.writeFileSync(child, [
  "// stands in for Claude Code: talks Anthropic to whatever ANTHROPIC_BASE_URL says",
  "import fs from 'node:fs';",
  "const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {",
  "  method: 'POST',",
  "  headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_AUTH_TOKEN },",
  "  body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] }),",
  "});",
  "const json = await res.json();",
  `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ status: res.status, json, model: process.env.ANTHROPIC_MODEL }));`,
].join('\n'));

const { runClaude } = await import('../src/run.js');
const code = await runClaude({
  apiKey: 'nvapi-test',
  model: 'meta/llama-3.3-70b-instruct',
  smallModel: 'meta/llama-3.1-8b-instruct',
  claudeArgs: [child],
  bin: process.execPath,
});

assert.equal(code, 0, 'child exits cleanly');
const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
assert.equal(seen.status, 200, 'child reached the proxy using only injected env vars');
assert.equal(seen.model, 'meta/llama-3.3-70b-instruct', 'ANTHROPIC_MODEL is the NIM model');
assert.equal(seen.json.type, 'message');
assert.equal(seen.json.content[0].text, 'pong');
assert.equal(seen.json.usage.input_tokens, 120);

fs.rmSync(out, { force: true });
fs.rmSync(child, { force: true });
fake.close();
console.log('✔ end-to-end session assertions passed');
