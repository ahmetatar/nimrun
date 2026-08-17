/**
 * Renders captured ANSI terminal output to a self-contained SVG "screenshot".
 * Every span is placed at an absolute x derived from its column, so the image
 * stays aligned no matter which monospace font the viewer actually has.
 */

const FONT = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";
const CHAR_W = 8.4;
const LINE_H = 20;
const PAD_X = 22;
const PAD_TOP = 46;
const PAD_BOTTOM = 20;

const BG = '#0b0e14';
const CHROME = '#161b26';
const FG = '#c9d3e0';

const ANSI16 = {
  30: '#3b4252', 31: '#e26052', 32: '#76b900', 33: '#e8a828', 34: '#5b8dd9', 35: '#b48ead', 36: '#56c8dc', 37: '#c9d3e0',
  90: '#58606a', 91: '#ff7b6b', 92: '#8fd400', 93: '#ffc44d', 94: '#7aa7ee', 95: '#d0a9c8', 96: '#7fe0f0', 97: '#ffffff',
};

function xterm256(n) {
  if (n < 16) return ANSI16[n < 8 ? 30 + n : 82 + n] || FG;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${v.toString(16).padStart(2, '0').repeat(3)}`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const [r, g, b] = [steps[Math.floor(i / 36)], steps[Math.floor(i / 6) % 6], steps[i % 6]];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// char -> {x, y, w, h} as fractions of one character cell
const BLOCKS = {
  '\u2588': { x: 0, y: 0, w: 1, h: 1 },      // full block
  '\u258c': { x: 0, y: 0, w: 0.5, h: 1 },    // left half
  '\u2590': { x: 0.5, y: 0, w: 0.5, h: 1 },  // right half
  '\u2580': { x: 0, y: 0, w: 1, h: 0.5 },    // upper half
  '\u2584': { x: 0, y: 0.5, w: 1, h: 0.5 },  // lower half
};
const BLOCK_RE = new RegExp(`[${Object.keys(BLOCKS).join('')}]`, 'g');

const blank = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });

function applySGR(state, params) {
  const p = params.length ? params : [0];
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) Object.assign(state, blank());
    else if (n === 1) state.bold = true;
    else if (n === 2) state.dim = true;
    else if (n === 3) state.italic = true;
    else if (n === 4) state.underline = true;
    else if (n === 7) state.inverse = true;
    else if (n === 22) { state.bold = false; state.dim = false; }
    else if (n === 23) state.italic = false;
    else if (n === 24) state.underline = false;
    else if (n === 27) state.inverse = false;
    else if (n === 39) state.fg = null;
    else if (n === 49) state.bg = null;
    else if (n === 38 || n === 48) {
      const target = n === 38 ? 'fg' : 'bg';
      if (p[i + 1] === 2) { state[target] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
      else if (p[i + 1] === 5) { state[target] = xterm256(p[i + 2]); i += 2; }
    } else if (ANSI16[n]) state.fg = ANSI16[n];
    else if (ANSI16[n - 10]) state.bg = ANSI16[n - 10];
  }
}

/** Splits ANSI text into lines of {text, col, style} spans. */
export function parseAnsi(input) {
  const lines = [];
  let spans = [];
  let col = 0;
  let state = blank();
  let buf = '';
  let bufCol = 0;

  const flush = () => {
    if (!buf) return;
    spans.push({ text: buf, col: bufCol, ...state });
    buf = '';
  };
  const newline = () => { flush(); lines.push(spans); spans = []; col = 0; bufCol = 0; };

  const re = /\x1b\[([0-9;]*)([a-zA-Z])|\n|([^\x1b\n]+)/g;
  let m;
  while ((m = re.exec(input))) {
    if (m[0] === '\n') { newline(); continue; }
    if (m[3] !== undefined) {
      if (!buf) bufCol = col;
      buf += m[3];
      col += [...m[3]].length;
      continue;
    }
    if (m[2] === 'm') {
      flush();
      bufCol = col;
      state = { ...state };
      applySGR(state, m[1] ? m[1].split(';').map(Number) : []);
    }
    // cursor moves and erases are repaint artefacts; frames are captured whole
  }
  newline();
  while (lines.length && !lines.at(-1).length) lines.pop();
  return lines;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toSvg(ansi, { title = 'nimrun', cols } = {}) {
  const lines = parseAnsi(ansi);
  const widest = Math.max(1, ...lines.map((l) => (l.length ? l.at(-1).col + [...l.at(-1).text].length : 0)));
  const width = Math.ceil((cols || widest + 2) * CHAR_W) + PAD_X * 2;
  const height = lines.length * LINE_H + PAD_TOP + PAD_BOTTOM;

  const body = lines.map((spans, row) => {
    const y = PAD_TOP + row * LINE_H;
    const rects = spans.filter((s) => s.bg || s.inverse).map((s) => {
      const fill = s.inverse ? (s.fg || FG) : s.bg;
      return `<rect x="${(PAD_X + s.col * CHAR_W).toFixed(1)}" y="${(y - 13).toFixed(1)}" width="${([...s.text].length * CHAR_W).toFixed(1)}" height="${LINE_H}" fill="${fill}"/>`;
    }).join('');

    // Block-drawing characters are painted as rects: as glyphs they leave seams
    // between rows, because a font's block is shorter than the line box.
    const blocks = spans.map((s) => {
      const fill = s.inverse ? BG : (s.fg || FG);
      let out = '';
      const chars = [...s.text];
      for (let i = 0; i < chars.length; i++) {
        const spec = BLOCKS[chars[i]];
        if (!spec) continue;
        let run = 1;
        while (chars[i + run] === chars[i]) run += 1;
        const x = PAD_X + (s.col + i) * CHAR_W + spec.x * CHAR_W;
        out += `<rect x="${x.toFixed(2)}" y="${(y - 14 + spec.y * LINE_H).toFixed(2)}" width="${(CHAR_W * (spec.w + run - 1)).toFixed(2)}" height="${(LINE_H * spec.h).toFixed(2)}" fill="${fill}"${s.dim ? ' opacity="0.62"' : ''}/>`;
        i += run - 1;
      }
      return out;
    }).join('');

    const texts = spans.map((s) => {
      if (!s.text.trim()) return '';
      const fill = s.inverse ? BG : (s.fg || FG);
      const attrs = [
        `x="${(PAD_X + s.col * CHAR_W).toFixed(1)}"`,
        `y="${y}"`,
        `fill="${fill}"`,
        s.bold ? 'font-weight="700"' : '',
        s.italic ? 'font-style="italic"' : '',
        s.underline ? 'text-decoration="underline"' : '',
        s.dim ? 'opacity="0.62"' : '',
      ].filter(Boolean).join(' ');
      const drawn = s.text.replace(BLOCK_RE, ' ');
      if (!drawn.trim()) return '';
      // Pin each run to the character grid so the image stays aligned in any
      // viewer, whatever monospace font it actually resolves.
      const cells = [...drawn].length;
      return `<text ${attrs} textLength="${(cells * CHAR_W).toFixed(2)}" lengthAdjust="spacing" xml:space="preserve">${esc(drawn)}</text>`;
    }).join('');

    return rects + blocks + texts;
  }).join('\n');

  const dots = ['#ff5f57', '#febc2e', '#28c840']
    .map((c, i) => `<circle cx="${20 + i * 18}" cy="20" r="6" fill="${c}"/>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="14">
  <rect width="${width}" height="${height}" rx="10" fill="${BG}"/>
  <path d="M0 10a10 10 0 0 1 10-10h${width - 20}a10 10 0 0 1 10 10v28H0z" fill="${CHROME}"/>
  ${dots}
  <text x="${width / 2}" y="25" fill="#6b7686" font-size="12" text-anchor="middle">${esc(title)}</text>
${body}
</svg>
`;
}
