// Local providers (LM Studio, Ollama) must resolve sane defaults, need no API
// key, and never collide with NVIDIA's own state in the config file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

process.env.PALIMORPH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'palimorph-test-'));
delete process.env.NIM_BASE_URL;
delete process.env.NVIDIA_API_KEY;
delete process.env.NIM_API_KEY;

const { PROVIDERS, resolveProvider, resolveBaseUrl, resolveApiKey, scopedKey, providerView, saveConfig, loadConfig } = await import('../src/config.js');
const { rankModels } = await import('../src/models.js');

// --- defaults ---
assert.equal(resolveProvider({}, loadConfig()), 'nvidia', 'nvidia is the default provider');
assert.equal(resolveBaseUrl('lmstudio', {}, loadConfig()), 'http://127.0.0.1:1234/v1');
assert.equal(resolveBaseUrl('ollama', {}, loadConfig()), 'http://127.0.0.1:11434/v1');
assert.throws(() => resolveBaseUrl('custom', {}, loadConfig()), /needs a --base-url/);
assert.equal(resolveBaseUrl('custom', { baseUrl: 'http://box:8080/v1' }, loadConfig()), 'http://box:8080/v1');
assert.throws(() => resolveProvider({ provider: 'bogus' }, loadConfig()), /unknown provider/);

// --- no key required for local providers ---
assert.equal(PROVIDERS.lmstudio.requiresKey, false);
assert.equal(PROVIDERS.ollama.requiresKey, false);
assert.equal(resolveApiKey('lmstudio', loadConfig()), 'not-needed');
assert.equal(resolveApiKey('ollama', loadConfig()), 'not-needed');
assert.equal(resolveApiKey('nvidia', loadConfig()), null, 'nvidia still requires an explicit key');

// --- --base-url override wins, then a saved per-provider override ---
saveConfig({ providers: { lmstudio: { baseUrl: 'http://localhost:9999/v1' } } });
assert.equal(resolveBaseUrl('lmstudio', {}, loadConfig()), 'http://localhost:9999/v1', 'saved override beats the preset default');
assert.equal(resolveBaseUrl('lmstudio', { baseUrl: 'http://localhost:1/v1' }, loadConfig()), 'http://localhost:1/v1', 'flag beats the saved override');

// --- per-model state is namespaced by provider, nvidia keeps bare ids ---
assert.equal(scopedKey('nvidia', 'meta/llama-3.3-70b-instruct'), 'meta/llama-3.3-70b-instruct');
assert.equal(scopedKey('lmstudio', 'qwen2.5-coder'), 'lmstudio:qwen2.5-coder');

saveConfig({
  lastModel: scopedKey('ollama', 'llama3.1'),
  favorites: [scopedKey('nvidia', 'meta/llama-3.3-70b-instruct'), scopedKey('ollama', 'llama3.1')],
  toolChecks: { [scopedKey('ollama', 'llama3.1')]: { ok: true }, 'meta/llama-3.3-70b-instruct': { ok: true } },
});
const cfg = loadConfig();
const ollamaView = providerView(cfg, 'ollama');
assert.equal(ollamaView.lastModel, 'llama3.1');
assert.deepEqual(ollamaView.favorites, ['llama3.1']);
assert.ok(ollamaView.toolChecks['llama3.1']?.ok);
const nvidiaView = providerView(cfg, 'nvidia');
assert.equal(nvidiaView.lastModel, cfg.lastModel, 'nvidia view is unscoped (same object)');
assert.ok(nvidiaView.favorites.includes('meta/llama-3.3-70b-instruct'));

// --- a merged multi-provider list never cross-matches identically-named models ---
saveConfig({
  lastModel: 'llama3.1', // an nvidia-scoped (bare) lastModel...
  favorites: [],
  toolChecks: {},
});
const mergedCfg = loadConfig();
const merged = [
  { id: 'llama3.1', provider: 'nvidia' },
  { id: 'llama3.1', provider: 'ollama' }, // ...must not be treated as "last" for the ollama one
];
const rankedMerged = rankModels(merged, mergedCfg);
assert.equal(rankedMerged[0].provider, 'nvidia', 'the bare lastModel only matches the nvidia entry');
assert.notEqual(rankedMerged[0].id + ':' + rankedMerged[0].provider, rankedMerged[1].id + ':' + rankedMerged[1].provider);

// --- createProxy talks to an explicit baseUrl for a non-NVIDIA provider ---
const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'hi from lmstudio' }, finish_reason: 'stop' }], usage: {} }));
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${fake.address().port}/v1`;

const { createProxy, listen } = await import('../src/proxy.js');
const server = createProxy({ apiKey: 'not-needed', model: 'qwen2.5-coder', token: null, baseUrl, provider: 'lmstudio' });
const port = await listen(server);
const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
});
const json = await res.json();
assert.equal(json.content[0].text, 'hi from lmstudio', 'proxy used the explicit baseUrl, not the NIM default');

fake.close();
await new Promise((r) => server.close(r));
console.log('✔ provider resolution assertions passed');
