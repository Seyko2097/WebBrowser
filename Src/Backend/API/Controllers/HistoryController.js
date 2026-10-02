import { toInt } from '../../Utils/Validator.js';
import { notFound } from './HttpErrors.js';

export class HistoryController {
  constructor({ history }) {
    this.history = history;
  }

  list = (ctx) => {
    const kind = ['visit', 'search'].includes(ctx.query.get('kind')) ? ctx.query.get('kind') : null;
    const limit = toInt(ctx.query.get('limit'), { min: 1, max: 1000, fallback: 100 });
    ctx.json({ entries: this.history.list({ kind, limit, filter: ctx.query.get('q') ?? '' }) });
  };

  remove = (ctx) => {
    if (!this.history.remove(Number(ctx.params.id))) throw notFound('entrée inconnue');
    ctx.json({ ok: true });
  };

  clear = (ctx) => {
    const kind = ['visit', 'search'].includes(ctx.query.get('kind')) ? ctx.query.get('kind') : null;
    ctx.json({ removed: this.history.clear(kind) });
  };
}
