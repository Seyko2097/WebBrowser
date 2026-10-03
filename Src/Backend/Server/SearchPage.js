// Pages HTML publiques du serveur (rendues côté serveur, sans JavaScript).
import { HL_START, HL_END } from '../Crawler/Indexer/SearchIndex.js';

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Échappe l'extrait puis transforme les marqueurs de surlignage en <mark>. */
export function snippetHtml(snippet) {
  return escapeHtml(snippet).replaceAll(HL_START, '<mark>').replaceAll(HL_END, '</mark>');
}

const nf = new Intl.NumberFormat('fr-FR');

const STYLE = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--link:#1d4ed8;--url:#15803d;--line:#e7e5e4;--mark:#fef08a;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#f4f4f5;--muted:#a1a1aa;--link:#93c5fd;--url:#86efac;--line:#3f3f46;--mark:#854d0e;--accent:#5eead4}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}
.home{min-height:80vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}
.logo{font-size:2.2rem;font-weight:700;letter-spacing:-.02em;color:var(--fg);text-decoration:none}.logo span{color:var(--accent)}
form{display:flex;gap:8px;width:100%;margin:16px 0}
input[type=search]{flex:1;min-width:0;font:inherit;padding:10px 14px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--fg)}
input[type=search]:focus{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;padding:10px 18px;border:0;border-radius:999px;background:var(--accent);color:#fff;cursor:pointer}
header{display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--line);padding-bottom:8px;flex-wrap:wrap}header .logo{font-size:1.4rem}header form{flex:1;margin:8px 0;min-width:240px}
.meta{color:var(--muted);font-size:.9rem;margin:12px 0}
.r{margin:22px 0;overflow-wrap:anywhere}.r a{color:var(--link);font-size:1.15rem;text-decoration:none}.r a:hover{text-decoration:underline}
.r .u{color:var(--url);font-size:.85rem}.r p{margin:4px 0 0}mark{background:var(--mark);color:inherit;padding:0 1px}
nav.pages{display:flex;gap:12px;margin:24px 0}nav.pages a{color:var(--link)}
footer{color:var(--muted);font-size:.85rem;text-align:center;margin:32px 0}
`;

function layout(title, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function searchForm(q = '', autofocus = false) {
  return `<form action="/search" method="get" role="search"><input type="search" name="q" value="${escapeHtml(q)}" placeholder="Rechercher…" aria-label="Rechercher" maxlength="300"${autofocus ? ' autofocus' : ''}><button type="submit">Chercher</button></form>`;
}

export function homePage({ pages }) {
  return layout('WebBrowser — recherche', `<div class="home"><a class="logo" href="/">Web<span>Browser</span></a>
${searchForm('', true)}<p class="meta">${nf.format(pages)} pages indexées · <a href="/api">API</a></p></div>`);
}

export function resultsPage({ q, results, total, totalCapped, page, perPage, tookMs }) {
  const items = results.map((r) => `<div class="r"><a href="${escapeHtml(r.url)}" rel="noopener nofollow">${escapeHtml(r.title)}</a>
<div class="u">${escapeHtml(r.url)}</div><p>${snippetHtml(r.snippet || r.description || '')}</p></div>`).join('\n');
  const more = (page + 1) * perPage < total;
  const nav = [
    page > 0 ? `<a href="/search?q=${encodeURIComponent(q)}&amp;p=${page}">← Précédent</a>` : '',
    more ? `<a href="/search?q=${encodeURIComponent(q)}&amp;p=${page + 2}">Suivant →</a>` : '',
  ].filter(Boolean).join('');
  const count = total ? `${totalCapped ? 'Plus de ' : ''}${nf.format(total)} résultat${total > 1 ? 's' : ''}` : 'Aucun résultat';
  return layout(`${q} — WebBrowser`, `<header><a class="logo" href="/">Web<span>Browser</span></a>${searchForm(q)}</header>
<p class="meta">${count} · ${tookMs} ms${page ? ` · page ${page + 1}` : ''}</p>
${items || '<p>Essayez d’autres mots, moins de mots, ou retirez les guillemets.</p>'}
${nav ? `<nav class="pages">${nav}</nav>` : ''}`);
}
