// Robot d'exploration continu du mode serveur : lit la file persistante (Frontier), respecte
// la politesse par site (Scheduler + robots.txt), indexe, ajoute les nouveaux liens et replanifie.
// Il tourne jusqu'à stop() et reprend là où il en était après un redémarrage.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { Scheduler } from '../Crawler/Core/Scheduler.js';
import { Worker } from '../Crawler/Core/Worker.js';
import { RobotsCache } from '../Crawler/Parsers/RobotsParser.js';
import { normalizeUrl } from '../Utils/Validator.js';

const DAY = 24 * 3600_000;

export class CrawlerDaemon extends EventEmitter {
  constructor({
    db, frontier, seeds, indexer, client, validator, logger = null,
    concurrency = 16, hostDelayMs = 1000, recrawlAfterDays = 7, maxLinksPerPage = 300,
    maxPages = 5_000_000, maxFrontier = 50_000_000, maxDbSizeMB = 100_000, dbFile = null,
    userAgent = 'WebBrowserBot', maxBodyChars = 200_000, respectRobots = true,
  }) {
    super();
    Object.assign(this, { db, frontier, seeds, indexer, client, validator, logger });
    this.concurrency = concurrency;
    this.recrawlMs = recrawlAfterDays * DAY;
    this.maxLinksPerPage = maxLinksPerPage;
    this.limits = { maxPages, maxFrontier, maxDbSizeMB };
    this.dbFile = dbFile;
    this.scheduler = new Scheduler({ delayMs: hostDelayMs });
    this.robots = respectRobots ? new RobotsCache({
      userAgent,
      fetcher: async (url) => {
        const res = await client.get(url, { accept: 'text/plain,*/*', noCache: true, maxBytes: 512 * 1024 });
        return { status: res.status, text: res.text() };
      },
    }) : null;
    this.worker = new Worker({ client, robots: this.robots, network: 'web', maxBodyChars });
    this.running = false;
    this.paused = false;
    this.stopping = false;
    this.active = new Set();
    this.wake = null;
    this.startedAt = null;
    this.stats = { fetched: 0, indexed: 0, newPages: 0, errors: 0, skipped: 0, discovered: 0 };
    this.recent = []; // horodatages des dernières pages traitées (débit)
    this.capacity = { canGrow: true, reason: null, checkedAt: 0, pages: 0, frontier: 0, dbMB: 0 };
  }

