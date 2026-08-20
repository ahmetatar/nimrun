/**
 * Regenerates docs/media/*.svg from the real CLI output.
 * Nothing here is hand-written terminal art: every frame is captured from the
 * actual ui/picker/run code paths with a faked TTY, so the images cannot drift
 * away from what the CLI prints.
 *
 *   node tools/screenshots.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSvg } from './ansi-svg.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'docs', 'media');
fs.mkdirSync(OUT, { recursive: true });

process.env.FORCE_COLOR = '3';
process.env.COLORTERM = 'truecolor';
process.stdin.isTTY = true;
process.stdin.setRawMode = () => {};
process.stderr.isTTY = true;
process.stderr.columns = 96;
process.stderr.rows = 30;

// --- capture harness ----------------------------------------------------
const realWrite = process.stderr.write.bind(process.stderr);
let buf = '';
process.stderr.write = (s) => { buf += s; return true; };
const take = () => { const v = buf; buf = ''; return v; };

// Frames are painted in place with cursor moves; keep the text, drop the motion.
const flatten = (s) => s.replace(/\x1b\[\?25[lh]/g, '').replace(/\x1b\[\d*[AB]/g, '').replace(/\x1b\[2K/g, '').replace(/\r/g, '');

const written = [];
function emit(name, ansi, title) {
  const file = path.join(OUT, `${name}.svg`);
  fs.writeFileSync(file, toSvg(flatten(ansi), { title }));
  written.push(path.relative(ROOT, file));
}

const ui = await import('../src/ui.js');
const { select, highlight } = await import('../src/picker.js');
const { supportsTools, rankModels } = await import('../src/models.js');
const g = ui.glyph;

// --- a representative slice of the real NIM catalog ---------------------
const CATALOG = [
  'nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-nano-30b-a3b',
  'z-ai/glm-5.2', 'moonshotai/kimi-k2.6', 'minimaxai/minimax-m3', 'openai/gpt-oss-120b',
  'meta/llama-3.3-70b-instruct', 'meta/llama-3.1-8b-instruct', 'deepseek-ai/deepseek-v4-flash-0731',
  'mistralai/mistral-large-2-instruct', 'poolside/laguna-xs-2.1', 'stepfun-ai/step-3.7-flash',
  'google/gemma-3-12b-it', 'ibm/granite-3.0-8b-instruct', 'microsoft/phi-3.5-moe-instruct',
].map((id) => ({ id, owner: id.split('/')[0] }));

// verdicts as `palimorph check` actually returned them against the live catalog
const cfg = {
  favorites: ['z-ai/glm-5.2'],
  lastModel: 'nvidia/nemotron-3-super-120b-a12b',
  toolChecks: {
    'nvidia/nemotron-3-super-120b-a12b': { ok: true },
    'meta/llama-3.1-8b-instruct': { ok: true },
    'z-ai/glm-5.2': { ok: true },
    'moonshotai/kimi-k2.6': { ok: false, reason: 'not enabled for this account' },
  },
};
const items = rankModels(CATALOG, cfg);

// same renderer the CLI uses
const VENDOR_W = 12;
const render = (m, { query = '', active = false } = {}) => {
  const vendor = m.id.split('/')[0];
  const rest = m.id.slice(m.id.indexOf('/') + 1);
  const badges = [];
  if (m.id === cfg.lastModel) badges.push(ui.cyan('last'));
  if (cfg.favorites.includes(m.id)) badges.push(ui.amber(g.star));
  const checked = cfg.toolChecks[m.id];
  if (checked?.ok) badges.push(ui.fg(ui.GREEN, ui.bold('tools')));
  else if (checked) badges.push(ui.red('no tools'));
  else if (supportsTools(m.id)) badges.push(ui.fg(ui.GREEN, 'tools?'));
  const name = highlight(rest, query);
  const tail = badges.length ? `  ${ui.faint('[')}${badges.join(ui.faint('·'))}${ui.faint(']')}` : '';
  return { display: `${ui.faint(ui.pad(ui.truncate(vendor, VENDOR_W), VENDOR_W))}  ${active ? ui.bold(name) : name}${tail}`, plain: m.id };
};

// --- 1. hero + picker ---------------------------------------------------
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
take();
ui.hero({ version: VERSION, force: true });
const heroFrame = take();

const pick = select({
  items,
  label: 'NVIDIA NIM',
  hint: `${ui.fg(ui.GREEN, ui.bold('tools'))} = verified ${g.dot} ${ui.fg(ui.GREEN, 'tools?')} = likely ${g.dot} ${ui.amber(g.star)} = pinned`,
  render,
});
emit('hero', heroFrame + take(), 'palimorph');

// --- 2. picker mid-filter ----------------------------------------------
for (const ch of 'nemotron') process.stdin.emit('keypress', ch, { name: ch });
take();
process.stdin.emit('keypress', null, { name: 'down' });
emit('picker', take(), 'palimorph — model picker');
process.stdin.emit('keypress', null, { name: 'escape' });
await pick.catch(() => {});

// --- 3. a real session, start to finish ---------------------------------
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'c1',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 18432, completion_tokens: 2140 },
  }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
process.env.NIM_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;

// The stand-in is genuinely installed as an executable named `claude` on a
// temp PATH, so the banner prints the real command name rather than a stub path.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palimorph-shot-'));
const stub = path.join(stubDir, 'claude');
fs.writeFileSync(stub, [
  '#!/usr/bin/env node',
  '// stand-in for Claude Code: speaks Anthropic to whatever ANTHROPIC_BASE_URL says',
  'for (let i = 0; i < 3; i++) {',
  "  await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {",
  "    method: 'POST',",
  "    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_AUTH_TOKEN },",
  "    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),",
  '  });',
  '}',
].join('\n'));
fs.chmodSync(stub, 0o755);
process.env.PATH = `${stubDir}:${process.env.PATH}`;

const { runClaude } = await import('../src/run.js');
take();
await runClaude({
  apiKey: 'nvapi-demo',
  model: 'nvidia/nemotron-3-super-120b-a12b',
  smallModel: 'meta/llama-3.1-8b-instruct',
  claudeArgs: [],
  bin: 'claude',
});
const session = take();
fs.rmSync(stubDir, { recursive: true, force: true });
upstream.close();

const [launch, ended] = [
  session.slice(0, session.indexOf('\n\n', session.indexOf('starting'))),
  session.slice(session.indexOf('╭', session.indexOf('starting'))),
];
emit('session', launch, 'palimorph — launching');
emit('session-end', ended, 'palimorph — on exit');

// --- 4. help ------------------------------------------------------------
const { main } = await import('../src/cli.js');
take();
await main(['--help']);
emit('help', take(), 'palimorph --help');

process.stderr.write = realWrite;
realWrite(`wrote:\n${written.map((f) => `  ${f}\n`).join('')}`);
