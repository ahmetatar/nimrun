import { loadConfig, saveConfig, resolveApiKey, CONFIG_FILE, NIM_BASE_URL } from './config.js';
import { fetchModels, isChatModel, supportsTools, rankModels } from './models.js';
import { select, prompt, color as c } from './picker.js';
import { runClaude } from './run.js';
import { createProxy, listen } from './proxy.js';

const HELP = `
${c.bold}nimrun${c.reset} — run Claude Code on any NVIDIA NIM model

${c.bold}USAGE${c.reset}
  nimrun [model] [options] [-- <claude args>]

${c.bold}COMMANDS${c.reset}
  nimrun                    pick a model interactively, then launch Claude Code
  nimrun <model-id>         launch straight into that model
  nimrun --last             reuse the last model you picked
  nimrun models             list available NIM models
  nimrun login              store your NVIDIA API key in ${CONFIG_FILE}
  nimrun logout             remove the stored key
  nimrun proxy              run only the translation proxy and print the env vars
  nimrun fav <model-id>     pin a model to the top of the picker

${c.bold}OPTIONS${c.reset}
  --small <model-id>   model for Claude Code's cheap background calls
  --max-tokens <n>     cap output tokens per response
  --all                include non-chat endpoints in the picker
  --tools-only         only show models known to handle tool calling
  --port <n>           fixed proxy port (default: an ephemeral one)
  --debug              log every proxied request to stderr
  --bin <path>         Claude Code executable (default: claude)
  -h, --help           this text

${c.bold}NOTES${c.reset}
  NIM speaks OpenAI, Claude Code speaks Anthropic. nimrun runs a loopback proxy
  that translates between them for the life of the session, passes it to a child
  process through env vars, and tears it down on exit — your Claude Code
  settings files are never modified.

  API key: NVIDIA_API_KEY env var, or 'nimrun login'.
  Get one at https://build.nvidia.com/
`;

export function parseArgs(argv) {
  const opts = { _: [], claudeArgs: [], flags: {} };
  const dashdash = argv.indexOf('--');
  const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
  if (dashdash !== -1) opts.claudeArgs = argv.slice(dashdash + 1);

  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '-h' || a === '--help') opts.flags.help = true;
    else if (a === '--last') opts.flags.last = true;
    else if (a === '--all') opts.flags.all = true;
    else if (a === '--tools-only') opts.flags.toolsOnly = true;
    else if (a === '--debug') opts.flags.debug = true;
    else if (a === '--small') opts.flags.small = own[++i];
    else if (a === '--max-tokens') opts.flags.maxTokens = Number.parseInt(own[++i], 10);
    else if (a === '--port') opts.flags.port = Number.parseInt(own[++i], 10);
    else if (a === '--bin') opts.flags.bin = own[++i];
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else opts._.push(a);
  }
  return opts;
}

function die(msg, code = 1) {
  process.stderr.write(`${c.yellow}✖${c.reset} ${msg}\n`);
  process.exit(code);
}

async function needKey() {
  const key = resolveApiKey();
  if (key) return key;
  die(
    `no NVIDIA API key found.\n` +
    `  Run ${c.bold}nimrun login${c.reset}, or set ${c.bold}NVIDIA_API_KEY${c.reset}.\n` +
    `  Keys come from https://build.nvidia.com/ (any model page → "Get API Key").`
  );
}

async function loadCatalog(key, flags) {
  process.stderr.write(`${c.dim}fetching NIM catalog…${c.reset}`);
  let models;
  try {
    models = await fetchModels(key);
  } catch (err) {
    process.stderr.write('\r\x1b[2K');
    die(`could not reach ${NIM_BASE_URL}: ${err.message}`);
  }
  process.stderr.write('\r\x1b[2K');
  let list = flags.all ? models : models.filter((m) => isChatModel(m.id));
  if (flags.toolsOnly) list = list.filter((m) => supportsTools(m.id));
  if (!list.length) die('no models matched. Try --all.');
  return list;
}

