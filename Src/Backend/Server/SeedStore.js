// Sites de départ du mode serveur : chacun a sa profondeur, son nombre de pages maximal
// et peut être limité à son propre domaine.
import { normalizeUrl, hostOf } from '../Utils/Validator.js';

const stripWww = (h) => h.replace(/^www\./, '');

function fromRow(r) {
  return {
    id: r.id, url: r.url, host: r.host, maxDepth: r.max_depth, maxPages: r.max_pages,
    sameDomain: Boolean(r.same_domain), enabled: Boolean(r.enabled), indexed: r.indexed, createdAt: r.created_at,
  };
}

export class SeedStore {
  constructor(db, frontier) {
    this.db = db;
    this.frontier = frontier;
    this.cache = new Map();
    this.loadedAt = 0;
  }

  add(rawUrl, { maxDepth = 3, maxPages = 10000, sameDomain = true } = {}) {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error(`URL invalide : ${rawUrl}`);
    const existing = this.db.get('SELECT * FROM seeds WHERE url = ?', url);
    if (existing) {
      this.db.run('UPDATE seeds SET max_depth = ?, max_pages = ?, same_domain = ?, enabled = 1 WHERE id = ?', maxDepth, maxPages, sameDomain ? 1 : 0, existing.id);
      this.frontier.add(url, { depth: 0, seedId: existing.id });
      this.frontier.prioritize(url);
      this.reload();
      return { ...this.get(existing.id), created: false };
    }
    const id = Number(this.db.run(
      'INSERT INTO seeds (url, host, max_depth, max_pages, same_domain, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      url, hostOf(url), maxDepth, maxPages, sameDomain ? 1 : 0, Date.now(),
    ).lastInsertRowid);
    if (!this.frontier.add(url, { depth: 0, seedId: id })) this.frontier.prioritize(url);
    this.reload();
    return { ...this.get(id), created: true };
  }

  remove(id, { purge = false } = {}) {
    const seed = this.get(id);
    if (!seed) return null;
    const removedUrls = this.frontier.removeSeed(seed.id, { onlyPending: !purge });
    this.db.run('DELETE FROM seeds WHERE id = ?', seed.id);
    this.reload();
    return { seed, removedUrls };
  }

  setEnabled(id, enabled) {
    const changed = this.db.run('UPDATE seeds SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id).changes > 0;
    this.reload();
    return changed;
  }

  incrementIndexed(id) {
    if (id == null) return;
    this.db.run('UPDATE seeds SET indexed = indexed + 1 WHERE id = ?', id);
    const s = this.cache.get(id);
    if (s) s.indexed++;
  }

  list() {
    return this.db.all('SELECT * FROM seeds ORDER BY id').map(fromRow);
  }

  get(id) {
    const r = this.db.get('SELECT * FROM seeds WHERE id = ?', Number(id));
    return r ? fromRow(r) : null;
  }

  /** Version en mémoire, rechargée périodiquement (les commandes `webbrowser seeds` écrivent en base). */
  cached(id, maxAgeMs = 30_000) {
    if (Date.now() - this.loadedAt > maxAgeMs) this.reload();
    return this.cache.get(id) ?? null;
  }

  reload() {
    this.cache = new Map(this.list().map((s) => [s.id, s]));
    this.loadedAt = Date.now();
  }

  /** Le lien `url`, trouvé sur une page à la profondeur `depth`, doit-il être suivi pour ce site de départ ? */
  accepts(seed, url, depth) {
    if (!seed || !seed.enabled) return false;
    if (depth > seed.maxDepth) return false;
    if (seed.indexed >= seed.maxPages) return false;
    if (seed.sameDomain) {
      const h = stripWww(hostOf(url));
      const s = stripWww(seed.host);
      if (h !== s && !h.endsWith(`.${s}`)) return false;
    }
    return true;
  }
}
