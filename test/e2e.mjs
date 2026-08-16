// Boots a fake NIM upstream, points the proxy at it, and drives the proxy the
// way Claude Code does: streaming, tool calls, and the tool_result round trip.
import http from 'node:http';
import assert from 'node:assert/strict';

const received = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    received.push(parsed);
    const mode = parsed.messages.some((m) => m.role === 'tool') ? 'final' : 'tool';
    if (!parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-1', choices: [{ message: { role: 'assistant', content: '<think>hmm</think>plain answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (mode === 'tool') {
      send({ choices: [{ delta: { content: '<think>secret' } }] });
      send({ choices: [{ delta: { content: ' plan</think>Let me read it.' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path"' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.txt"}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ delta: { content: 'The file says hi.' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    send({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.NIM_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;

const { createProxy, listen } = await import('../src/proxy.js');
const server = createProxy({ apiKey: 'nvapi-test', model: 'meta/llama-3.3-70b-instruct', smallModel: 'meta/llama-3.1-8b-instruct', token: 'tok' });
const port = await listen(server);
const url = `http://127.0.0.1:${port}/v1/messages`;
const H = { 'Content-Type': 'application/json', 'x-api-key': 'tok' };

// --- auth gate ---
const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'nope' }, body: '{}' });
assert.equal(bad.status, 401, 'bad token must be rejected');

// --- count_tokens ---
const ct = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
  method: 'POST', headers: H, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(40) }] }),
});
assert.equal(ct.status, 200);
assert.ok((await ct.json()).input_tokens > 0, 'count_tokens returns an estimate');

// --- non-streaming, with think-tag stripping ---
const ns = await (await fetch(url, {
  method: 'POST', headers: H,
  body: JSON.stringify({ model: 'claude-sonnet-4', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
})).json();
assert.equal(ns.type, 'message');
assert.equal(ns.content[0].text, 'plain answer', 'inline <think> must be stripped');
assert.equal(ns.stop_reason, 'end_turn');
assert.equal(ns.usage.input_tokens, 11);

// --- streaming turn 1: text + tool call ---
async function stream(body) {
  const res = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const raw = await res.text();
  return raw.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.split('\ndata: ')[1]));
}

const events = await stream({
  model: 'claude-sonnet-4', max_tokens: 1000, stream: true,
  system: [{ type: 'text', text: 'You are Claude Code.' }],
  tools: [{ name: 'Read', description: 'read a file', input_schema: { $schema: 'x', type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } }],
  tool_choice: { type: 'auto' },
  messages: [{ role: 'user', content: 'read a.txt' }],
});

const types = events.map((e) => e.type);
assert.equal(types[0], 'message_start');
assert.equal(types.at(-1), 'message_stop');

const text = events.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
assert.equal(text, 'Let me read it.', `think block leaked: ${JSON.stringify(text)}`);

const toolStart = events.find((e) => e.content_block?.type === 'tool_use');
assert.ok(toolStart, 'tool_use block must open');
assert.equal(toolStart.content_block.name, 'Read');
assert.equal(toolStart.index, 1, 'tool block gets its own index after the text block');
const args = events.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join('');
assert.deepEqual(JSON.parse(args), { path: 'a.txt' });
assert.equal(events.find((e) => e.type === 'message_delta').delta.stop_reason, 'tool_use');

// every opened block is closed, exactly once
const opened = events.filter((e) => e.type === 'content_block_start').map((e) => e.index);
const closed = events.filter((e) => e.type === 'content_block_stop').map((e) => e.index);
assert.deepEqual(opened, [0, 1]);
assert.deepEqual(closed, [0, 1]);

// upstream request shape
const sent = received.at(-1);
assert.equal(sent.messages[0].role, 'system');
assert.equal(sent.tools[0].function.name, 'Read');
assert.ok(!('$schema' in sent.tools[0].function.parameters), '$schema must be stripped');
assert.ok(!('additionalProperties' in sent.tools[0].function.parameters), 'additionalProperties must be stripped');
assert.equal(sent.tool_choice, 'auto');
assert.equal(sent.max_tokens, 1000);

// --- streaming turn 2: the tool_result round trip ---
const events2 = await stream({
  model: 'claude-sonnet-4', max_tokens: 1000, stream: true,
  messages: [
    { role: 'user', content: 'read a.txt' },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me read it.' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hi' }, { type: 'text', text: 'thanks' }] },
  ],
});
const sent2 = received.at(-1);
assert.deepEqual(sent2.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
assert.equal(sent2.messages[1].tool_calls[0].id, 'call_1');
assert.equal(sent2.messages[2].tool_call_id, 'call_1');
assert.equal(sent2.messages[2].content, 'hi');
assert.equal(events2.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join(''), 'The file says hi.');

// --- haiku routing hits the small model ---
await stream({ model: 'claude-3-5-haiku-20241022', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'title this' }] });
assert.equal(received.at(-1).model, 'meta/llama-3.1-8b-instruct', 'haiku requests route to the small model');

// --- upstream error surfaces as an Anthropic error ---
fake.close();
await new Promise((r) => server.close(r));
console.log('\n✔ all proxy assertions passed');
