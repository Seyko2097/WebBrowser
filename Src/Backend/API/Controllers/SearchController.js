import { toInt } from '../../Utils/Validator.js';
import { HL_START, HL_END } from '../../Crawler/Indexer/SearchIndex.js';
import { badRequest, notFound } from './HttpErrors.js';

const highlight = (s) => s.replaceAll(HL_START, '<mark>').replaceAll(HL_END, '</mark>');
const plain = (s) => s.replaceAll(HL_START, '').replaceAll(HL_END, '');

export class SearchController {
  constructor({ searchIndex, history = null }) {
    this.searchIndex = searchIndex;
    this.history = history;
  }

  search = (ctx) => {
    const q = (ctx.query.get('q') ?? '').trim();
    if (!q) throw badRequest('paramètre « q » manquant');
    const limit = toInt(ctx.query.get('limit'), { min: 1, max: 100, fallback: 20 });
    const offset = toInt(ctx.query.get('offset'), { min: 0, fallback: 0 });
    const network = ['web', 'onion'].includes(ctx.query.get('network')) ? ctx.query.get('network') : null;
    const { results, total } = this.searchIndex.search(q, { limit, offset, network });
    if (ctx.query.get('record') === '1') this.history?.addSearch(q);
    const html = ctx.query.get('highlight') === 'html';
    ctx.json({
      query: q, total, limit, offset,
      results: results.map((r) => ({ ...r, snippet: html ? highlight(r.snippet) : plain(r.snippet) })),
    });
  };

  document = (ctx) => {
    const url = ctx.query.get('url');
    if (!url) throw badRequest('paramètre « url » manquant');
    const doc = this.searchIndex.get(url);
    if (!doc) throw notFound('document absent de l’index');
    ctx.json(doc);
  };
}