  // ---------------------------------------------------------------- cycle de vie

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.startedAt = Date.now();
    const released = this.frontier.releaseLeases();
    this.seeds.reload();
    this.checkCapacity(true);
    this.logger?.info('robot démarré', { released, concurrency: this.concurrency });
    this.loopPromise = this.loop().catch((err) => {
      this.logger?.error('boucle du robot arrêtée', { error: err.stack });
      this.emit('error', err);
    });
  }

  async stop({ timeoutMs = 20_000 } = {}) {
    if (!this.running) return;
    this.stopping = true;
    this.signal();
    const timer = new Promise((r) => setTimeout(r, timeoutMs).unref());
    await Promise.race([this.loopPromise, timer]);
    this.running = false;
    this.frontier.releaseLeases();
    this.logger?.info('robot arrêté', this.stats);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.signal();
  }

  signal() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, Math.max(5, ms));
      this.wake = () => { clearTimeout(t); resolve(); };
    });
  }

  // ---------------------------------------------------------------- boucle

  async loop() {
    let lastRefill = 0;
    let lastPrune = Date.now();
    while (!this.stopping) {
      if (this.paused) {
        await this.sleep(1000);
        continue;
      }
      const now = Date.now();
      if (this.scheduler.size < this.concurrency * 4 && now - lastRefill > 1000) {
        lastRefill = now;
        this.refill();
      }
      if (now - lastPrune > 60_000) {
        lastPrune = now;
        this.scheduler.prune();
        this.checkCapacity();
      }
      if (this.active.size >= this.concurrency) {
        await this.sleep(1000);
        continue;
      }
      const next = this.scheduler.next();
      if (!next) {
        await this.sleep(this.active.size ? 1000 : 2000);
        continue;
      }
      if (!next.task) {
        await this.sleep(Math.min(next.waitMs, 1000));
        continue;
      }
      const p = this.runTask(next.task).finally(() => {
        this.active.delete(p);
        this.scheduler.done(next.task);
        this.signal();
      });
      this.active.add(p);
    }
    await Promise.allSettled(this.active);
  }

  refill() {
    const tasks = this.frontier.lease({ hosts: Math.max(20, this.concurrency * 4), perHost: 3 });
    for (const t of tasks) this.scheduler.add(t);
    return tasks.length;
  }

  // ---------------------------------------------------------------- traitement d'une URL

  async runTask(task) {
    const { url, depth, seedId } = task;
    try {
      const verdict = await this.validator.check(url);
      if (!verdict.ok) {
        this.frontier.complete(url, { status: 'dead', lastStatus: verdict.reason });
        this.stats.skipped++;
        return;
      }
      if (this.robots) {
        const delay = await this.robots.crawlDelay(url).catch(() => null);
        this.scheduler.setCrawlDelay(new URL(url).host, delay);
      }
      const result = await this.worker.process(task);
      this.stats.fetched++;
      this.tick();

      if (result.status === 'indexed') {
        const doc = result.document;
        const dup = this.db.get('SELECT url FROM pages WHERE content_hash = ? AND url <> ? LIMIT 1', doc.contentHash, doc.url);
        if (dup) {
          this.frontier.complete(url, { nextAt: Date.now() + this.recrawlMs * 4, lastStatus: `doublon de ${dup.url}` });
          this.stats.skipped++;
        } else {
          this.indexer.add(doc);
          this.stats.indexed++;
          const { firstIndex } = this.frontier.complete(url, { nextAt: Date.now() + this.recrawlMs, indexed: true, lastStatus: String(result.httpStatus ?? 200) });
          if (firstIndex) {
            this.stats.newPages++;
            this.seeds.incrementIndexed(seedId);
          }
          this.emit('page', { url: doc.url, title: doc.title, depth, firstIndex });
        }
        if (result.finalUrl && result.finalUrl !== url) {
          this.frontier.add(result.finalUrl, { depth, seedId, nextAt: Date.now() + this.recrawlMs });
        }
      } else if (result.status === 'skipped') {
        // robots.txt, noindex, type de contenu… : on revérifie dans un mois, et on retire de l'index
        this.indexer.remove(url);
        this.frontier.complete(url, { nextAt: Date.now() + 30 * DAY, lastStatus: result.reason });
        this.stats.skipped++;
      } else if (result.httpStatus === 404 || result.httpStatus === 410) {
        this.indexer.remove(url);
        this.frontier.complete(url, { status: 'dead', lastStatus: `HTTP ${result.httpStatus}` });
        this.stats.errors++;
      } else {
        this.frontier.fail(url, { lastStatus: result.reason });
        this.stats.errors++;
      }

      if (result.links?.length) this.enqueueLinks(result.links, { depth: depth + 1, seedId });
    } catch (err) {
      this.stats.errors++;
      this.logger?.warn('échec du traitement', { url, error: err.message });
      try {
        this.frontier.fail(url, { lastStatus: err.message });
      } catch {
        // base indisponible : la réservation expirera
      }
    }
  }

  enqueueLinks(links, { depth, seedId }) {
    if (!this.capacity.canGrow) return 0;
    const seed = this.seeds.cached(seedId);
    if (!seed) return 0;
    const items = [];
    for (const raw of links.slice(0, this.maxLinksPerPage)) {
      const url = normalizeUrl(raw);
      if (!url || !this.seeds.accepts(seed, url, depth)) continue;
      if (!this.validator.accepts(url).ok) continue;
      items.push({ url, depth, seedId });
    }
    if (!items.length) return 0;
    const added = this.frontier.addMany(items);
    this.stats.discovered += added;
    return added;
  }

  // ---------------------------------------------------------------- limites et statistiques

  /** Bloque la découverte de nouvelles URL si l'index, la file ou le disque atteignent leur limite. */
  checkCapacity(force = false) {
    const now = Date.now();
    if (!force && now - this.capacity.checkedAt < 60_000) return this.capacity;
    const pages = this.db.get('SELECT COUNT(*) AS n FROM pages').n;
    const frontier = this.db.get('SELECT COUNT(*) AS n FROM frontier').n;
    let dbMB = 0;
    if (this.dbFile) {
      for (const f of [this.dbFile, `${this.dbFile}-wal`]) {
        try {
          dbMB += fs.statSync(f).size / 1024 / 1024;
        } catch {
          // fichier absent
        }
      }
    }
    let reason = null;
    if (pages >= this.limits.maxPages) reason = `limite de ${this.limits.maxPages} pages atteinte`;
    else if (frontier >= this.limits.maxFrontier) reason = `file d'exploration pleine (${frontier} URL)`;
    else if (dbMB >= this.limits.maxDbSizeMB) reason = `base de données trop grosse (${Math.round(dbMB)} Mo)`;
    if (reason && reason !== this.capacity.reason) this.logger?.warn(`découverte suspendue : ${reason}`);
    this.capacity = { canGrow: !reason, reason, checkedAt: now, pages, frontier, dbMB: Math.round(dbMB) };
    return this.capacity;
  }

  tick() {
    const now = Date.now();
    this.recent.push(now);
    while (this.recent.length && this.recent[0] < now - 60_000) this.recent.shift();
  }

  status() {
    return {
      running: this.running && !this.stopping,
      paused: this.paused,
      startedAt: this.startedAt,
      active: this.active.size,
      queuedInMemory: this.scheduler.size,
      pagesPerMinute: this.recent.filter((t) => t > Date.now() - 60_000).length,
      stats: { ...this.stats },
      capacity: { ...this.capacity },
    };
  }
}