const renderModel = (favorites, lastModel) => (m) => {
  const tags = [];
  if (m.id === lastModel) tags.push(`${c.cyan}last${c.reset}`);
  if (favorites.includes(m.id)) tags.push(`${c.yellow}★${c.reset}`);
  if (supportsTools(m.id)) tags.push(`${c.green}tools${c.reset}`);
  const suffix = tags.length ? ` ${c.dim}[${c.reset}${tags.join(c.dim + '·' + c.reset)}${c.dim}]${c.reset}` : '';
  return { display: `${m.id}${suffix}`, plain: `${m.id} ${m.owner}` };
};

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    die(err.message);
  }
  const { flags, claudeArgs } = opts;
  if (flags.help) { process.stdout.write(HELP); return 0; }

  const cfg = loadConfig();
  const cmd = opts._[0];

  if (cmd === 'login') {
    const key = await prompt('NVIDIA API key (nvapi-…): ', { silent: true });
    if (!key.startsWith('nvapi-')) process.stderr.write(`${c.dim}note: NVIDIA keys usually start with "nvapi-".${c.reset}\n`);
    if (!key) die('no key entered.');
    saveConfig({ apiKey: key });
    process.stderr.write(`${c.green}✔${c.reset} key saved to ${CONFIG_FILE} (0600)\n`);
    return 0;
  }

  if (cmd === 'logout') {
    saveConfig({ apiKey: null });
    process.stderr.write(`${c.green}✔${c.reset} stored key removed\n`);
    return 0;
  }

  if (cmd === 'models') {
    const key = await needKey();
    const list = await loadCatalog(key, flags);
    for (const m of rankModels(list, cfg)) {
      process.stdout.write(`${m.id}${supportsTools(m.id) ? '\t[tools]' : ''}\n`);
    }
    return 0;
  }

  if (cmd === 'fav') {
    const id = opts._[1];
    if (!id) die('usage: nimrun fav <model-id>');
    const favorites = cfg.favorites.includes(id)
      ? cfg.favorites.filter((f) => f !== id)
      : [...cfg.favorites, id];
    saveConfig({ favorites });
    process.stderr.write(`${c.green}✔${c.reset} ${favorites.includes(id) ? 'pinned' : 'unpinned'} ${id}\n`);
    return 0;
  }

  // --- resolve which model to run ---
  const key = await needKey();
  let model = cmd && cmd !== 'proxy' ? cmd : null;
  if (!model && flags.last) {
    model = cfg.lastModel;
    if (!model) die('no previous model recorded yet.');
  }
  if (!model) {
    const list = rankModels(await loadCatalog(key, flags), cfg);
    let chosen;
    try {
      chosen = await select({
        items: list,
        label: 'NVIDIA NIM model',
        render: renderModel(cfg.favorites, cfg.lastModel),
      });
    } catch {
      process.stderr.write(`${c.dim}cancelled${c.reset}\n`);
      return 130;
    }
    model = chosen.id;
  }

  const smallModel = flags.small || cfg.smallModel || model;
  const maxTokens = flags.maxTokens || cfg.maxTokens || null;
  saveConfig({ lastModel: model });

  if (cmd === 'proxy') {
    const server = createProxy({ apiKey: key, model, smallModel, maxTokens, token: null, debug: flags.debug });
    const port = await listen(server, { port: flags.port || 0 });
    process.stdout.write(
      `export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\n` +
      `export ANTHROPIC_AUTH_TOKEN=nimrun\n` +
      `export ANTHROPIC_MODEL=${model}\n` +
      `export ANTHROPIC_SMALL_FAST_MODEL=${smallModel}\n`
    );
    process.stderr.write(`\n${c.green}●${c.reset} proxy on :${port} → ${model} ${c.dim}(ctrl-c to stop)${c.reset}\n`);
    await new Promise(() => {});
    return 0;
  }

  if (!supportsTools(model)) {
    process.stderr.write(
      `${c.yellow}!${c.reset} ${model} is not in the known tool-calling list — Claude Code may not\n` +
      `  be able to edit files with it. Use ${c.bold}--tools-only${c.reset} to filter the picker.\n`
    );
  }

  return runClaude({
    apiKey: key, model, smallModel, maxTokens,
    claudeArgs, debug: flags.debug, bin: flags.bin || 'claude', port: flags.port,
  });
}
