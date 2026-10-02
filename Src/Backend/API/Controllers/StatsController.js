export class StatsController {
  constructor({ searchIndex, tor, jobs, version }) {
    this.searchIndex = searchIndex;
    this.tor = tor;
    this.jobs = jobs;
    this.version = version;
  }

  health = (ctx) => ctx.json({ ok: true, version: this.version });

  stats = async (ctx) => {
    ctx.json({
      index: this.searchIndex.stats(),
      tor: { address: this.tor.address, available: await this.tor.isAvailable(1500) },
      crawls: { running: this.jobs.running().length, total: this.jobs.list().length },
    });
  };
}
