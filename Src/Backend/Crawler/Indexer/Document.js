// Document indexable : une page normalisée prête à être stockée.
import { Deduplicator } from '../Core/Deduplicator.js';

export class Document {
  constructor({
    url, title = '', description = '', keywords = [], body = '', lang = '', network = 'web',
    status = 200, fetchedAt = Date.now(), links = [], contentHash = null,
  }) {
    if (!url) throw new Error('Document : url manquante');
    this.url = url;
    this.title = String(title).replace(/\s+/g, ' ').trim().slice(0, 500);
    this.description = String(description).replace(/\s+/g, ' ').trim().slice(0, 1000);
    this.keywords = Array.isArray(keywords) ? keywords : String(keywords).split(',').map((k) => k.trim()).filter(Boolean);
    this.body = String(body);
    this.lang = lang;
    this.network = network;
    this.status = status;
    this.fetchedAt = fetchedAt;
    this.links = links;
    this.contentHash = contentHash ?? Deduplicator.contentHash(this.body);
  }

  static fromPage(page, { network = 'web', status = 200, maxBodyChars = 200_000, links } = {}) {
    return new Document({
      url: page.url,
      title: page.meta.title || page.url,
      description: page.meta.description,
      keywords: page.meta.keywords,
      body: page.doc.text.slice(0, maxBodyChars),
      lang: page.meta.lang,
      network,
      status,
      links: links ?? page.links.map((l) => l.url),
    });
  }

  static fromRow(row) {
    return new Document({
      url: row.url, title: row.title, description: row.description, keywords: row.keywords,
      body: row.body, lang: row.lang, network: row.network, status: row.status,
      fetchedAt: row.fetched_at, contentHash: row.content_hash,
    });
  }

  toRow() {
    return {
      url: this.url, title: this.title, description: this.description, keywords: this.keywords.join(', '),
      body: this.body, lang: this.lang, network: this.network, content_hash: this.contentHash,
      status: this.status, fetched_at: this.fetchedAt,
    };
  }

  toJSON() {
    const { links, ...rest } = this;
    return { ...rest, linkCount: links.length };
  }
}
