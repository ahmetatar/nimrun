import readline from 'node:readline';
import * as ui from './ui.js';

const { glyph: g } = ui;

/**
 * Type-to-filter list picker. Falls back to a numbered prompt when stdin is not
 * a TTY (piped input, CI) so the CLI never hangs on a keypress that cannot come.
 */
export async function select({ items, label = 'Select', hint = '', pageSize, render }) {
  if (!items.length) throw new Error('nothing to select from');
  if (!process.stdin.isTTY || !process.stderr.isTTY) return fallback({ items, label, render });

  const rows = process.stderr.rows || 24;
  const page = pageSize || Math.max(5, Math.min(14, rows - 10));

  let query = '';
  let cursor = 0;
  let offset = 0;
  let painted = 0;

  const filtered = () => {
    if (!query) return items;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => terms.every((t) => render(it).plain.toLowerCase().includes(t)));
  };

  const draw = () => {
    const list = filtered();
    if (cursor >= list.length) cursor = Math.max(0, list.length - 1);
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + page) offset = cursor - page + 1;

    const cols = ui.columns();
    const inner = Math.max(24, Math.min(cols - 6, 92));
    const lines = [];

    // header: title on the left, keys on the right
    const keys = ui.faint(`${g.up}${g.down} move   ${g.enter} select   esc quit`);
    const title = `${ui.gradient(label, [ui.GREEN, ui.GLOW])}`;
    const gap = Math.max(1, inner - ui.width(title) - ui.width(keys));
    lines.push(`  ${title}${' '.repeat(gap)}${keys}`);
    lines.push(`  ${ui.fg(ui.DEEP, g.h.repeat(inner))}`);

    // search line
    const caret = ui.green(g.arrow);
    const typed = query ? query : ui.faint('type to filter');
    lines.push(`  ${caret} ${typed}${ui.depth ? ui.fg(ui.GREEN, ui.unicode ? '▏' : '_') : '_'}`);
    lines.push('');

    // rows
    const visible = list.slice(offset, offset + page);
    if (!visible.length) {
      lines.push(`    ${ui.faint('no model matches that filter')}`);
    }
    for (let i = 0; i < visible.length; i++) {
      const idx = offset + i;
      const active = idx === cursor;
      const r = render(visible[i], { query, active });
      const body = ui.truncate(r.display, inner - 4);
      const bar = scrollbar(i, page, list.length, offset);
      lines.push(active
        ? `  ${ui.green(g.arrow)} ${body}${ui.RESET}${' '.repeat(Math.max(0, inner - 4 - ui.width(body)))} ${bar}`
        : `    ${body}${' '.repeat(Math.max(0, inner - 4 - ui.width(body)))} ${bar}`);
    }

    // footer
    lines.push('');
    const count = `${list.length}${list.length === items.length ? '' : `/${items.length}`} models`;
    lines.push(`  ${ui.faint(count)}${hint ? ui.faint(`   ${g.dot}   ${hint}`) : ''}`);

    // repaint in place
    if (painted) ui.write(`\x1b[${painted}A`);
    for (const line of lines) ui.write(`\x1b[2K${line}\n`);
    for (let i = lines.length; i < painted; i++) ui.write('\x1b[2K\n');
    if (painted > lines.length) ui.write(`\x1b[${painted - lines.length}A`);
    painted = Math.max(lines.length, painted);
  };

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  ui.write('\x1b[?25l');

  let onKey;
  const cleanup = () => {
    ui.write('\x1b[?25h');
    process.stdin.setRawMode(Boolean(wasRaw));
    process.stdin.pause();
    if (onKey) process.stdin.removeListener('keypress', onKey);
  };

  try {
    draw();
    return await new Promise((resolve, reject) => {
      onKey = (str, key) => {
        const list = filtered();
        if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          if (!list.length) return;
          cleanup();
          resolve(list[cursor]);
          return;
        }
        if (key.name === 'up' || (key.ctrl && key.name === 'p')) cursor = Math.max(0, cursor - 1);
        else if (key.name === 'down' || (key.ctrl && key.name === 'n')) cursor = Math.min(list.length - 1, cursor + 1);
        else if (key.name === 'pageup') cursor = Math.max(0, cursor - page);
        else if (key.name === 'pagedown') cursor = Math.min(list.length - 1, cursor + page);
        else if (key.name === 'home') cursor = 0;
        else if (key.name === 'end') cursor = list.length - 1;
        else if (key.ctrl && key.name === 'u') { query = ''; cursor = 0; offset = 0; }
        else if (key.name === 'backspace') { query = query.slice(0, -1); cursor = 0; offset = 0; }
        else if (str && !key.ctrl && !key.meta && str >= ' ') { query += str; cursor = 0; offset = 0; }
        else return;
        draw();
      };
      process.stdin.on('keypress', onKey);
    });
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** A one-column thumb so long catalogs show where you are. */
function scrollbar(row, page, total, offset) {
  if (total <= page) return ' ';
  const thumbSize = Math.max(1, Math.round((page / total) * page));
  const maxOffset = total - page;
  const start = Math.round((offset / maxOffset) * (page - thumbSize));
  const on = row >= start && row < start + thumbSize;
  return on ? ui.fg(ui.GREEN, g.thumb) : ui.fg(ui.FAINT, ui.unicode ? '│' : ':');
}

/** Underlines the part of the text the user actually typed. */
export function highlight(text, query) {
  if (!query) return text;
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const marks = new Array(text.length).fill(false);
  const lower = text.toLowerCase();
  for (const t of terms) {
    let from = 0;
    let at;
    while ((at = lower.indexOf(t, from)) !== -1) {
      for (let i = at; i < at + t.length; i++) marks[i] = true;
      from = at + t.length;
    }
  }
  let out = '';
  let run = '';
  let state = false;
  for (let i = 0; i <= text.length; i++) {
    const m = i < text.length && marks[i];
    if (m !== state || i === text.length) {
      // underline, not bold: its terminator does not cancel an outer bold row
      out += state ? ui.fg(ui.GLOW, ui.underline(run)) : run;
      run = '';
      state = m;
    }
    if (i < text.length) run += text[i];
  }
  return out;
}

async function fallback({ items, label, render }) {
  ui.write(`${label}\n`);
  items.slice(0, 40).forEach((it, i) => {
    ui.write(`  ${String(i + 1).padStart(2)}) ${render(it).plain}\n`);
  });
  if (items.length > 40) ui.write(`  ${ui.faint(`… and ${items.length - 40} more`)}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((r) => rl.question('number> ', r));
  rl.close();
  const n = Number.parseInt(answer, 10);
  if (!Number.isInteger(n) || n < 1 || n > items.length) throw new Error('cancelled');
  return items[n - 1];
}

export async function prompt(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (silent) {
    const mask = () => {
      readline.clearLine(process.stderr, 0);
      readline.cursorTo(process.stderr, 0);
      process.stderr.write(question);
    };
    rl.input.on('data', mask);
    const answer = await new Promise((r) => rl.question(question, r));
    rl.input.removeListener('data', mask);
    rl.close();
    process.stderr.write('\n');
    return answer.trim();
  }
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim();
}
