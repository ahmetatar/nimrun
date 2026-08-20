/**
 * Terminal presentation layer. Degrades in one direction only: truecolor →
 * 256 → 16 → plain, and hero → compact → nothing, driven by what the terminal
 * actually reports. Nothing here writes to stdout, so piped output stays clean.
 */

const env = process.env;

function detectColorDepth() {
  if (env.NO_COLOR !== undefined || env.PALIMORPH_NO_COLOR) return 0;
  if (env.FORCE_COLOR === '0') return 0;
  if (env.FORCE_COLOR === '3') return 3;
  if (env.FORCE_COLOR) return 2;
  if (!process.stderr.isTTY) return 0;
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 3;
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty') return 3;
  if (/-256(color)?$/i.test(env.TERM || '')) return 2;
  if (env.TERM === 'dumb') return 0;
  return 1;
}

export const depth = detectColorDepth();
export const isTTY = Boolean(process.stderr.isTTY);
export const columns = () => process.stderr.columns || 80;
export const unicode = !/^(1|true)$/i.test(env.PALIMORPH_ASCII || '') &&
  (process.platform !== 'win32' || Boolean(env.WT_SESSION));

const ESC = '\x1b[';
export const RESET = depth ? `${ESC}0m` : '';

const wrap = (open, close, text) => (depth ? `${ESC}${open}m${text}${ESC}${close}m` : text);
export const bold = (t) => wrap(1, 22, t);
export const dim = (t) => wrap(2, 22, t);
export const italic = (t) => wrap(3, 23, t);
export const underline = (t) => wrap(4, 24, t);
export const inverse = (t) => wrap(7, 27, t);

/** Nearest xterm-256 index, for terminals without truecolor. */
function to256(r, g, b) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function to16(r, g, b) {
  const bright = Math.max(r, g, b) > 170 ? 60 : 0;
  const code = (r > 110 ? 1 : 0) | (g > 110 ? 2 : 0) | (b > 110 ? 4 : 0);
  return 30 + code + bright;
}

export function fg(rgb, text) {
  if (!depth) return text;
  const [r, g, b] = rgb;
  if (depth >= 3) return `${ESC}38;2;${r};${g};${b}m${text}${ESC}39m`;
  if (depth === 2) return `${ESC}38;5;${to256(r, g, b)}m${text}${ESC}39m`;
  return `${ESC}${to16(r, g, b)}m${text}${ESC}39m`;
}

export function bg(rgb, text) {
  if (!depth) return text;
  const [r, g, b] = rgb;
  if (depth >= 3) return `${ESC}48;2;${r};${g};${b}m${text}${ESC}49m`;
  if (depth === 2) return `${ESC}48;5;${to256(r, g, b)}m${text}${ESC}49m`;
  return `${ESC}${to16(r, g, b) + 10}m${text}${ESC}49m`;
}

// NVIDIA green, pushed into a glow at the right edge.
export const GREEN = [118, 185, 0];
export const LIME = [164, 224, 47];
export const GLOW = [200, 255, 120];
export const DEEP = [64, 104, 0];
export const SLATE = [128, 138, 150];
export const FAINT = [88, 96, 106];
export const AMBER = [232, 168, 40];
export const RED = [226, 96, 82];
export const CYAN = [86, 200, 220];

export const green = (t) => fg(GREEN, t);
export const slate = (t) => fg(SLATE, t);
export const faint = (t) => fg(FAINT, t);
export const amber = (t) => fg(AMBER, t);
export const red = (t) => fg(RED, t);
export const cyan = (t) => fg(CYAN, t);

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function sample(stops, t) {
  const span = 1 / (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t / span));
  const local = (t - i * span) / span;
  return [0, 1, 2].map((c) => lerp(stops[i][c], stops[i + 1][c], local));
}

