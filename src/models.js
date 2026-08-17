import { nimBaseUrl } from './config.js';

/**
 * build.nvidia.com's catalog is served verbatim by the NIM /v1/models endpoint,
 * so we read it from the API instead of scraping the site.
 */
export async function fetchModels(apiKey, { signal } = {}) {
  const res = await fetch(`${nimBaseUrl()}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NIM /models failed (${res.status} ${res.statusText}) ${body.slice(0, 300)}`);
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

export function isChatModel(id) {
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

export function supportsTools(id) {
  const s = String(id).toLowerCase();
  if (NOT_AGENTIC.some((k) => s.includes(k))) return false;
  return TOOL_FAMILIES.some((k) => s.startsWith(k));
}

/**
 * Asks the model to make one trivial tool call. This is the only reliable way to
 * know: NIM's /v1/models reports no capabilities, and it lists models the account
 * cannot even invoke.
 */
export async function probeTools(apiKey, model, { signal, timeoutMs = 60000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const res = await fetch(`${nimBaseUrl()}/chat/completions`, {
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
      const detail = /Not found for account/.test(body)
        ? 'listed in the catalog but not enabled for this account'
        : `HTTP ${res.status}`;
      return { ok: false, reachable: false, reason: detail };
    }
    const json = await res.json();
    const calls = json?.choices?.[0]?.message?.tool_calls;
    return { ok: Array.isArray(calls) && calls.length > 0, reachable: true, reason: 'answered in prose instead of calling the tool' };
  } catch (err) {
    return { ok: false, reachable: false, reason: err.name === 'AbortError' ? `no response within ${timeoutMs / 1000}s` : err.message };
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
