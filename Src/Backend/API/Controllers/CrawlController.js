import { CrawlJobs } from '../../App.js';
import { toInt } from '../../Utils/Validator.js';
import { badRequest, notFound } from './HttpErrors.js';

export class CrawlController {
  constructor({ jobs }) {
    this.jobs = jobs;
  }

  start = async (ctx) => {
    const body = await ctx.body();
    const urls = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
    if (!urls.length || urls.some((u) => typeof u !== 'string')) throw badRequest('« urls » doit être une liste d’URL');
    if (body.network && !['web', 'onion'].includes(body.network)) throw badRequest('« network » : web ou onion');
    let job;
    try {
      job = this.jobs.start({
        urls,
        network: body.network,
        maxPages: body.maxPages === undefined ? undefined : toInt(body.maxPages, { min: 1, max: 10000, fallback: 50 }),
        maxDepth: body.maxDepth === undefined ? undefined : toInt(body.maxDepth, { min: 0, max: 20, fallback: 2 }),
      });
    } catch (err) {
      throw badRequest(err.message);
    }
    ctx.json(CrawlJobs.toJSON(job), 202);
  };

  list = (ctx) => ctx.json({ jobs: this.jobs.list().map(CrawlJobs.toJSON) });

  get = (ctx) => {
    const job = this.jobs.get(ctx.params.id);
    if (!job) throw notFound('exploration inconnue');
    ctx.json(CrawlJobs.toJSON(job));
  };

  stop = (ctx) => {
    if (!this.jobs.stop(ctx.params.id)) throw notFound('exploration inconnue');
    ctx.json(CrawlJobs.toJSON(this.jobs.get(ctx.params.id)));
  };
}
