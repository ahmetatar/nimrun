import readline from 'node:readline';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  inv: '\x1b[7m', gray: '\x1b[90m',
};
export const color = c;

/**
 * Type-to-filter list picker. Falls back to a numbered prompt when stdin is not
 * a TTY (piped input, CI) so the CLI never hangs on a keypress that cannot come.
 */
export async function select({ items, label = 'Select', pageSize = 12, render }) {
  if (!items.length) throw new Error('nothing to select from');
  if (!process.stdin.isTTY) return fallback({ items, label, render });

  const out = process.stderr;
  let query = '';
  let cursor = 0;
  let offset = 0;
  let lastLines = 0;

  const filtered = () => {
    if (!query) return items;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => {
      const hay = (render ? render(it).plain : String(it)).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  };

  const draw = () => {
    const list = filtered();
    if (cursor >= list.length) cursor = Math.max(0, list.length - 1);
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + pageSize) offset = cursor - pageSize + 1;

    const lines = [];
    lines.push(`${c.bold}${label}${c.reset} ${c.dim}(type to filter, ↑↓ move, enter select, esc quit)${c.reset}`);
    lines.push(`${c.cyan}❯${c.reset} ${query}${c.dim}▏${c.reset}`);

    const page = list.slice(offset, offset + pageSize);
    if (!page.length) lines.push(`  ${c.dim}no match${c.reset}`);
    for (let i = 0; i < page.length; i++) {
      const idx = offset + i;
      const r = render ? render(page[i]) : { display: String(page[i]) };
      lines.push(idx === cursor ? `${c.green}❯${c.reset} ${r.display}` : `  ${r.display}`);
    }
    lines.push(`${c.dim}${list.length} of ${items.length} models${c.reset}`);

    if (lastLines) out.write(`\x1b[${lastLines}A`);
    for (const line of lines) out.write(`\x1b[2K${line}\n`);
    for (let i = lines.length; i < lastLines; i++) out.write('\x1b[2K\n');
    if (lastLines > lines.length) out.write(`\x1b[${lastLines - lines.length}A`);
    lastLines = Math.max(lines.length, lastLines);
  };

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.write('\x1b[?25l');

  const cleanup = () => {
    out.write('\x1b[?25h');
    process.stdin.setRawMode(Boolean(wasRaw));
    process.stdin.pause();
    process.stdin.removeListener('keypress', onKey);
  };

  let onKey;
  try {
    draw();
    return await new Promise((resolve, reject) => {
      onKey = (str, key) => {
        const list = filtered();
        if (key.ctrl && key.name === 'c') { cleanup(); reject(new Error('cancelled')); return; }
        if (key.name === 'escape') { cleanup(); reject(new Error('cancelled')); return; }
        if (key.name === 'return' || key.name === 'enter') {
          if (!list.length) return;
          cleanup();
          resolve(list[cursor]);
          return;
        }
        if (key.name === 'up') cursor = Math.max(0, cursor - 1);
        else if (key.name === 'down') cursor = Math.min(list.length - 1, cursor + 1);
        else if (key.name === 'pageup') cursor = Math.max(0, cursor - pageSize);
        else if (key.name === 'pagedown') cursor = Math.min(list.length - 1, cursor + pageSize);
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

async function fallback({ items, label, render }) {
  const out = process.stderr;
  out.write(`${label}\n`);
  items.slice(0, 40).forEach((it, i) => {
    const r = render ? render(it) : { display: String(it) };
    out.write(`  ${String(i + 1).padStart(2)}) ${r.display}\n`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: out });
  const answer = await new Promise((r) => rl.question('number> ', r));
  rl.close();
  const n = Number.parseInt(answer, 10);
  if (!Number.isInteger(n) || n < 1 || n > items.length) throw new Error('cancelled');
  return items[n - 1];
}

export async function prompt(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (silent) {
    const onData = () => { readline.clearLine(process.stderr, 0); readline.cursorTo(process.stderr, 0); process.stderr.write(question); };
    rl.input.on('data', onData);
    const answer = await new Promise((r) => rl.question(question, r));
    rl.input.removeListener('data', onData);
    rl.close();
    process.stderr.write('\n');
    return answer.trim();
  }
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim();
}
