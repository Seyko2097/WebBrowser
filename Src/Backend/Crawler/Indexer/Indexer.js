// Écriture dans l'index : insertion/mise à jour des pages et de leurs liens sortants.
export class Indexer {
  constructor(db, { logger = null } = {}) {
    this.db = db;
    this.logger = logger;
  }

  add(doc) {
    const row = doc.toRow();
    return this.db.transaction(() => {
      const { id } = this.db.get(
        `INSERT INTO pages (url, title, description, keywords, body, lang, network, content_hash, status, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title, description = excluded.description, keywords = excluded.keywords,
           body = excluded.body, lang = excluded.lang, network = excluded.network,
           content_hash = excluded.content_hash, status = excluded.status, fetched_at = excluded.fetched_at
         RETURNING id`,
        row.url, row.title, row.description, row.keywords, row.body, row.lang, row.network,
        row.content_hash, row.status, row.fetched_at,
      );
      this.db.run('DELETE FROM links WHERE from_id = ?', id);
      for (const to of new Set(doc.links)) {
        if (to !== doc.url) this.db.run('INSERT OR IGNORE INTO links (from_id, to_url) VALUES (?, ?)', id, to);
      }
      this.logger?.debug('page indexée', { url: doc.url });
      return id;
    });
  }

  addMany(docs) {
    return this.db.transaction(() => docs.map((d) => this.add(d)));
  }

  has(url) {
    return Boolean(this.db.get('SELECT 1 AS x FROM pages WHERE url = ?', url));
  }

  fetchedAt(url) {
    return this.db.get('SELECT fetched_at AS t FROM pages WHERE url = ?', url)?.t ?? null;
  }

  getLinks(url) {
    return this.db.all('SELECT l.to_url AS url FROM links l JOIN pages p ON p.id = l.from_id WHERE p.url = ?', url).map((r) => r.url);
  }

  /** Pages qui pointent vers `url`. */
  backlinks(url, limit = 50) {
    return this.db.all('SELECT p.url, p.title FROM links l JOIN pages p ON p.id = l.from_id WHERE l.to_url = ? LIMIT ?', url, limit);
  }

  remove(url) {
    return this.db.run('DELETE FROM pages WHERE url = ?', url).changes > 0;
  }

  clear(network = null) {
    const changes = network
      ? this.db.run('DELETE FROM pages WHERE network = ?', network).changes
      : this.db.run('DELETE FROM pages').changes;
    this.db.exec("INSERT INTO pages_fts(pages_fts) VALUES ('optimize')");
    return changes;
  }

  optimize() {
    this.db.exec("INSERT INTO pages_fts(pages_fts) VALUES ('optimize')");
  }
}
