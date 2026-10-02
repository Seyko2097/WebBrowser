// Moteur d'affichage plein écran en ANSI pur : écran alternatif, mode brut, décodage des touches,
// largeur des caractères (CJK, emoji, accents combinants), découpage et habillage du texte.
import { EventEmitter } from 'node:events';

const NO_COLOR = Boolean(process.env.NO_COLOR);

// Styles SGR. Avec NO_COLOR, seuls gras/atténué/souligné/inverse sont conservés.
export const S = {
  none: '',
  bold: '1',
  dim: '2',
  title: '1;34',
  url: '32',
  hl: '1;33',
  accent: '1;36',
  link: '36',
  bar: '30;46',
  barDim: '2;30;46',
  tab: '1;30;46',
  tabOff: '37;100',
  sel: '7',
  selTitle: '1;7;34',
  err: '1;31',
  ok: '32',
  warn: '33',
  onion: '35',
  input: '4',
};

function sgr(style) {
  if (!style) return '\x1b[0m';
  if (!NO_COLOR) return `\x1b[0;${style}m`;
  const kept = style.split(';').filter((c) => ['1', '2', '4', '7'].includes(c));
  return `\x1b[0;${kept.join(';')}m`;
}

// ---------------------------------------------------------------------------------- largeur

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x18aff],
  [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

const COMBINING = /[\p{Mn}\p{Me}​-‏⁠︀-️]/u;

export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (COMBINING.test(ch)) return 0;
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < WIDE[mid][0]) hi = mid - 1;
    else if (cp > WIDE[mid][1]) lo = mid + 1;
    else return 2;
  }
  return 1;
}

export function textWidth(str) {
  let w = 0;
  for (const ch of String(str)) w += charWidth(ch);
  return w;
}

/** Tronque `str` à `width` colonnes ; ajoute « … » si coupé (sauf ellipsis=false). */
export function clip(str, width, ellipsis = true) {
  str = String(str ?? '');
  if (width <= 0) return '';
  if (textWidth(str) <= width) return str;
  const limit = ellipsis ? width - 1 : width;
  let out = '';
  let used = 0;
  for (const ch of str) {
    const w = charWidth(ch);
    if (used + w > limit) break;
    out += ch;
    used += w;
  }
  return ellipsis ? `${out}…` : out;
}

export function padEnd(str, width) {
  const s = clip(str, width);
  return s + ' '.repeat(Math.max(0, width - textWidth(s)));
}

/** Habille le texte (respecte les sauts de ligne, coupe les mots trop longs). */
export function wrap(text, width) {
  width = Math.max(10, width);
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    if (!para.trim()) {
      lines.push('');
      continue;
    }
    const indent = /^(\s*(?:•|-|\d+\.)\s+)/.exec(para)?.[1] ?? '';
    const hang = ' '.repeat(Math.min(textWidth(indent), 8));
    let line = '';
    let lineW = 0;
    let fresh = true; // ligne vide (hors indentation)
    const newLine = () => {
      lines.push(line);
      line = hang;
      lineW = hang.length;
      fresh = true;
    };
    for (const word of para.trim().split(/\s+/)) {
      const ww = textWidth(word);
      if (!fresh && lineW + 1 + ww > width) newLine();
      if (ww > width - lineW) {
        // mot plus long que la ligne : découpe forcée
        let rest = word;
        while (textWidth(rest) > width - lineW) {
          const part = clip(rest, width - lineW, false);
          if (!part) break;
          line += part;
          rest = rest.slice(part.length);
          newLine();
        }
        line += rest;
        lineW += textWidth(rest);
        fresh = !rest;
        continue;
      }
      line += (fresh ? '' : ' ') + word;
      lineW += (fresh ? 0 : 1) + ww;
      fresh = false;
    }
    lines.push(line);
  }
  return lines;
}

/** Découpe une ligne en segments stylés selon des expressions à surligner. */
export function highlight(line, rules, base = S.none) {
  // rules : [{ re: RegExp global, style }]
  const marks = [];
  for (const { re, style } of rules) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      marks.push({ start: m.index, end: m.index + m[0].length, style });
    }
  }
  if (!marks.length) return [[line, base]];
  marks.sort((a, b) => a.start - b.start);
  const segs = [];
  let pos = 0;
  for (const mk of marks) {
    if (mk.start < pos) continue;
    if (mk.start > pos) segs.push([line.slice(pos, mk.start), base]);
    segs.push([line.slice(mk.start, mk.end), mk.style]);
    pos = mk.end;
  }
  if (pos < line.length) segs.push([line.slice(pos), base]);
  return segs;
}

