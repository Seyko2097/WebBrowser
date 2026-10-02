// Métadonnées d'une page : titre, description, mots-clés, URL canonique, directives robots, langue.
import { normalizeUrl } from '../../Utils/Validator.js';

/** "noindex, nofollow" → { noindex: true, nofollow: true, ... } */
export function parseRobotsDirectives(value) {
  const tokens = String(value ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const has = (t) => tokens.includes(t);
  return {
    noindex: has('noindex') || has('none'),
    nofollow: has('nofollow') || has('none'),
    noarchive: has('noarchive'),
  };
}

export function mergeRobots(...directives) {
  return directives.filter(Boolean).reduce(
    (acc, d) => ({ noindex: acc.noindex || d.noindex, nofollow: acc.nofollow || d.nofollow, noarchive: acc.noarchive || d.noarchive }),
    { noindex: false, nofollow: false, noarchive: false },
  );
}

export function parseMetadata(doc, pageUrl) {
  const byName = {};
  const byProperty = {};
  let charset = null;
  let contentLanguage = '';
  let refresh = null;
  for (const m of doc.metas) {
    const content = (m.content ?? '').trim();
    if (m.charset) charset = m.charset.toLowerCase();
    if (m.name) byName[m.name.toLowerCase()] ??= content;
    if (m.property) byProperty[m.property.toLowerCase()] ??= content;
    const equiv = (m['http-equiv'] ?? '').toLowerCase();
    if (equiv === 'content-language') contentLanguage = content;
    if (equiv === 'refresh') {
      const r = /url\s*=\s*['"]?([^'"]+)/i.exec(content);
      if (r) refresh = normalizeUrl(r[1], pageUrl);
    }
  }

  let canonical = null;
  for (const l of doc.linkTags) {
    if (/\bcanonical\b/i.test(l.rel ?? '') && l.href) {
      canonical = normalizeUrl(l.href, pageUrl);
      break;
    }
  }

  const h1 = doc.headings.find((h) => h.level === 1)?.text ?? '';
  const title = doc.title || byProperty['og:title'] || byName['twitter:title'] || h1 || '';
  const description = byName.description || byProperty['og:description'] || byName['twitter:description'] || '';
  const keywords = (byName.keywords ?? '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 30);
  const robots = mergeRobots(parseRobotsDirectives(byName.robots), parseRobotsDirectives(byName.webbrowser));

  return {
    title: title.slice(0, 500),
    description: description.slice(0, 1000),
    keywords,
    canonical,
    robots,
    lang: (doc.lang || contentLanguage || byProperty['og:locale'] || '').split(/[,;]/)[0].trim().toLowerCase(),
    author: byName.author ?? '',
    siteName: byProperty['og:site_name'] ?? '',
    image: byProperty['og:image'] ? normalizeUrl(byProperty['og:image'], pageUrl) : null,
    publishedTime: byProperty['article:published_time'] ?? '',
    charset,
    refresh,
  };
}
