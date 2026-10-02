// Évite de visiter deux fois la même URL et d'indexer deux fois le même contenu.
import crypto from 'node:crypto';

export class Deduplicator {
  constructor({ maxUrls = 1_000_000 } = {}) {
    this.maxUrls = maxUrls;
    this.urls = new Set();
    this.hashes = new Set();
  }

  static contentHash(text) {
    const normalized = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    return crypto.createHash('sha1').update(normalized).digest('hex');
  }

  hasUrl(url) {
    return this.urls.has(url);
  }

  /** Marque l'URL comme vue ; renvoie true si elle était nouvelle. */
  markUrl(url) {
    if (this.urls.has(url) || this.urls.size >= this.maxUrls) return false;
    this.urls.add(url);
    return true;
  }

  /** Renvoie { duplicate, hash } et mémorise l'empreinte du contenu. */
  markContent(text) {
    const hash = Deduplicator.contentHash(text);
    const duplicate = this.hashes.has(hash);
    this.hashes.add(hash);
    return { duplicate, hash };
  }

  get size() {
    return this.urls.size;
  }
}
