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
  'qwen/qwen3-coder-480b-a35b-instruct', 'moonshotai/kimi-k2-instruct', 'deepseek-ai/deepseek-v3',
  'meta/llama-3.3-70b-instruct', 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'mistralai/codestral-22b-v0.1',
  'qwen/qwen2.5-coder-32b-instruct', 'openai/gpt-oss-120b', 'zai-org/glm-4.5-air', 'google/gemma-3-27b-it',
  'meta/llama-4-maverick-17b-128e-instruct', 'writer/palmyra-creative-122b', 'microsoft/phi-4-mini-instruct',
  'ibm/granite-3.0-8b-instruct', 'nvidia/nemotron-4-340b-instruct', 'ai21/jamba-1.5-large-instruct',
].map((id) => ({ id, owner: id.split('/')[0] }));

const cfg = { favorites: ['moonshotai/kimi-k2-instruct'], lastModel: 'qwen/qwen3-coder-480b-a35b-instruct' };
const items = rankModels(CATALOG, cfg);

// same renderer the CLI uses
const VENDOR_W = 12;
const render = (m, { query = '', active = false } = {}) => {
  const vendor = m.id.split('/')[0];
  const rest = m.id.slice(m.id.indexOf('/') + 1);
  const badges = [];
  if (m.id === cfg.lastModel) badges.push(ui.cyan('last'));
  if (cfg.favorites.includes(m.id)) badges.push(ui.amber(g.star));
  if (supportsTools(m.id)) badges.push(ui.fg(ui.GREEN, 'tools'));
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
  hint: `${ui.fg(ui.GREEN, 'tools')} = known tool-calling ${g.dot} ${ui.amber(g.star)} = pinned`,
  render,
});
emit('hero', heroFrame + take(), 'nimrun');

// --- 2. picker mid-filter ----------------------------------------------
for (const ch of 'coder') process.stdin.emit('keypress', ch, { name: ch });
take();
process.stdin.emit('keypress', null, { name: 'down' });
emit('picker', take(), 'nimrun — model picker');
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
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimrun-shot-'));
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
  model: 'qwen/qwen3-coder-480b-a35b-instruct',
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
emit('session', launch, 'nimrun — launching');
emit('session-end', ended, 'nimrun — on exit');

// --- 4. help ------------------------------------------------------------
const { main } = await import('../src/cli.js');
take();
await main(['--help']);
emit('help', take(), 'nimrun --help');

process.stderr.write = realWrite;
realWrite(`wrote:\n${written.map((f) => `  ${f}\n`).join('')}`);
