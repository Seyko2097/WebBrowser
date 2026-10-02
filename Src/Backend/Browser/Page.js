// Page chargée par le navigateur : texte lisible avec liens numérotés [n], métadonnées, recherche.
import { parsePage, LINK_MARK } from '../Crawler/Parsers/HtmlParser.js';
import { isHtmlType, isTextType } from '../Network/Headers.js';
import { formatBytes } from '../Storage/Files.js';

export class Page {
  constructor({ url, status = 200, mime = 'text/html', title = '', text = '', links = [], meta = {},
    network = 'web', fromCache = false, fetchedAt = Date.now(), size = 0, kind = 'html', redirects = [] }) {
    this.url = url;
    this.status = status;
    this.mime = mime;
    this.title = title || url;
    this.text = text;
    this.links = links; // [{ number, url, text }]
    this.meta = meta;
    this.network = network;
    this.fromCache = fromCache;
    this.fetchedAt = fetchedAt;
    this.size = size;
    this.kind = kind; // html | text | binary
    this.redirects = redirects;
  }

  /** Construit une page à partir du HTML : chaque lien reçoit un numéro affiché « [n] » dans le texte. */
  static fromHtml(html, url, extra = {}) {
    const parsed = parsePage(html, url);
    const numbers = new Map(); // index d'ancre → numéro
    const links = parsed.links.map((link, i) => {
      const number = i + 1;
      for (const idx of link.anchorIndexes) numbers.set(idx, number);
      return { number, url: link.url, text: link.text };
    });
    const text = parsed.doc.markedText.replace(LINK_MARK, (_, idx) => {
      const n = numbers.get(Number(idx));
      return n ? `[${n}]` : '';
    });
    return new Page({ ...extra, url, title: parsed.meta.title, text, links, meta: parsed.meta, kind: 'html' });
  }

  static fromResponse(res, { network = 'web' } = {}) {
    const common = {
      status: res.status, mime: res.mime, network, fromCache: res.fromCache, size: res.body.length, redirects: res.redirects,
    };
    if (isHtmlType(res.mime)) {
      const page = Page.fromHtml(res.text(), res.url, common);
      page.rawHtml = res.text();
      return page;
    }
    if (isTextType(res.mime)) {
      return new Page({ ...common, url: res.url, title: res.url.split('/').pop() || res.url, text: res.text(), kind: 'text' });
    }
    return new Page({
      ...common,
      url: res.url,
      title: res.url.split('/').pop() || res.url,
      text: `Fichier ${res.mime || 'binaire'} (${formatBytes(res.body.length)}).\nAppuyez sur « d » pour le télécharger.`,
      kind: 'binary',
    });
  }

  link(number) {
    return this.links.find((l) => l.number === Number(number)) ?? null;
  }

  /** Numéros de ligne (dans `lines`) contenant `term`, insensible à la casse et aux accents. */
  static findInLines(lines, term) {
    const fold = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    const t = fold(term);
    if (!t) return [];
    const hits = [];
    lines.forEach((line, i) => {
      if (fold(typeof line === 'string' ? line : line.text).includes(t)) hits.push(i);
    });
    return hits;
  }

  toJSON() {
    return {
      url: this.url, status: this.status, mime: this.mime, title: this.title, text: this.text,
      links: this.links, meta: this.meta, network: this.network, kind: this.kind,
      fromCache: this.fromCache, fetchedAt: this.fetchedAt, size: this.size, redirects: this.redirects,
    };
  }
}
