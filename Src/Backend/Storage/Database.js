// Base SQLite (module natif node:sqlite) : schéma de l'index plein texte, des liens et de l'historique.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Charge node:sqlite sans afficher l'avertissement « ExperimentalWarning » (Node 22). */
function loadSqlite() {
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    if (String(warning?.message ?? warning).includes('SQLite')) return undefined;
    return original.call(process, warning, ...args);
  };
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

const { DatabaseSync } = loadSqlite();

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '',
  network TEXT NOT NULL DEFAULT 'web',
  content_hash TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 200,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_network ON pages(network);
CREATE INDEX IF NOT EXISTS pages_hash ON pages(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, description, keywords, body, url,
  content='pages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, description, keywords, body, url)
  VALUES (new.id, new.title, new.description, new.keywords, new.body, new.url);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, description, keywords, body, url)
  VALUES ('delete', old.id, old.title, old.description, old.keywords, old.body, old.url);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, description, keywords, body, url)
  VALUES ('delete', old.id, old.title, old.description, old.keywords, old.body, old.url);
  INSERT INTO pages_fts(rowid, title, description, keywords, body, url)
  VALUES (new.id, new.title, new.description, new.keywords, new.body, new.url);
END;

CREATE TABLE IF NOT EXISTS links (
  from_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_url TEXT NOT NULL,
  PRIMARY KEY (from_id, to_url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS links_to ON links(to_url);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('visit', 'search')),
  value TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_created ON history(created_at);
`;

export class Database {
  constructor(file = ':memory:') {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.statements = new Map();
    this.db.exec('PRAGMA foreign_keys = ON');
    if (file !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
    }
    this.migrate();
  }

  migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get();
    if (version > SCHEMA_VERSION) {
      throw new Error(`index créé par une version plus récente de WebBrowser (schéma ${version})`);
    }
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  exec(sql) {
    this.db.exec(sql);
  }

  prepare(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  /** Exécute fn dans une transaction (imbrications gérées par SAVEPOINT). */
  transaction(fn) {
    this.depth = (this.depth ?? 0) + 1;
    const name = `sp${this.depth}`;
    this.db.exec(this.depth === 1 ? 'BEGIN' : `SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.exec(this.depth === 1 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (err) {
      this.db.exec(this.depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
      throw err;
    } finally {
      this.depth -= 1;
    }
  }

  close() {
    if (!this.db.isOpen) return;
    this.statements.clear();
    this.db.close();
  }
}

/** Historique de navigation et de recherche. */
export class HistoryStore {
  constructor(db) {
    this.db = db;
  }

  add(kind, value, title = '') {
    const now = Date.now();
    // Évite les doublons immédiats (rechargement, même recherche répétée)
    const last = this.db.get('SELECT id, kind, value FROM history ORDER BY id DESC LIMIT 1');
    if (last && last.kind === kind && last.value === value) {
      this.db.run('UPDATE history SET created_at = ?, title = COALESCE(NULLIF(?, \'\'), title) WHERE id = ?', now, title, last.id);
      return last.id;
    }
    return Number(this.db.run('INSERT INTO history(kind, value, title, created_at) VALUES (?, ?, ?, ?)', kind, value, title, now).lastInsertRowid);
  }

  addVisit(url, title) {
    return this.add('visit', url, title);
  }

  addSearch(query) {
    const q = String(query ?? '').trim();
    return q ? this.add('search', q) : null;
  }

  list({ kind = null, limit = 200, offset = 0, filter = '' } = {}) {
    const where = [];
    const params = [];
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (filter) {
      where.push('(value LIKE ? OR title LIKE ?)');
      params.push(`%${filter}%`, `%${filter}%`);
    }
    const sql = `SELECT id, kind, value, title, created_at AS createdAt FROM history
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    return this.db.all(sql, ...params, limit, offset);
  }

  remove(id) {
    return this.db.run('DELETE FROM history WHERE id = ?', id).changes > 0;
  }

  clear(kind = null) {
    return kind ? this.db.run('DELETE FROM history WHERE kind = ?', kind).changes : this.db.run('DELETE FROM history').changes;
  }

  count() {
    return this.db.get('SELECT COUNT(*) AS n FROM history').n;
  }
}
