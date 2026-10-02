// Point d'assemblage du backend : crée tous les services à partir de la configuration.
import { EventEmitter } from 'node:events';
import { Config } from './Utils/Config.js';
import { Logger } from './Utils/Logger.js';
import { Database, HistoryStore } from './Storage/Database.js';
import { Cache } from './Storage/Cache.js';
import { HttpClient } from './Network/HttpClient.js';
import { Tor } from './Network/Tor.js';
import { Indexer } from './Crawler/Indexer/Indexer.js';
import { SearchIndex } from './Crawler/Indexer/SearchIndex.js';
import { WebCrawler } from './Crawler/Web-Crawler/WebCrawler.js';
import { OnionCrawler } from './Crawler/Onion-Crawler/OnionCrawler.js';
import { Browser } from './Browser/Browser.js';
import { isOnionUrl, normalizeUrl, withScheme } from './Utils/Validator.js';

/** Gestion des explorations lancées en arrière-plan (TUI et API). */
export class CrawlJobs extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.jobs = new Map();
    this.nextId = 1;
  }

  start({ urls, network = null, maxPages, maxDepth, sameDomain, concurrency, delayMs } = {}) {
    const seeds = (Array.isArray(urls) ? urls : [urls]).map((u) => normalizeUrl(withScheme(u))).filter(Boolean);
    if (!seeds.length) throw new Error('aucune URL valide à explorer');
    const net = network ?? (seeds.every(isOnionUrl) ? 'onion' : 'web');
    const crawler = this.app.createCrawler(net, { maxPages, maxDepth, sameDomain, concurrency, delayMs });
    const job = {
      id: String(this.nextId++), network: net, seeds, status: 'running', startedAt: Date.now(), finishedAt: null,
      stats: { indexed: 0, skipped: 0, errors: 0, discovered: 0, queued: 0 }, lastUrl: null, error: null,
      maxPages: crawler.maxPages, crawler,
    };
    this.jobs.set(job.id, job);
    crawler.on('progress', (p) => {
      job.stats = { indexed: p.indexed, skipped: p.skipped, errors: p.errors, discovered: p.discovered, queued: p.queued };
      job.lastUrl = p.url ?? job.lastUrl;
      this.emit('update', job);
    });
    crawler.on('page', (p) => this.emit('page', job, p));
    crawler.crawl(seeds).then(
      (result) => {
        job.status = result.stopped ? 'stopped' : 'done';
        job.stats = { ...job.stats, ...result };
      },
      (err) => {
        job.status = 'error';
        job.error = err.message;
        this.app.logger.warn('exploration en échec', { id: job.id, error: err.message });
      },
    ).finally(() => {
      job.finishedAt = Date.now();
      this.emit('update', job);
      this.emit('finished', job);
    });
    this.emit('update', job);
    return job;
  }

  stop(id) {
    const job = this.jobs.get(String(id));
    if (!job) return false;
    if (job.status === 'running') job.crawler.stop();
    return true;
  }

  stopAll() {
    for (const job of this.jobs.values()) if (job.status === 'running') job.crawler.stop();
  }

  running() {
    return [...this.jobs.values()].filter((j) => j.status === 'running');
  }

  get(id) {
    return this.jobs.get(String(id)) ?? null;
  }

  list() {
    return [...this.jobs.values()];
  }

  static toJSON(job) {
    const { crawler: _crawler, ...rest } = job;
    return rest;
  }
}

export class App {
  constructor({ config = new Config(), logger = null } = {}) {
    this.config = config;
    this.logger = logger ?? new Logger({
      level: config.get('log.level'), file: config.path('log.file'), console: config.get('log.console'),
    });
    this.db = new Database(config.path('database.file'));
    this.history = new HistoryStore(this.db);
    this.indexer = new Indexer(this.db, { logger: this.logger.child('indexer') });
    this.searchIndex = new SearchIndex(this.db);
    this.cache = new Cache({
      dir: config.path('paths.cache'), ttlMs: config.get('cache.ttlMs'),
      memoryItems: config.get('cache.memoryItems'), enabled: config.get('cache.enabled'),
    });
    this.tor = new Tor(config.get('tor'));
    this.client = this.createClient();
    this.torClient = new HttpClient({
      proxy: this.tor.proxyUrl, torSafe: true, timeoutMs: config.get('tor.timeoutMs'), maxBytes: config.get('network.maxBytes'),
      maxRedirects: config.get('network.maxRedirects'),
    });
    this.browser = new Browser({
      client: this.client, torClient: this.torClient, tor: this.tor, indexer: this.indexer, history: this.history,
      engine: config.get('browser.engine'), poolSize: config.get('browser.poolSize'),
      indexVisited: config.get('browser.indexVisited'), recordHistory: config.get('browser.recordHistory'),
      downloadsDir: config.path('paths.downloads'), logger: this.logger.child('browser'),
    });
    this.jobs = new CrawlJobs(this);
  }

  createClient() {
    const c = this.config;
    return new HttpClient({
      userAgent: c.get('network.userAgent'), acceptLanguage: c.get('network.acceptLanguage'),
      timeoutMs: c.get('network.timeoutMs'), maxBytes: c.get('network.maxBytes'),
      maxRedirects: c.get('network.maxRedirects'), proxy: c.get('network.proxy'), logger: this.logger.child('http'),
    });
  }

  /** Applique les réglages modifiables à chaud (navigateur). */
  refreshSettings() {
    this.browser.indexVisited = this.config.get('browser.indexVisited');
    this.browser.recordHistory = this.config.get('browser.recordHistory');
  }

  createCrawler(network = 'web', overrides = {}) {
    const c = this.config;
    const section = network === 'onion' ? 'onion' : 'crawler';
    const pick = (key) => overrides[key] ?? c.get(`${section}.${key}`) ?? c.get(`crawler.${key}`);
    const common = {
      indexer: this.indexer,
      maxPages: pick('maxPages'), maxDepth: pick('maxDepth'), concurrency: pick('concurrency'),
      delayMs: pick('delayMs'), sameDomain: pick('sameDomain'),
      respectRobots: overrides.respectRobots ?? c.get('crawler.respectRobots'),
      recrawlAfterMs: overrides.recrawlAfterMs ?? c.get('crawler.recrawlAfterMs'),
      maxBodyChars: c.get('crawler.maxBodyChars'),
      userAgent: c.get('network.userAgent'),
      logger: this.logger.child(`crawler:${network}`),
    };
    if (network === 'onion') {
      return new OnionCrawler({
        ...common, tor: this.tor, client: this.torClient, blocklistFile: c.path('onion.blocklistFile'),
      });
    }
    return new WebCrawler({
      ...common, client: this.createClient(),
      allowPrivateHosts: overrides.allowPrivateHosts ?? c.get('crawler.allowPrivateHosts'),
    });
  }

  async close() {
    this.jobs.stopAll();
    await this.browser.close();
    this.db.close();
    this.logger.close();
  }
}
