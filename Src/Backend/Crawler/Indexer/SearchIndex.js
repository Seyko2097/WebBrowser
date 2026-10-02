// Recherche plein texte (SQLite FTS5, classement BM25) avec extraits surlignés.
import { Document } from './Document.js';

// Marqueurs de surlignage dans les extraits (caractères de contrôle absents du texte indexé)
export const HL_START = '\u0003';
export const HL_END = '\u0004';

/**
 * Transforme une saisie libre en requête FTS5 sûre :
 *  - "une phrase" → expression exacte ; -mot → exclusion ; site:exemple.fr → filtre d'hôte ;
 *  - le dernier mot est cherché en préfixe (recherche instantanée).
 * Renvoie { match, site } (match vide si rien à chercher).
 */
export function buildFtsQuery(query) {
  let q = String(query ?? '');
  let site = null;
  q = q.replace(/(^|\s)site:(\S+)/gi, (_, sp, host) => {
    site = host.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return sp;
  });
  const positive = [];
  const negative = [];
  for (const [, phrase] of q.matchAll(/"([^"]+)"/g)) {
    const words = phrase.match(/[\p{L}\p{N}_]+/gu);
    if (words) positive.push(`"${words.join(' ')}"`);
  }
  const rest = q.replace(/"[^"]*"?/g, ' ');
  const tokens = rest.match(/-?[\p{L}\p{N}_]+/gu) ?? [];
  const endsWithSpace = /[\s"]$/.test(q);
  tokens.forEach((tok, i) => {
    if (tok.startsWith('-')) {
      if (tok.length > 1) negative.push(`"${tok.slice(1)}"`);
      return;
    }
    const prefix = i === tokens.length - 1 && !endsWithSpace;
    positive.push(`"${tok}"${prefix ? '*' : ''}`);
  });
  if (!positive.length) return { match: '', site };
  let match = positive.join(' AND ');
  for (const neg of negative) match += ` NOT ${neg}`;
  return { match, site };
}

export class SearchIndex {
  constructor(db) {
    this.db = db;
  }

  /**
   * @returns {{results: Array<{url, title, snippet, description, network, fetchedAt, score}>, total: number}}
   */
  search(query, { limit = 20, offset = 0, network = null } = {}) {
    const { match, site } = buildFtsQuery(query);
    if (!match) return { results: [], total: 0 };
    const where = ['pages_fts MATCH ?'];
    const params = [match];
    if (network) {
      where.push('p.network = ?');
      params.push(network);
    }
    if (site) {
      where.push("(p.url LIKE ? OR p.url LIKE ?)");
      params.push(`%://${site}/%`, `%.${site}/%`);
    }
    const from = `FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid WHERE ${where.join(' AND ')}`;
    try {
      const { n: total } = this.db.get(`SELECT COUNT(*) AS n ${from}`, ...params);
      const rows = this.db.all(
        `SELECT p.url, p.title, p.description, p.network, p.fetched_at AS fetchedAt,
                snippet(pages_fts, 3, '${HL_START}', '${HL_END}', ' … ', 28) AS snippet,
                bm25(pages_fts, 10.0, 4.0, 3.0, 1.0, 2.0) AS rank
         ${from} ORDER BY rank LIMIT ? OFFSET ?`,
        ...params, limit, offset,
      );
      const results = rows.map((r) => {
        let snippet = r.snippet.replace(/\s+/g, ' ').trim();
        // Si le corps ne contient pas les termes (trouvés dans le titre), on montre la description
        if (!snippet.includes(HL_START) && r.description) snippet = r.description;
        return {
          url: r.url, title: r.title || r.url, snippet, description: r.description,
          network: r.network, fetchedAt: r.fetchedAt, score: -r.rank,
        };
      });
      return { results, total };
    } catch (err) {
      if (/fts5|syntax/i.test(err.message)) return { results: [], total: 0 };
      throw err;
    }
  }

  get(url) {
    const row = this.db.get('SELECT * FROM pages WHERE url = ?', url);
    return row ? Document.fromRow(row) : null;
  }

  count({ network = null } = {}) {
    return network
      ? this.db.get('SELECT COUNT(*) AS n FROM pages WHERE network = ?', network).n
      : this.db.get('SELECT COUNT(*) AS n FROM pages').n;
  }

  stats() {
    const rows = this.db.all('SELECT network, COUNT(*) AS n, MAX(fetched_at) AS last FROM pages GROUP BY network');
    const byNetwork = Object.fromEntries(rows.map((r) => [r.network, r.n]));
    const hosts = this.db.get(`SELECT COUNT(DISTINCT substr(url, instr(url, '://') + 3,
      instr(substr(url, instr(url, '://') + 3) || '/', '/') - 1)) AS n FROM pages`).n;
    return {
      total: rows.reduce((s, r) => s + r.n, 0),
      web: byNetwork.web ?? 0,
      onion: byNetwork.onion ?? 0,
      hosts,
      links: this.db.get('SELECT COUNT(*) AS n FROM links').n,
      lastFetchedAt: rows.reduce((m, r) => Math.max(m, r.last ?? 0), 0) || null,
    };
  }

  /** Pages récemment indexées. */
  recent({ limit = 20, network = null } = {}) {
    const rows = network
      ? this.db.all('SELECT url, title, network, fetched_at AS fetchedAt FROM pages WHERE network = ? ORDER BY fetched_at DESC LIMIT ?', network, limit)
      : this.db.all('SELECT url, title, network, fetched_at AS fetchedAt FROM pages ORDER BY fetched_at DESC LIMIT ?', limit);
    return rows;
  }
}
