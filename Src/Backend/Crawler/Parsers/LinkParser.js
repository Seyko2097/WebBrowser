// Résolution et filtrage des liens extraits par HtmlParser.
import { normalizeUrl } from '../../Utils/Validator.js';

export function effectiveBase(doc, pageUrl) {
  if (doc.baseHref) {
    const base = normalizeUrl(doc.baseHref, pageUrl);
    if (base) return base;
  }
  return pageUrl;
}

/**
 * Transforme les ancres en URL absolues normalisées, sans doublons.
 * Chaque lien garde `anchorIndexes` (les ancres qui y mènent) pour la numérotation dans le navigateur.
 */
export function resolveLinks(doc, pageUrl, { includeNofollow = true } = {}) {
  const base = effectiveBase(doc, pageUrl);
  const byUrl = new Map();
  doc.anchors.forEach((a, index) => {
    const href = (a.href ?? '').trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data|ftp|file|about|blob):/i.test(href)) return;
    const url = normalizeUrl(href, base);
    if (!url) return;
    const nofollow = /\b(nofollow|ugc|sponsored)\b/.test(a.rel);
    if (nofollow && !includeNofollow) return;
    let link = byUrl.get(url);
    if (!link) {
      link = { url, text: a.text || a.title || '', nofollow, anchorIndexes: [] };
      byUrl.set(url, link);
    } else if (!link.text && a.text) {
      link.text = a.text;
    }
    link.nofollow &&= nofollow;
    link.anchorIndexes.push(index);
  });
  return [...byUrl.values()];
}

/** URLs à suivre par le crawler (liens nofollow exclus). */
export function followableUrls(links) {
  return links.filter((l) => !l.nofollow).map((l) => l.url);
}

/** Liens <link rel="alternate|next|prev"> utiles pour la découverte. */
export function discoveryLinks(doc, pageUrl) {
  const base = effectiveBase(doc, pageUrl);
  const out = new Set();
  for (const tag of doc.linkTags) {
    const rel = (tag.rel ?? '').toLowerCase();
    if (/\b(next|prev|alternate)\b/.test(rel) && !tag.type) {
      const url = normalizeUrl(tag.href ?? '', base);
      if (url) out.add(url);
    }
  }
  return [...out];
}
