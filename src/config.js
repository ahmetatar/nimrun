import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/** Read at call time so an override applied after import still takes effect. */
export const nimBaseUrl = () => process.env.NIM_BASE_URL || DEFAULT_NIM_BASE_URL;
export const CONFIG_DIR = process.env.PALIMORPH_HOME || path.join(os.homedir(), '.palimorph');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const PROVIDERS = {
  nvidia: { label: 'NVIDIA NIM', defaultBaseUrl: DEFAULT_NIM_BASE_URL, requiresKey: true },
  lmstudio: { label: 'LM Studio', defaultBaseUrl: 'http://localhost:1234/v1', requiresKey: false },
  ollama: { label: 'Ollama', defaultBaseUrl: 'http://localhost:11434/v1', requiresKey: false },
  custom: { label: 'custom', defaultBaseUrl: null, requiresKey: false },
};

const DEFAULTS = {
  provider: 'nvidia',
  providers: {},
  apiKey: null,
  lastModel: null,
  favorites: [],
  smallModel: null,
  maxTokens: null,
  contextTokens: null,
  concurrency: null,
  toolChecks: {},
};

/** Namespaces per-model state by provider so local model ids can't collide with
 * NIM ids or each other. NVIDIA keeps its bare id so existing configs keep working. */
export function scopedKey(provider, id) {
  return provider === 'nvidia' ? id : `${provider}:${id}`;
}

/** Projects the scoped lastModel/favorites/toolChecks down to bare model ids for
 * one provider, so picker/ranking code never has to think about scoping. */
export function providerView(cfg, provider) {
  if (provider === 'nvidia') return cfg;
  const prefix = `${provider}:`;
  const strip = (k) => k.slice(prefix.length);
  const lastModel = cfg.lastModel?.startsWith(prefix) ? strip(cfg.lastModel) : null;
  const favorites = cfg.favorites.filter((f) => f.startsWith(prefix)).map(strip);
  const toolChecks = Object.fromEntries(
    Object.entries(cfg.toolChecks).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [strip(k), v])
  );
  return { ...cfg, lastModel, favorites, toolChecks };
}

export function resolveProvider(flags = {}, cfg = loadConfig()) {
  const id = flags.provider || cfg.provider || 'nvidia';
  if (!PROVIDERS[id]) throw new Error(`unknown provider: ${id} (expected one of ${Object.keys(PROVIDERS).join(', ')})`);
  return id;
}

export function resolveBaseUrl(provider, flags = {}, cfg = loadConfig()) {
  if (flags.baseUrl) return flags.baseUrl;
  const stored = cfg.providers?.[provider]?.baseUrl;
  if (stored) return stored;
  if (provider === 'nvidia' && process.env.NIM_BASE_URL) return process.env.NIM_BASE_URL;
  const fallback = PROVIDERS[provider].defaultBaseUrl;
  if (!fallback) throw new Error(`the "${provider}" provider needs a --base-url <url>`);
  return fallback;
}

export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/**
 * Resolution order: explicit env var wins, then the stored config.
 * Env-provided keys are never written to disk.
 * Providers that don't require a key (local servers) get a placeholder token —
 * the proxy always sends an Authorization header, and these servers ignore it.
 */
export function resolveApiKey(provider = 'nvidia', cfg = loadConfig()) {
  if (provider === 'nvidia') {
    return process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY || cfg.apiKey || null;
  }
  return cfg.providers?.[provider]?.apiKey || (PROVIDERS[provider]?.requiresKey ? null : 'not-needed');
}
