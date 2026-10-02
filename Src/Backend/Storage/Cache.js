// Cache à deux niveaux : mémoire (LRU) puis disque (fichiers JSON avec date d'expiration).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class Cache {
  constructor({ dir = null, ttlMs = 3600_000, memoryItems = 200, enabled = true } = {}) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.memoryItems = memoryItems;
    this.enabled = enabled;
    this.memory = new Map();
    if (dir && enabled) fs.mkdirSync(dir, { recursive: true });
  }

  static keyHash(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  fileFor(key) {
    const h = Cache.keyHash(key);
    return path.join(this.dir, h.slice(0, 2), `${h}.json`);
  }

  get(key) {
    if (!this.enabled) return undefined;
    const now = Date.now();
    const mem = this.memory.get(key);
    if (mem) {
      this.memory.delete(key);
      if (mem.expires > now) {
        this.memory.set(key, mem); // remonte en tête du LRU
        return mem.value;
      }
    }
    if (!this.dir) return undefined;
    const file = this.fileFor(key);
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (entry.key === key && entry.expires > now) {
        this.remember(key, entry);
        return entry.value;
      }
      fs.rmSync(file, { force: true });
    } catch {
      // absent ou illisible
    }
    return undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (!this.enabled) return;
    const entry = { key, value, expires: Date.now() + ttlMs };
    this.remember(key, entry);
    if (!this.dir) return;
    const file = this.fileFor(key);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, file);
    } catch {
      // le cache disque est facultatif
    }
  }

  remember(key, entry) {
    this.memory.set(key, entry);
    while (this.memory.size > this.memoryItems) this.memory.delete(this.memory.keys().next().value);
  }

  delete(key) {
    this.memory.delete(key);
    if (this.dir) fs.rmSync(this.fileFor(key), { force: true });
  }

  clear() {
    this.memory.clear();
    if (!this.dir) return;
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (entry.isDirectory()) fs.rmSync(path.join(this.dir, entry.name), { recursive: true, force: true });
    }
  }

  /** Supprime les fichiers expirés ; renvoie le nombre de fichiers retirés. */
  prune() {
    if (!this.dir) return 0;
    let removed = 0;
    const now = Date.now();
    for (const sub of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const subdir = path.join(this.dir, sub.name);
      for (const name of fs.readdirSync(subdir)) {
        const file = path.join(subdir, name);
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).expires > now) continue;
        } catch {
          // fichier corrompu : supprimé
        }
        fs.rmSync(file, { force: true });
        removed++;
      }
    }
    return removed;
  }
}
