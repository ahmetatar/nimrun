import { NIM_BASE_URL } from './config.js';

/**
 * build.nvidia.com's catalog is served verbatim by the NIM /v1/models endpoint,
 * so we read it from the API instead of scraping the site.
 */
export async function fetchModels(apiKey, { signal } = {}) {
  const res = await fetch(`${NIM_BASE_URL}/models`, {
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

// Families that are known to handle the tool-calling loop Claude Code depends on.
const TOOL_FAMILIES = [
  'moonshotai/kimi', 'deepseek-ai/deepseek-v3', 'deepseek-ai/deepseek-r1',
  'qwen/qwen3', 'qwen/qwen2.5', 'meta/llama-3.3', 'meta/llama-4',
  'nvidia/llama-3.3-nemotron', 'nvidia/llama-3.1-nemotron', 'mistralai/mistral-large',
  'mistralai/mixtral', 'openai/gpt-oss', 'zai-org/glm', 'writer/palmyra',
  'nvidia/nvidia-nemotron', 'google/gemma-3',
];

export function supportsTools(id) {
  const s = String(id).toLowerCase();
  return TOOL_FAMILIES.some((k) => s.startsWith(k));
}

// Ranks the picker so the models that actually survive an agentic session float up.
export function rankModels(models, { favorites = [], lastModel = null } = {}) {
  const score = (m) => {
    let n = 0;
    if (m.id === lastModel) n += 1000;
    if (favorites.includes(m.id)) n += 500;
    if (supportsTools(m.id)) n += 100;
    if (/coder|code/.test(m.id)) n += 20;
    return n;
  };
  return [...models].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
}
