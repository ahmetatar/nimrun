import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/** Read at call time so an override applied after import still takes effect. */
export const nimBaseUrl = () => process.env.NIM_BASE_URL || DEFAULT_NIM_BASE_URL;
export const CONFIG_DIR = process.env.NIMRUN_HOME || path.join(os.homedir(), '.nimrun');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  apiKey: null,
  lastModel: null,
  favorites: [],
  smallModel: null,
  maxTokens: null,
  contextTokens: null,
  toolChecks: {},
};

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
 */
export function resolveApiKey(cfg = loadConfig()) {
  return process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY || cfg.apiKey || null;
}
