import { nimBaseUrl } from './config.js';

/**
 * build.nvidia.com's catalog is served verbatim by the NIM /v1/models endpoint,
 * and LM Studio / Ollama's OpenAI-compat mode serves the same shape for whatever
 * is loaded/pulled locally, so one fetch works for every provider.
 */
export async function fetchModels(apiKey, baseUrl = nimBaseUrl(), { signal } = {}) {
  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${baseUrl}/models failed (${res.status} ${res.statusText}) ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map((m) => ({ id: m.id, owner: m.owned_by || m.publisher || vendorOf(m.id) }));
}

function vendorOf(id) {
  return String(id).includes('/') ? String(id).split('/')[0] : 'nvidia';
}

// Endpoints on the same host that speak a different protocol than chat/completions.
const NON_CHAT = [
  'embed', 'embedqa', 'rerank', 'retriever', 'nv-embed', 'nv-rerank',
  'ocdrnet', 'ocr', 'paddleocr', 'parakeet', 'riva', 'fastpitch',
  'stable-diffusion', 'sdxl', 'flux', 'edify', 'clip', 'segment',
  'protein', 'molmim', 'esmfold', 'diffdock', 'genmol', 'alphafold',
  'nemoguard', 'earth2', 'cosmos-tokenize', 'audio2face', 'table-structure',
  'graphic-elements', 'page-elements', 'nemoretriever', 'depth',
];

export function isChatModel(id, provider = 'nvidia') {
  if (provider !== 'nvidia') return true; // local catalogs only list what's actually loaded/pulled
  const s = String(id).toLowerCase();
  return !NON_CHAT.some((k) => s.includes(k));
}

// Families that generally handle the tool-calling loop Claude Code depends on.
// This is only a first guess for sorting: the catalog changes often and a family
// name is not a capability, so `probeTools` is what actually decides.
const TOOL_FAMILIES = [
  'nvidia/nemotron-3', 'nvidia/nvidia-nemotron', 'nvidia/llama-3.3-nemotron', 'nvidia/llama-3.1-nemotron',
  'openai/gpt-oss', 'z-ai/glm', 'zai-org/glm', 'moonshotai/kimi', 'minimaxai/minimax',
  'deepseek-ai/deepseek-v', 'qwen/qwen', 'meta/llama-3.3', 'meta/llama-4',
  'mistralai/mistral-large', 'mistralai/mistral-nemotron', 'mistralai/mixtral',
  'stepfun-ai/step', 'poolside/laguna', 'thinkingmachines/', 'writer/palmyra',
];

// Endpoints in those families that are not general chat models.
const NOT_AGENTIC = ['guard', 'reward', 'safety', 'parse', 'calibration', '-vl-', '-vl', 'detector'];

export function supportsTools(id, provider = 'nvidia') {
  if (provider !== 'nvidia') return false; // no catalog-vendor heuristic for local models; probeTools decides
  const s = String(id).toLowerCase();
  if (NOT_AGENTIC.some((k) => s.includes(k))) return false;
  return TOOL_FAMILIES.some((k) => s.startsWith(k));
}

/**
 * Asks the model to make one trivial tool call. This is the only reliable way to
 * know: NIM's /v1/models reports no capabilities, and it lists models the account
 * cannot even invoke. Works unmodified against any OpenAI-compatible endpoint.
 */
export async function probeTools(apiKey, model, baseUrl = nimBaseUrl(), { signal, timeoutMs = 60000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        model,
        max_tokens: 64,
        temperature: 0,
        messages: [{ role: 'user', content: 'Call the ping tool with value 1. Use the tool; do not answer in prose.' }],
        tools: [{
          type: 'function',
          function: {
            name: 'ping',
            description: 'Respond to a ping.',
            parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
          },
        }],
        tool_choice: 'auto',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (/Not found for account/.test(body)) {
        return { ok: false, reachable: false, reason: 'listed in the catalog but not enabled for this account' };
      }
      // A 5xx or a rate limit says nothing about the model itself, so the verdict
      // must not be remembered — the endpoint may be healthy a minute later.
      const transient = res.status >= 500 || res.status === 429;
      return { ok: false, reachable: false, transient, reason: `HTTP ${res.status}` };
    }
    const json = await res.json();
    const calls = json?.choices?.[0]?.message?.tool_calls;
    return { ok: Array.isArray(calls) && calls.length > 0, reachable: true, reason: 'answered in prose instead of calling the tool' };
  } catch (err) {
    // Network failures and timeouts are conditions of the moment, not verdicts.
    return {
      ok: false,
      reachable: false,
      transient: true,
      reason: err.name === 'AbortError' ? `no response within ${timeoutMs / 1000}s` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Ranks the picker so the models that actually survive an agentic session float up.
export function rankModels(models, { favorites = [], lastModel = null, toolChecks = {} } = {}) {
  const score = (m) => {
    let n = 0;
    if (m.id === lastModel) n += 1000;
    if (favorites.includes(m.id)) n += 500;
    const checked = toolChecks[m.id];
    if (checked?.ok) n += 200;
    else if (checked && !checked.ok) n -= 400;
    else if (supportsTools(m.id)) n += 100;
    if (/coder|code/.test(m.id)) n += 20;
    return n;
  };
  return [...models].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
}
