// Construction et lecture des en-têtes HTTP.

export const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5';

// En-têtes génériques utilisés via Tor : identiques à ceux de Tor Browser pour ne pas se distinguer.
export const TOR_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';

export function buildHeaders({ userAgent, acceptLanguage = 'fr-FR,fr;q=0.9,en;q=0.8', accept = ACCEPT_HTML, torSafe = false, extra = {} } = {}) {
  const headers = {
    'user-agent': torSafe ? TOR_USER_AGENT : userAgent,
    accept,
    'accept-language': torSafe ? 'en-US,en;q=0.5' : acceptLanguage,
    'accept-encoding': 'gzip, deflate, br',
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete headers[k.toLowerCase()];
    else headers[k.toLowerCase()] = String(v);
  }
  return headers;
}

/** "text/html; charset=ISO-8859-1" → { mime: 'text/html', charset: 'iso-8859-1' } */
export function parseContentType(value) {
  const [mime = '', ...params] = String(value ?? '').split(';');
  let charset = null;
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p);
    if (m) charset = m[1].toLowerCase();
  }
  return { mime: mime.trim().toLowerCase(), charset };
}

export function isHtmlType(mime) {
  return mime === 'text/html' || mime === 'application/xhtml+xml' || mime === '';
}

export function isTextType(mime) {
  return mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+xml') || mime === 'application/xml';
}

/** Cherche <meta charset> dans le début d'un document HTML. */
export function sniffCharset(buffer) {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : null;
}

export function headerList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
