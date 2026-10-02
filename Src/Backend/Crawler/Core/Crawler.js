// Orchestrateur générique : file d'attente, déduplication, ordonnancement poli, workers en parallèle.
// Les sous-classes (WebCrawler, OnionCrawler) fournissent le client réseau, le validateur et l'analyseur.
import { EventEmitter } from 'node:events';
import { Deduplicator } from './Deduplicator.js';
import { Scheduler } from './Scheduler.js';
import { Worker } from './Worker.js';
import { RobotsCache } from '../Parsers/RobotsParser.js';
import { parsePage } from '../Parsers/HtmlParser.js';
import { normalizeUrl, hostOf } from '../../Utils/Validator.js';

const stripWww = (host) => host.replace(/^www\./, '');

export class Crawler extends EventEmitter {
  constructor({
    client, validator, indexer = null, network = 'web', parse = parsePage,
    maxPages = 100, maxDepth = 3, concurrency = 4, delayMs = 500, sameDomain = true,
    respectRobots = true, recrawlAfterMs = 24 * 3600_000, maxBodyChars = 200_000,
    userAgent = 'WebBrowser', logger = null,
  } = {}) {
    super();
    if (!client) throw new Error('Crawler : client HTTP manquant');
    if (!validator) throw new Error('Crawler : validateur manquant');
    this.client = client;
    this.validator = validator;
    this.indexer = indexer;
    this.network = network;
    this.maxPages = maxPages;
    this.maxDepth = maxDepth;
    this.concurrency = Math.max(1, concurrency);
    this.sameDomain = sameDomain;
    this.recrawlAfterMs = recrawlAfterMs;
    this.logger = logger;
    this.scheduler = new Scheduler({ delayMs });
    this.dedup = new Deduplicator();
    this.robots = respectRobots ? new RobotsCache({
      userAgent,
      fetcher: async (url) => {
        const res = await client.get(url, { accept: 'text/plain,*/*', noCache: true, maxBytes: 512 * 1024 });
        return { status: res.status, text: res.text() };
      },
    }) : null;
    this.worker = new Worker({ client, robots: this.robots, parse, network, maxBodyChars, logger });
    this.stopped = false;
    this.running = false;
    this.stats = { indexed: 0, skipped: 0, errors: 0, discovered: 0, reused: 0 };
    this.allowedHosts = new Set();
    this.wake = null;
  }

  stop() {
    this.stopped = true;
    this.scheduler.clear();
    this.signal();
  }

  signal() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  waitForSignal(ms) {
    return new Promise((resolve) => {
      const timer = Number.isFinite(ms) ? setTimeout(() => { this.wake = null; resolve(); }, Math.max(ms, 5)) : null;
      this.wake = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
    });
  }

  progress(extra = {}) {
    this.emit('progress', { ...this.stats, queued: this.scheduler.size, active: this.scheduler.inFlight, ...extra });
  }

  /** Ajoute une URL à la file si elle est nouvelle et acceptable. */
  enqueue(rawUrl, depth, from = null) {
    const url = normalizeUrl(rawUrl);
    if (!url || this.stopped) return false;
    if (depth > this.maxDepth) return false;
    if (this.sameDomain && depth > 0 && !this.allowedHosts.has(stripWww(hostOf(url)))) return false;
    const verdict = this.validator.accepts(url);
    if (!verdict.ok) return false;
    if (!this.dedup.markUrl(url)) return false;
    this.scheduler.add({ url, depth, from });
    this.stats.discovered++;
    return true;
  }

  async crawl(seeds) {
    if (this.running) throw new Error('exploration déjà en cours');
    this.running = true;
    const started = Date.now();
    const list = (Array.isArray(seeds) ? seeds : [seeds]).map((s) => normalizeUrl(s)).filter(Boolean);
    for (const url of list) {
      const verdict = this.validator.accepts(url);
      if (!verdict.ok) {
        this.emit('skip', { url, reason: verdict.reason });
        continue;
      }
      this.allowedHosts.add(stripWww(hostOf(url)));
      this.enqueue(url, 0);
    }
    this.emit('start', { seeds: list });

    const active = new Set();
    try {
      while (!this.stopped) {
        if (this.stats.indexed + active.size >= this.maxPages) {
          if (!active.size) break;
          await this.waitForSignal(Infinity);
          continue;
        }
        if (active.size >= this.concurrency) {
          await this.waitForSignal(Infinity);
          continue;
        }
        const next = this.scheduler.next();
        if (next === null) {
          if (!active.size) break;
          await this.waitForSignal(Infinity);
          continue;
        }
        if (!next.task) {
          await this.waitForSignal(next.waitMs);
          continue;
        }
        const promise = this.runTask(next.task).finally(() => {
          active.delete(promise);
          this.scheduler.done(next.task);
          this.signal();
        });
        active.add(promise);
      }
      await Promise.allSettled(active);
    } finally {
      this.running = false;
    }
    const result = { ...this.stats, durationMs: Date.now() - started, stopped: this.stopped };
    this.emit('done', result);
    return result;
  }

  async runTask(task) {
    const { url, depth } = task;
    try {
      const verdict = await this.validator.check(url);
      if (!verdict.ok) {
        this.stats.skipped++;
        this.emit('skip', { url, depth, reason: verdict.reason });
        return;
      }
      // Page déjà indexée récemment : on réutilise ses liens sans la retélécharger
      if (this.indexer) {
        const fetchedAt = this.indexer.fetchedAt(url);
        if (fetchedAt && Date.now() - fetchedAt < this.recrawlAfterMs) {
          this.stats.reused++;
          for (const link of this.indexer.getLinks(url)) this.enqueue(link, depth + 1, url);
          this.emit('skip', { url, depth, reason: 'déjà indexée récemment' });
          this.progress({ url });
          return;
        }
      }
      if (this.robots) {
        const delay = await this.robots.crawlDelay(url).catch(() => null);
        this.scheduler.setCrawlDelay(new URL(url).host, delay);
      }
      const result = await this.worker.process(task);
      if (this.stopped && result.status !== 'indexed') return;
      if (result.finalUrl && result.finalUrl !== url) this.dedup.markUrl(result.finalUrl);
      for (const link of result.links) this.enqueue(link, depth + 1, url);

      if (result.status === 'indexed') {
        const { duplicate } = this.dedup.markContent(result.document.body);
        if (duplicate) {
          this.stats.skipped++;
          this.emit('skip', { url, depth, reason: 'contenu en double' });
        } else if (this.stats.indexed < this.maxPages) {
          this.indexer?.add(result.document);
          this.stats.indexed++;
          this.emit('page', { url: result.document.url, title: result.document.title, depth, document: result.document });
        }
      } else if (result.status === 'skipped') {
        this.stats.skipped++;
        this.emit('skip', { url, depth, reason: result.reason });
      } else {
        this.stats.errors++;
        this.emit('fetch-error', { url, depth, reason: result.reason });
      }
    } catch (err) {
      this.stats.errors++;
      this.logger?.error('tâche en échec', { url, error: err.message });
      this.emit('fetch-error', { url, depth, reason: err.message });
    } finally {
      this.progress({ url });
    }
  }
}
