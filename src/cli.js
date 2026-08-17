import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, resolveApiKey, CONFIG_FILE, nimBaseUrl } from './config.js';
import { fetchModels, isChatModel, supportsTools, probeTools, rankModels } from './models.js';
import { select, prompt, highlight } from './picker.js';
import { runClaude } from './run.js';
import { createProxy, listen } from './proxy.js';
import * as ui from './ui.js';

const { glyph: g } = ui;
const VERSION = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
).version;

function help() {
  const b = ui.bold;
  const k = (s) => ui.green(s);
  const d = ui.faint;
  return `
${ui.gradient('nimrun', [ui.GREEN, ui.GLOW])} ${d(g.dot)} ${ui.slate('run Claude Code on any NVIDIA NIM model')}

${b('USAGE')}
  ${k('nimrun')} [model] [options] ${d('[-- <claude args>]')}

${b('COMMANDS')}
  ${k('nimrun')}                    ${d('pick a model, then launch Claude Code')}
  ${k('nimrun')} <model-id>         ${d('launch straight into that model')}
  ${k('nimrun')} --last             ${d('reuse the last model you picked')}
  ${k('nimrun')} models             ${d('list available NIM models')}
  ${k('nimrun')} login              ${d('paste and store your NVIDIA API key')}
  ${k('nimrun')} logout             ${d('remove the stored key')}
  ${k('nimrun')} status             ${d('show key, last model, and connectivity')}
  ${k('nimrun')} proxy              ${d('run only the translation proxy')}
  ${k('nimrun')} check <model-id>   ${d('probe whether a model really makes tool calls')}
  ${k('nimrun')} fav <model-id>     ${d('pin a model to the top of the picker')}

${b('OPTIONS')}
  ${k('--small')} <model-id>   ${d("model for Claude Code's cheap background calls")}
  ${k('--max-tokens')} <n>     ${d('cap output tokens per response')}
  ${k('--context')} <n>        ${d("the model's real context window (Claude Code assumes 200k)")}
  ${k('--tools-only')}         ${d('only show models known to handle tool calling')}
  ${k('--all')}                ${d('include non-chat endpoints in the picker')}
  ${k('--port')} <n>           ${d('fixed proxy port (default: ephemeral)')}
  ${k('--debug')}              ${d('log every proxied request to stderr')}
  ${k('--bin')} <path>         ${d('Claude Code executable (default: claude)')}
  ${k('-h, --help')}           ${d('this text')}

${b('HOW IT WORKS')}
  ${d('NIM speaks OpenAI; Claude Code speaks Anthropic. nimrun runs a loopback')}
  ${d('proxy that translates between them, hands it to a child process through')}
  ${d('env vars, and tears it down on exit — your settings files are untouched.')}

  ${d('Key:')} ${ui.cyan('NVIDIA_API_KEY')} ${d('or')} ${ui.cyan('nimrun login')} ${d(`${g.dot} get one at https://build.nvidia.com/`)}
`;
}

export function parseArgs(argv) {
  const opts = { _: [], claudeArgs: [], flags: {} };
  const dashdash = argv.indexOf('--');
  const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
  if (dashdash !== -1) opts.claudeArgs = argv.slice(dashdash + 1);

  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '-h' || a === '--help') opts.flags.help = true;
    else if (a === '-v' || a === '--version') opts.flags.version = true;
    else if (a === '--last') opts.flags.last = true;
    else if (a === '--all') opts.flags.all = true;
    else if (a === '--tools-only') opts.flags.toolsOnly = true;
    else if (a === '--debug') opts.flags.debug = true;
    else if (a === '--no-banner') opts.flags.noBanner = true;
    else if (a === '--small') opts.flags.small = own[++i];
    else if (a === '--max-tokens') opts.flags.maxTokens = Number.parseInt(own[++i], 10);
    else if (a === '--context') opts.flags.context = Number.parseInt(own[++i], 10);
    else if (a === '--port') opts.flags.port = Number.parseInt(own[++i], 10);
    else if (a === '--bin') opts.flags.bin = own[++i];
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else opts._.push(a);
  }
  return opts;
}

function die(msg, code = 1) {
  ui.write('\n' + ui.fail(msg) + '\n');
  process.exit(code);
}

function needKey() {
  const key = resolveApiKey();
  if (key) return key;
  die(
    `${ui.bold('No NVIDIA API key found.')}\n\n` +
    `  ${ui.green(g.arrow)} run ${ui.bold('nimrun login')} and paste your key, or\n` +
    `  ${ui.green(g.arrow)} export ${ui.bold('NVIDIA_API_KEY=nvapi-…')}\n\n` +
    `  ${ui.faint('Sign in at https://build.nvidia.com/, open any model,')}\n` +
    `  ${ui.faint('and use "Get API Key" — it starts with nvapi-.')}`
  );
}

async function loadCatalog(key, flags) {
  const spin = ui.spinner('reading the NIM catalog…');
  let models;
  try {
    models = await fetchModels(key);
  } catch (err) {
    spin.fail(`could not reach ${nimBaseUrl()}`);
    die(err.message);
  }
  let list = flags.all ? models : models.filter((m) => isChatModel(m.id));
  if (flags.toolsOnly) {
    const checks = loadConfig().toolChecks;
    list = list.filter((m) => (checks[m.id] ? checks[m.id].ok : supportsTools(m.id)));
  }
  spin.stop();
  if (!list.length) die('no models matched those filters. Try --all.');
  return list;
}

const VENDOR_W = 12;

/** One catalog row: vendor column, model name, then capability badges. */
function makeRenderer(cfg) {
  return (m, { query = '', active = false } = {}) => {
    const [vendor, rest] = m.id.includes('/') ? [m.id.split('/')[0], m.id.slice(m.id.indexOf('/') + 1)] : ['nvidia', m.id];
    const vendorCell = ui.pad(ui.truncate(vendor, VENDOR_W), VENDOR_W);
    const name = highlight(rest, query);

    const badges = [];
    if (m.id === cfg.lastModel) badges.push(ui.cyan('last'));
    if (cfg.favorites.includes(m.id)) badges.push(ui.amber(g.star));
    const checked = cfg.toolChecks[m.id];
    if (checked?.ok) badges.push(ui.fg(ui.GREEN, ui.bold('tools')));
    else if (checked) badges.push(ui.red('no tools'));
    else if (supportsTools(m.id)) badges.push(ui.fg(ui.GREEN, 'tools?'));

    const label = active ? ui.bold(name) : name;
    const tail = badges.length ? `  ${ui.faint('[')}${badges.join(ui.faint('·'))}${ui.faint(']')}` : '';
    return {
      display: `${ui.faint(vendorCell)}  ${active ? ui.fg(ui.GLOW, '') : ''}${label}${tail}`,
      plain: m.id,
    };
  };
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    die(err.message);
  }
  const { flags, claudeArgs } = opts;

  if (flags.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  if (flags.help) { ui.write(help()); return 0; }

  const cfg = loadConfig();
  const cmd = opts._[0];
  const quiet = flags.noBanner || cmd === 'models';

  if (!quiet) ui.hero({ version: VERSION });

  if (cmd === 'login') {
    ui.write(
      `  ${ui.slate('Paste the API key from')} ${ui.cyan('https://build.nvidia.com/')}${ui.slate('.')}\n` +
      `  ${ui.faint('Open any model page → "Get API Key". No browser sign-in happens here.')}\n\n`
    );
    const key = await prompt(`  ${ui.green(g.arrow)} key ${ui.faint('(hidden)')}: `, { silent: true });
    if (!key) die('nothing entered.');
    if (!key.startsWith('nvapi-')) ui.write(ui.warn(ui.faint('that does not look like an nvapi- key — saving it anyway')));
    saveConfig({ apiKey: key });
    ui.write('\n' + ui.ok(`saved to ${ui.bold(CONFIG_FILE)} ${ui.faint('(mode 0600)')}`));
    ui.write(ui.note(`run ${ui.bold('nimrun')} to pick a model\n`));
    return 0;
  }

  if (cmd === 'logout') {
    saveConfig({ apiKey: null });
    ui.write(ui.ok('stored key removed\n'));
    return 0;
  }

  if (cmd === 'status') {
    const envKey = process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY;
    const key = resolveApiKey(cfg);
    const source = envKey ? 'NVIDIA_API_KEY (env)' : cfg.apiKey ? CONFIG_FILE : ui.red('not set');
    let reach = ui.faint('not checked');
    if (key) {
      const spin = ui.spinner('checking NIM…');
      try {
        const models = await fetchModels(key);
        spin.stop();
        reach = ui.fg(ui.GREEN, `ok ${g.dot} ${models.length} models`);
      } catch (err) {
        spin.stop();
        reach = ui.red(err.message.slice(0, 60));
      }
    }
    ui.write(ui.card([
      ['key', key ? `${ui.faint(key.slice(0, 9))}${'•'.repeat(8)} ${ui.faint(g.dot)} ${source}` : source],
      ['endpoint', nimBaseUrl()],
      ['reachable', reach],
      ['last model', cfg.lastModel || ui.faint('none yet')],
      ['favorites', cfg.favorites.length ? cfg.favorites.join(', ') : ui.faint('none')],
    ], { title: 'nimrun status' }) + '\n');
    return 0;
  }

  if (cmd === 'models') {
    const key = needKey();
    const list = await loadCatalog(key, flags);
    for (const m of rankModels(list, cfg)) {
      process.stdout.write(`${m.id}${supportsTools(m.id) ? '\t[tools]' : ''}\n`);
    }
    return 0;
  }

  if (cmd === 'check') {
    const id = opts._[1] || cfg.lastModel;
    if (!id) die('usage: nimrun check <model-id>');
    const key = needKey();
    const spin = ui.spinner(`asking ${id} to make a tool call…`);
    const verdict = await probeTools(key, id);
    spin.stop();
    saveConfig({ toolChecks: { ...cfg.toolChecks, [id]: verdict } });
    ui.write(verdict.ok
      ? ui.ok(`${ui.bold(id)} makes tool calls ${ui.faint('— usable with Claude Code')}\n`)
      : ui.warn(`${ui.bold(id)} did not make a tool call: ${verdict.reason}\n`));
    return verdict.ok ? 0 : 1;
  }

  if (cmd === 'fav') {
    const id = opts._[1];
    if (!id) die('usage: nimrun fav <model-id>');
    const on = !cfg.favorites.includes(id);
    saveConfig({ favorites: on ? [...cfg.favorites, id] : cfg.favorites.filter((f) => f !== id) });
    ui.write(ui.ok(`${on ? 'pinned' : 'unpinned'} ${ui.bold(id)}\n`));
    return 0;
  }

  // --- resolve which model to run ---
  const key = needKey();
  let model = cmd && cmd !== 'proxy' ? cmd : null;
  if (!model && flags.last) {
    model = cfg.lastModel;
    if (!model) die('no previous model recorded yet — run nimrun and pick one.');
  }
  if (!model) {
    const list = rankModels(await loadCatalog(key, flags), cfg);
    try {
      const chosen = await select({
        items: list,
        label: 'NVIDIA NIM',
        hint: `${ui.fg(ui.GREEN, ui.bold('tools'))} = verified ${g.dot} ${ui.fg(ui.GREEN, 'tools?')} = likely ${g.dot} ${ui.amber(g.star)} = pinned`,
        render: makeRenderer(cfg),
      });
      model = chosen.id;
    } catch {
      ui.write(ui.note('cancelled\n'));
      return 130;
    }
  }

  const smallModel = flags.small || cfg.smallModel || model;
  const maxTokens = flags.maxTokens || cfg.maxTokens || null;
  const contextTokens = flags.context || cfg.contextTokens || null;
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
    ui.write(ui.card([
      ['listening', `127.0.0.1:${port}`],
      ['model', model],
      ['mode', `anthropic ${g.swap} openai`],
    ], { title: 'proxy' }));
    ui.write(ui.note(`eval the lines above in your shell ${g.dot} ctrl-c to stop\n`));
    await new Promise(() => {});
    return 0;
  }

  // Claude Code is useless without tool calls, and a family name does not prove
  // support — so the first time a model is used, ask it to make one.
  let verdict = cfg.toolChecks[model];
  if (!verdict) {
    const spin = ui.spinner(`checking whether ${model} makes tool calls…`);
    verdict = await probeTools(key, model);
    spin.stop();
    saveConfig({ toolChecks: { ...loadConfig().toolChecks, [model]: verdict } });
  }
  if (!verdict.ok) {
    ui.write(ui.warn(
      `${ui.bold(model)} did not make a tool call when asked: ${verdict.reason}.\n` +
      `  ${ui.faint('Claude Code needs tool calls to read and edit files, so it will likely')}\n` +
      `  ${ui.faint('be unable to do real work with this model. Re-check with')} ${ui.cyan(`nimrun check ${model}`)}${ui.faint('.')}\n`
    ));
  }

  return runClaude({
    apiKey: key, model, smallModel, maxTokens,
    claudeArgs, debug: flags.debug, bin: flags.bin || 'claude', port: flags.port, contextTokens,
  });
}
