// Contexte de navigation : cookies, réseau (direct/Tor), pile précédent/suivant.
import crypto from 'node:crypto';

/** Pot à cookies minimal (RFC 6265 simplifiée) : domaine, chemin, expiration, Secure. */
export class CookieJar {
  constructor() {
    this.cookies = new Map(); // clé : domaine|chemin|nom
  }

  store(url, setCookieHeaders) {
    const target = new URL(url);
    for (const header of setCookieHeaders) {
      const [pair, ...attrs] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const cookie = {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: target.hostname,
        hostOnly: true,
        path: target.pathname.replace(/\/[^/]*$/, '') || '/',
        secure: false,
        expires: null,
      };
      for (const attr of attrs) {
        const [k, ...v] = attr.split('=');
        const key = k.trim().toLowerCase();
        const val = v.join('=').trim();
        if (key === 'domain' && val) {
          const d = val.replace(/^\./, '').toLowerCase();
          // Refuse un domaine qui n'englobe pas l'hôte courant
          if (target.hostname !== d && !target.hostname.endsWith(`.${d}`)) {
            cookie.domain = null;
            break;
          }
          cookie.domain = d;
          cookie.hostOnly = false;
        } else if (key === 'path' && val.startsWith('/')) cookie.path = val;
        else if (key === 'secure') cookie.secure = true;
        else if (key === 'max-age') cookie.expires = Date.now() + Number(val) * 1000;
        else if (key === 'expires' && cookie.expires === null) {
          const t = Date.parse(val);
          if (!Number.isNaN(t)) cookie.expires = t;
        }
      }
      if (!cookie.domain) continue;
      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      if (cookie.expires !== null && cookie.expires <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, cookie);
    }
  }

  header(url) {
    const target = new URL(url);
    const now = Date.now();
    const matches = [];
    for (const [key, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) {
        this.cookies.delete(key);
        continue;
      }
      const domainOk = c.hostOnly ? target.hostname === c.domain
        : target.hostname === c.domain || target.hostname.endsWith(`.${c.domain}`);
      const pathOk = target.pathname === c.path || target.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`);
      if (domainOk && pathOk && (!c.secure || target.protocol === 'https:')) matches.push(c);
    }
    matches.sort((a, b) => b.path.length - a.path.length);
    return matches.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  clear() {
    this.cookies.clear();
  }

  get size() {
    return this.cookies.size;
  }
}

export class Context {
  /**
   * @param {object} o
   * @param {'auto'|'direct'|'tor'} [o.network] auto = Tor uniquement pour les .onion
   * @param {boolean} [o.cookies] conserver les cookies
   */
  constructor({ id = crypto.randomUUID(), network = 'auto', cookies = true } = {}) {
    this.id = id;
    this.network = network;
    this.cookieJar = cookies ? new CookieJar() : null;
    this.entries = [];
    this.index = -1;
  }

  cookieHeader(url) {
    return this.cookieJar?.header(url) ?? '';
  }

  storeCookies(url, headers) {
    this.cookieJar?.store(url, headers);
  }

  /** Nouvelle navigation : coupe l'historique « suivant ». */
  push(url) {
    if (this.entries[this.index] === url) return;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(url);
    this.index = this.entries.length - 1;
  }

  /** Remplace l'entrée courante (redirection). */
  replace(url) {
    if (this.index >= 0) this.entries[this.index] = url;
    else this.push(url);
  }

  get current() {
    return this.entries[this.index] ?? null;
  }

  canGoBack() {
    return this.index > 0;
  }

  canGoForward() {
    return this.index < this.entries.length - 1;
  }

  back() {
    if (!this.canGoBack()) return null;
    return this.entries[--this.index];
  }

  forward() {
    if (!this.canGoForward()) return null;
    return this.entries[++this.index];
  }
}
