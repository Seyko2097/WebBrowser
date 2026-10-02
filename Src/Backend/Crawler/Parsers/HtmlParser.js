// Analyseur HTML tolérant, sans dépendance : extrait titre, texte lisible, liens, balises meta/link.
import { resolveLinks } from './LinkParser.js';
import { parseMetadata } from './MetadataParser.js';

// Éléments dont le contenu est du texte brut (on saute jusqu'à la balise fermante)
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
// Éléments dont tout le sous-arbre est ignoré
const SKIP_TREE = new Set(['svg', 'math', 'template', 'head', 'select', 'button', 'object', 'canvas', 'audio', 'video', 'map']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'body', 'html',
]);
const CELL = new Set(['td', 'th']);
const HEADINGS = new Set(['h1', 'h2', 'h3']);

/** Marqueur inséré dans le texte après chaque lien : \u0001<index>\u0002 */
export const LINK_MARK = /\u0001(\d+)\u0002/g;

const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', bull: '•', middot: '·', deg: '°', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', times: '×', divide: '÷', plusmn: '±', micro: 'µ', frac12: '½',
  frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', iexcl: '¡', iquest: '¿', larr: '←', rarr: '→', uarr: '↑',
  darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', hearts: '♥', check: '✓', thinsp: ' ', ensp: ' ',
  emsp: ' ', zwj: '‍', zwnj: '‌', lrm: '', rlm: '', dagger: '†', Dagger: '‡', permil: '‰',
  prime: '′', Prime: '″', oline: '‾', infin: '∞', ne: '≠', le: '≤', ge: '≥', asymp: '≈', minus: '−',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', OElig: 'Œ',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', Yuml: 'Ÿ', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', oelig: 'œ',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω',
};

export function decodeEntities(str) {
  if (!str || !str.includes('&')) return str;
  return str.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (match, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      if (code === 0) return '�';
      // Plage 0x80-0x9F : interprétée en windows-1252 comme les navigateurs
      if (code >= 0x80 && code <= 0x9f) return CP1252[code - 0x80] || '\ufffd';
      return String.fromCodePoint(code);
    }
    const value = NAMED[ent] ?? NAMED[ent.toLowerCase()];
    return value ?? match;
  });
}

const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function parseAttributes(src) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;

function normalizeText(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[ \t\r\f\v ​]+/g, ' ').trim();
    if (line || (out.length && out[out.length - 1])) out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\n');
}

/**
 * Découpe un document HTML.
 * Renvoie { title, text, markedText, anchors, metas, linkTags, lang, baseHref, headings }.
 * `markedText` contient un marqueur LINK_MARK après le texte de chaque lien (index dans `anchors`).
 */
export function parseHtml(html) {
  html = String(html ?? '');
  const parts = [];
  const anchors = [];
  const metas = [];
  const linkTags = [];
  const headings = [];
  let title = '';
  let lang = '';
  let baseHref = null;
  let skipDepth = 0;
  let skipTag = null;
  let anchor = null;
  let heading = null;
  let inPre = 0;

  const pushText = (raw) => {
    if (skipDepth) return;
    let t = decodeEntities(raw);
    if (!inPre) t = t.replace(/\s+/g, ' ');
    parts.push(t);
    if (anchor) anchor.text += t;
    if (heading) heading.text += t;
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    if (!m) {
      pushText('<');
      i = lt + 1;
      continue;
    }
    i = TAG_RE.lastIndex;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosing = m[3].trimEnd().endsWith('/');

    if (closing) {
      if (skipDepth) {
        if (name === skipTag && --skipDepth === 0) skipTag = null;
        continue;
      }
      if (name === 'a' && anchor) {
        anchor.text = anchor.text.replace(/\s+/g, ' ').trim();
        parts.push(`\u0001${anchors.length - 1}\u0002`);
        anchor = null;
      } else if (HEADINGS.has(name) && heading) {
        const t = heading.text.replace(/\s+/g, ' ').trim();
        if (t) headings.push({ level: heading.level, text: t });
        heading = null;
      } else if (name === 'pre') inPre = Math.max(0, inPre - 1);
      if (BLOCK.has(name)) parts.push('\n');
      else if (CELL.has(name)) parts.push(' \t ');
      continue;
    }

    const attrs = parseAttributes(m[3]);
    if (name === 'html' && attrs.lang) lang = attrs.lang;
    // Les balises meta/link/base sont lues même dans <head>, qu'on ignore pour le texte
    if (name === 'meta') {
      metas.push(attrs);
      continue;
    }
    if (name === 'link') {
      linkTags.push(attrs);
      continue;
    }
    if (name === 'base') {
      if (attrs.href && baseHref === null) baseHref = attrs.href;
      continue;
    }

    if (RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'ig');
      close.lastIndex = i;
      const cm = name === 'plaintext' ? null : close.exec(html);
      const end = cm ? cm.index : n;
      if (name === 'title' && !title) title = decodeEntities(html.slice(i, end)).replace(/\s+/g, ' ').trim();
      else if (name === 'textarea' && !skipDepth) pushText(html.slice(i, end));
      i = cm ? close.lastIndex : n;
      continue;
    }
    if (skipDepth) {
      if (name === skipTag && !selfClosing) skipDepth++;
      continue;
    }
    if (SKIP_TREE.has(name) && !selfClosing) {
      // <head> implicite : si le corps commence sans </head>, on arrête de l'ignorer au <body>
      if (name === 'head') continue;
      skipTag = name;
      skipDepth = 1;
      continue;
    }
    if (name === 'a' && attrs.href !== undefined) {
      if (anchor) {
        anchor.text = anchor.text.replace(/\s+/g, ' ').trim();
        parts.push(`\u0001${anchors.length - 1}\u0002`);
      }
      anchor = { href: attrs.href, text: '', rel: (attrs.rel ?? '').toLowerCase(), title: attrs.title ?? '' };
      anchors.push(anchor);
    } else if (HEADINGS.has(name)) {
      heading = { level: Number(name[1]), text: '' };
    } else if (name === 'pre') {
      inPre++;
    } else if (name === 'img' && attrs.alt && anchor && !anchor.text.trim()) {
      anchor.text = attrs.alt;
    } else if (name === 'li') {
      parts.push('\n• ');
      continue;
    }
    if (BLOCK.has(name)) parts.push('\n');
    else if (CELL.has(name)) parts.push(' ');
  }
  if (anchor) {
    anchor.text = anchor.text.replace(/\s+/g, ' ').trim();
    parts.push(`\u0001${anchors.length - 1}\u0002`);
  }

  const markedText = normalizeText(parts.join('').replace(/ \t /g, '  ').replace(/•\s*\n/g, '• '));
  return {
    title,
    text: markedText.replace(LINK_MARK, ''),
    markedText,
    anchors,
    metas,
    linkTags,
    lang,
    baseHref,
    headings,
  };
}

/**
 * Analyse complète d'une page : HTML + métadonnées + liens résolus.
 * Renvoie { url, doc, meta, links } où links = [{ url, text, nofollow, index }].
 */
export function parsePage(html, pageUrl) {
  const doc = parseHtml(html);
  const meta = parseMetadata(doc, pageUrl);
  const links = resolveLinks(doc, pageUrl);
  return { url: pageUrl, doc, meta, links, text: doc.text };
}