/** Left-to-right colour ramp, emitting an escape only when the colour changes. */
export function gradient(text, stops = [DEEP, GREEN, GLOW], { offset = 0, total } = {}) {
  if (!depth) return text;
  const chars = [...text];
  const width = total ?? chars.length;
  let out = '';
  let last = null;
  for (let i = 0; i < chars.length; i++) {
    const t = width <= 1 ? 0 : Math.min(1, (i + offset) / (width - 1));
    const rgb = sample(stops, t);
    const key = rgb.join(',');
    if (key !== last) {
      out += depth >= 3 ? `${ESC}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
        : depth === 2 ? `${ESC}38;5;${to256(...rgb)}m`
        : `${ESC}${to16(...rgb)}m`;
      last = key;
    }
    out += chars[i];
  }
  return out + `${ESC}39m`;
}

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
export const width = (s) => [...stripAnsi(s)].length;

export function truncate(s, max) {
  if (width(s) <= max) return s;
  if (max <= 1) return '…';
  // Walk the string keeping escapes intact but counting only visible cells.
  let out = '';
  let visible = 0;
  const re = /(\x1b\[[0-9;]*[a-zA-Z])|([\s\S])/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) { out += m[1]; continue; }
    if (visible >= max - 1) break;
    out += m[2];
    visible += 1;
  }
  return out + RESET + '…';
}

export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

const G = unicode
  ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', dot: '·', arrow: '❯', check: '✔', cross: '✖', warn: '▲', bullet: '●', thumb: '▐', track: '│', star: '★', up: '↑', down: '↓', enter: '⏎', swap: '⇄' }
  : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', dot: '.', arrow: '>', check: 'v', cross: 'x', warn: '!', bullet: '*', thumb: '|', track: ':', star: '*', up: '^', down: 'v', enter: 'enter', swap: '<->' };
export const glyph = G;

export function write(s) {
  process.stderr.write(s);
}

// --- hero ---------------------------------------------------------------

const WORDMARK = [
  '██████╗  █████╗ ██╗     ██╗███╗   ███╗ ██████╗ ██████╗ ██████╗ ██╗  ██╗',
  '██╔══██╗██╔══██╗██║     ██║████╗ ████║██╔═══██╗██╔══██╗██╔══██╗██║  ██║',
  '██████╔╝███████║██║     ██║██╔████╔██║██║   ██║██████╔╝██████╔╝███████║',
  '██╔═══╝ ██╔══██║██║     ██║██║╚██╔╝██║██║   ██║██╔══██╗██╔═══╝ ██╔══██║',
  '██║     ██║  ██║███████╗██║██║ ╚═╝ ██║╚██████╔╝██║  ██║██║     ██║  ██║',
  '╚═╝     ╚═╝  ╚═╝╚══════╝╚═╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝',
];
const MARK_WIDTH = 71;

export function hero({ version = '', force = false } = {}) {
  if (!force && (!isTTY || env.PALIMORPH_NO_BANNER)) return;
  const cols = columns();
  const tag = `Claude Code ${glyph.dot} any NVIDIA NIM, LM Studio, or Ollama model`;

  if (cols < MARK_WIDTH + 4 || !unicode) {
    write(`\n  ${gradient('palimorph', [GREEN, GLOW])} ${dim(glyph.dot)} ${slate(tag)}\n\n`);
    return;
  }

  write('\n');
  for (const line of WORDMARK) {
    write(`  ${gradient(line, [DEEP, GREEN, GLOW], { total: MARK_WIDTH })}\n`);
  }
  const meta = version ? `${slate(tag)}  ${faint(`v${version}`)}` : slate(tag);
  write(`  ${meta}\n`);
  write(`  ${gradient(glyph.h.repeat(MARK_WIDTH), [DEEP, GREEN, DEEP])}\n\n`);
}

// --- boxes and rows -----------------------------------------------------

export function card(rows, { title = '', accent = GREEN, indent = 2 } = {}) {
  const labelW = Math.max(...rows.map(([k]) => width(k)));
  const inner = Math.max(
    width(title) + 2,
    ...rows.map(([k, v]) => labelW + 2 + width(v))
  );
  const maxInner = Math.max(20, columns() - indent * 2 - 4);
  const w = Math.min(inner, maxInner);
  const sp = ' '.repeat(indent);
  const line = (l, r) => fg(accent, l + glyph.h.repeat(w + 2) + r);

  let out = '\n';
  if (title) {
    const head = ` ${bold(title)} `;
    const fill = Math.max(0, w + 2 - width(head));
    out += `${sp}${fg(accent, glyph.tl + glyph.h)}${head}${fg(accent, glyph.h.repeat(Math.max(0, fill - 1)) + glyph.tr)}\n`;
  } else {
    out += `${sp}${line(glyph.tl, glyph.tr)}\n`;
  }
  for (const [k, v] of rows) {
    const body = `${faint(pad(k, labelW))}  ${v}`;
    out += `${sp}${fg(accent, glyph.v)} ${pad(truncate(body, w), w)} ${fg(accent, glyph.v)}\n`;
  }
  out += `${sp}${line(glyph.bl, glyph.br)}\n`;
  return out;
}

export const ok = (msg) => `${green(glyph.check)} ${msg}\n`;
export const fail = (msg) => `${red(glyph.cross)} ${msg}\n`;
export const warn = (msg) => `${amber(glyph.warn)} ${msg}\n`;
export const note = (msg) => `${faint(glyph.dot)} ${faint(msg)}\n`;

// --- spinner ------------------------------------------------------------

const FRAMES = unicode ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'];
export const spinnerFrames = FRAMES;

export function spinner(label) {
  if (!isTTY) {
    return { stop() {}, succeed() {}, fail() {} };
  }
  let i = 0;
  write('\x1b[?25l');
  const tick = () => {
    write(`\r\x1b[2K  ${green(FRAMES[i++ % FRAMES.length])} ${slate(label)}`);
  };
  tick();
  const timer = setInterval(tick, 80);
  const clear = () => {
    clearInterval(timer);
    write('\r\x1b[2K\x1b[?25h');
  };
  return {
    stop: clear,
    succeed(msg) { clear(); if (msg) write(`  ${ok(msg)}`); },
    fail(msg) { clear(); if (msg) write(`  ${fail(msg)}`); },
  };
}
