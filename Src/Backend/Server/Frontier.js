// File d'exploration persistante (SQLite) pour le mode serveur.
// Chaque URL reste en base : après succès elle est replanifiée (réexploration périodique),
// après erreur elle est retentée avec un délai croissant, puis abandonnée (« dead »).
// La table crawl_hosts indique quand chaque site a du travail prêt, pour répartir les requêtes entre sites.

const DAY = 24 * 3600_000;

export class Frontier {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
  }

  /** Ajoute une URL si elle est inconnue ; renvoie true si elle a été ajoutée. */
  add(url, { host, depth = 0, seedId = null, nextAt = this.now() } = {}) {
    const h = host ?? new URL(url).host;
    const { changes } = this.db.run(
      `INSERT OR IGNORE INTO frontier (url, host, seed_id, depth, next_at, added_at) VALUES (?, ?, ?, ?, ?, ?)`,
      url, h, seedId, depth, nextAt, this.now(),
    );
    if (changes) this.touchHost(h, nextAt);
    return changes > 0;
  }

  addMany(items) {
    return this.db.transaction(() => items.reduce((n, it) => n + (this.add(it.url, it) ? 1 : 0), 0));
  }

  touchHost(host, dueAt) {
    this.db.run(
      `INSERT INTO crawl_hosts (host, due_at) VALUES (?, ?)
       ON CONFLICT(host) DO UPDATE SET due_at = MIN(due_at, excluded.due_at)`,
      host, dueAt,
    );
  }

  /**
   * Réserve des URL prêtes : au plus `perHost` par site, sur au plus `hosts` sites.
   * Les URL réservées ne seront pas redistribuées avant `leaseMs` (protection en cas de plantage).
   */
  lease({ hosts = 50, perHost = 3, leaseMs = 10 * 60_000 } = {}) {
    const now = this.now();
    return this.db.transaction(() => {
      const tasks = [];
      const dueHosts = this.db.all('SELECT host FROM crawl_hosts WHERE due_at <= ? ORDER BY due_at LIMIT ?', now, hosts);
      for (const { host } of dueHosts) {
        const rows = this.db.all(
          `SELECT url, host, depth, seed_id AS seedId, indexed_at AS indexedAt FROM frontier
           WHERE host = ? AND status = 'queued' AND next_at <= ? AND (lease_until IS NULL OR lease_until < ?)
           ORDER BY depth, next_at LIMIT ?`,
          host, now, now, perHost,
        );
        for (const r of rows) {
          this.db.run('UPDATE frontier SET lease_until = ? WHERE url = ?', now + leaseMs, r.url);
          tasks.push(r);
        }
        // Prochaine date à laquelle ce site aura du travail disponible
        const { next } = this.db.get(
          `SELECT MIN(CASE WHEN lease_until > ? THEN lease_until ELSE next_at END) AS next
           FROM frontier WHERE host = ? AND status = 'queued'`,
          now, host,
        );
        if (next === null) this.db.run('DELETE FROM crawl_hosts WHERE host = ?', host);
        else this.db.run('UPDATE crawl_hosts SET due_at = ? WHERE host = ?', Math.max(next, now + (rows.length ? 5_000 : 0)), host);
      }
      return tasks;
    });
  }

  /**
   * Termine une URL. status 'queued' = replanifiée à nextAt, 'dead' = abandonnée.
   * Renvoie { firstIndex } : true si la page vient d'être indexée pour la première fois.
   */
  complete(url, { status = 'queued', nextAt = this.now() + 7 * DAY, indexed = false, lastStatus = null } = {}) {
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.db.get('SELECT host, indexed_at AS indexedAt FROM frontier WHERE url = ?', url);
      if (!row) return { firstIndex: false };
      this.db.run(
        `UPDATE frontier SET status = ?, next_at = ?, lease_until = NULL, attempts = 0, last_status = ?,
           indexed_at = CASE WHEN ? THEN COALESCE(indexed_at, ?) ELSE indexed_at END
         WHERE url = ?`,
        status, nextAt, lastStatus, indexed ? 1 : 0, now, url,
      );
      if (status === 'queued') this.touchHost(row.host, nextAt);
      return { firstIndex: indexed && !row.indexedAt };
    });
  }

  /** Erreur temporaire : nouvel essai dans 1 h, 2 h, 4 h… puis abandon après `maxAttempts`. */
  fail(url, { lastStatus = 'erreur', maxAttempts = 5 } = {}) {
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.db.get('SELECT host, attempts FROM frontier WHERE url = ?', url);
      if (!row) return 'unknown';
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        this.db.run(`UPDATE frontier SET status = 'dead', attempts = ?, lease_until = NULL, last_status = ? WHERE url = ?`, attempts, lastStatus, url);
        return 'dead';
      }
      const nextAt = now + Math.min(7 * DAY, 3600_000 * 2 ** (attempts - 1));
      this.db.run('UPDATE frontier SET attempts = ?, next_at = ?, lease_until = NULL, last_status = ? WHERE url = ?', attempts, nextAt, lastStatus, url);
      this.touchHost(row.host, nextAt);
      return 'retry';
    });
  }

  /** Libère les réservations (au démarrage : le processus précédent s'est arrêté). */
  releaseLeases() {
    return this.db.run('UPDATE frontier SET lease_until = NULL WHERE lease_until IS NOT NULL').changes;
  }

  /** Remet une URL en tête de file (réexploration demandée). */
  prioritize(url) {
    const row = this.db.get('SELECT host FROM frontier WHERE url = ?', url);
    if (!row) return false;
    const now = this.now();
    this.db.run(`UPDATE frontier SET status = 'queued', next_at = ?, attempts = 0 WHERE url = ?`, now, url);
    this.touchHost(row.host, now);
    return true;
  }

  removeSeed(seedId, { onlyPending = true } = {}) {
    return onlyPending
      ? this.db.run('DELETE FROM frontier WHERE seed_id = ? AND indexed_at IS NULL', seedId).changes
      : this.db.run('DELETE FROM frontier WHERE seed_id = ?', seedId).changes;
  }

  counts() {
    const now = this.now();
    const r = this.db.get(
      `SELECT COUNT(*) AS total,
         SUM(status = 'queued' AND indexed_at IS NULL AND last_status IS NULL) AS pending,
         SUM(status = 'queued' AND indexed_at IS NULL AND last_status IS NOT NULL AND attempts = 0) AS ignored,
         SUM(status = 'queued' AND attempts > 0) AS retrying,
         SUM(status = 'queued' AND next_at <= ?) AS due,
         SUM(status = 'dead') AS dead,
         SUM(lease_until > ?) AS leased,
         SUM(indexed_at IS NOT NULL) AS indexed
       FROM frontier`,
      now, now,
    );
    const { n: hosts } = this.db.get('SELECT COUNT(*) AS n FROM crawl_hosts');
    return {
      total: r.total, pending: r.pending ?? 0, ignored: r.ignored ?? 0, retrying: r.retrying ?? 0, due: r.due ?? 0, dead: r.dead ?? 0,
      leased: r.leased ?? 0, indexed: r.indexed ?? 0, hosts,
    };
  }

  /** Sites avec le plus d'URL connues. */
  topHosts(limit = 20) {
    return this.db.all(
      `SELECT host, COUNT(*) AS urls, SUM(indexed_at IS NOT NULL) AS indexed, SUM(status = 'dead') AS dead
       FROM frontier GROUP BY host ORDER BY urls DESC LIMIT ?`,
      limit,
    );
  }

  get(url) {
    return this.db.get('SELECT * FROM frontier WHERE url = ?', url) ?? null;
  }
}