/** Expression qui trouve les mots commençant par l'un des termes (insensible casse/accents). */
export function termsRegex(terms) {
  const fold = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '');
  const parts = terms.filter((t) => t.length > 1).map((t) => fold(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\p{L}/gu, (c) => {
      const variants = new Set([c, c.toUpperCase(), c.toLowerCase()]);
      const accents = { a: 'àâäáãå', e: 'éèêë', i: 'îïíì', o: 'ôöóòõ', u: 'ùûüú', c: 'ç', n: 'ñ', y: 'ÿý' }[c.toLowerCase()];
      if (accents) for (const a of accents) variants.add(a).add(a.toUpperCase());
      return `[${[...variants].join('')}]`;
    }));
  if (!parts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})[\\p{L}\\p{N}]*`, 'gu');
}

// ---------------------------------------------------------------------------------- clavier

const CSI_KEYS = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'shift-tab', P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
};
const TILDE_KEYS = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
};

/** Décode une suite d'octets reçue du terminal en touches { name, char?, ctrl?, alt?, text? }. */
export function parseKeys(data) {
  const keys = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (data.startsWith('\x1b[200~', i)) {
      const end = data.indexOf('\x1b[201~', i + 6);
      const text = data.slice(i + 6, end === -1 ? data.length : end);
      keys.push({ name: 'paste', text });
      i = end === -1 ? data.length : end + 6;
      continue;
    }
    if (ch === '\x1b') {
      const next = data[i + 1];
      if (next === undefined) {
        keys.push({ name: 'escape' });
        i++;
        continue;
      }
      if (next === '[' || next === 'O') {
        const m = /^\x1b[[O]([0-9;]*)([A-Za-z~])/.exec(data.slice(i));
        if (m) {
          const [full, params, final] = m;
          const nums = params.split(';').filter(Boolean).map(Number);
          const mod = (nums[1] ?? 1) - 1;
          let name = final === '~' ? TILDE_KEYS[nums[0]] : CSI_KEYS[final];
          if (next === '[' && final === '[') name = undefined;
          if (name) keys.push({ name, ctrl: Boolean(mod & 4), alt: Boolean(mod & 2), shift: Boolean(mod & 1) });
          i += full.length;
          continue;
        }
        // Console Linux : ESC [ [ A..E pour F1..F5
        const lm = /^\x1b\[\[([A-E])/.exec(data.slice(i));
        if (lm) {
          keys.push({ name: `f${'ABCDE'.indexOf(lm[1]) + 1}` });
          i += lm[0].length;
          continue;
        }
        keys.push({ name: 'escape' });
        i++;
        continue;
      }
      if (next === '\x1b') {
        keys.push({ name: 'escape' });
        i++;
        continue;
      }
      // Alt + caractère
      const cp = data.codePointAt(i + 1);
      const c = String.fromCodePoint(cp);
      keys.push({ name: c.length === 1 && c >= ' ' ? `alt-${c}` : 'escape', char: c, alt: true });
      i += 1 + c.length;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (ch === '\r' || ch === '\n') keys.push({ name: 'enter' });
    else if (ch === '\t') keys.push({ name: 'tab' });
    else if (code === 0x7f || code === 0x08) keys.push({ name: 'backspace' });
    else if (code === 0) keys.push({ name: 'ctrl-space', ctrl: true });
    else if (code < 27) keys.push({ name: `ctrl-${String.fromCharCode(code + 96)}`, ctrl: true });
    else if (code < 32) keys.push({ name: `ctrl-${code}`, ctrl: true });
    else {
      const cp = data.codePointAt(i);
      const c = String.fromCodePoint(cp);
      keys.push({ name: 'char', char: c });
      i += c.length;
      continue;
    }
    i++;
  }
  return keys;
}

// ---------------------------------------------------------------------------------- saisie

/** Champ de saisie d'une ligne avec curseur et défilement horizontal. */
export class LineInput {
  constructor(value = '') {
    this.value = value;
    this.cursor = value.length;
    this.scroll = 0;
  }

  set(value) {
    this.value = value;
    this.cursor = value.length;
  }

  /** Renvoie 'changed' si le texte a changé, 'moved' si le curseur a bougé, sinon false. */
  handle(key) {
    const v = this.value;
    const c = this.cursor;
    switch (key.name) {
      case 'char':
        this.value = v.slice(0, c) + key.char + v.slice(c);
        this.cursor += key.char.length;
        return 'changed';
      case 'paste': {
        const text = key.text.replace(/[\r\n\t]+/g, ' ');
        this.value = v.slice(0, c) + text + v.slice(c);
        this.cursor += text.length;
        return 'changed';
      }
      case 'backspace':
        if (!c) return false;
        {
          const prev = [...v.slice(0, c)].pop();
          this.value = v.slice(0, c - prev.length) + v.slice(c);
          this.cursor -= prev.length;
        }
        return 'changed';
      case 'delete':
        if (c >= v.length) return false;
        this.value = v.slice(0, c) + v.slice(c + String.fromCodePoint(v.codePointAt(c)).length);
        return 'changed';
      case 'ctrl-u':
        if (!v) return false;
        this.value = v.slice(c);
        this.cursor = 0;
        return 'changed';
      case 'ctrl-k':
        this.value = v.slice(0, c);
        return 'changed';
      case 'ctrl-w': {
        const left = v.slice(0, c).replace(/\S+\s*$/, '');
        this.value = left + v.slice(c);
        this.cursor = left.length;
        return 'changed';
      }
      case 'left':
        if (key.ctrl) this.cursor = v.slice(0, c).replace(/\S+\s*$/, '').length;
        else if (c) this.cursor -= [...v.slice(0, c)].pop().length;
        return 'moved';
      case 'right':
        if (key.ctrl) this.cursor = c + (/^\s*\S+/.exec(v.slice(c))?.[0].length ?? 0);
        else if (c < v.length) this.cursor += String.fromCodePoint(v.codePointAt(c)).length;
        return 'moved';
      case 'home':
      case 'ctrl-a':
        this.cursor = 0;
        return 'moved';
      case 'end':
      case 'ctrl-e':
        this.cursor = v.length;
        return 'moved';
      default:
        return false;
    }
  }

  /** Texte visible dans `width` colonnes et colonne du curseur. */
  view(width) {
    const before = textWidth(this.value.slice(0, this.cursor));
    if (before - this.scroll >= width) this.scroll = before - width + 1;
    if (before < this.scroll) this.scroll = Math.max(0, before - Math.floor(width / 3));
    let skipped = 0;
    let start = 0;
    for (const ch of this.value) {
      if (skipped >= this.scroll) break;
      skipped += charWidth(ch);
      start += ch.length;
    }
    return { text: clip(this.value.slice(start), width, false), cursorCol: before - skipped };
  }
}

// ---------------------------------------------------------------------------------- terminal

export class Terminal extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    super();
    this.input = input;
    this.output = output;
    this.active = false;
    this.onData = (buf) => {
      for (const key of parseKeys(buf.toString('utf8'))) this.emit('key', key);
    };
    this.onResize = () => this.emit('resize');
  }

  get width() {
    return this.output.columns || 80;
  }

  get height() {
    return this.output.rows || 24;
  }

  start() {
    if (this.active) return;
    if (!this.input.isTTY || !this.output.isTTY) {
      throw new Error("l'interface nécessite un terminal interactif (TTY)");
    }
    this.active = true;
    // Écran alternatif, curseur masqué, collage entre crochets, pas de retour à la ligne auto
    this.output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?7l\x1b[2J');
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on('data', this.onData);
    this.output.on('resize', this.onResize);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.input.off('data', this.onData);
    this.output.off('resize', this.onResize);
    try {
      this.input.setRawMode(false);
    } catch {
      // terminal déjà fermé
    }
    this.input.pause();
    this.output.write('\x1b[0m\x1b[?7h\x1b[?2004l\x1b[?25h\x1b[?1049l');
  }

  /** Suspend l'affichage pour lancer un programme externe (navigateur graphique, éditeur…). */
  async suspend(fn) {
    this.stop();
    try {
      return await fn();
    } finally {
      this.start();
      this.emit('resize');
    }
  }

  /**
   * Dessine l'écran complet.
   * @param {Array<Array<[string, string]>>} rows lignes composées de segments [texte, style]
   * @param {{row:number, col:number}|null} cursor
   */
  draw(rows, cursor = null) {
    const w = this.width;
    const h = this.height;
    let out = '\x1b[?2026h\x1b[?25l';
    for (let y = 0; y < h; y++) {
      out += `\x1b[${y + 1};1H`;
      let used = 0;
      for (const [text, style] of rows[y] ?? []) {
        if (used >= w) break;
        const t = clip(String(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''), w - used);
        if (!t) continue;
        out += sgr(style) + t;
        used += textWidth(t);
      }
      const fill = rows[y]?.fillStyle;
      out += fill ? `${sgr(fill)}${' '.repeat(Math.max(0, w - used))}` : '\x1b[0m\x1b[K';
    }
    out += '\x1b[0m';
    if (cursor) out += `\x1b[${cursor.row + 1};${Math.min(w, cursor.col + 1)}H\x1b[?25h`;
    out += '\x1b[?2026l';
    this.output.write(out);
  }
}

/** Ligne de segments remplie jusqu'au bord avec un style de fond. */
export function filledRow(segments, fillStyle) {
  const row = [...segments];
  row.fillStyle = fillStyle;
  return row;
}
