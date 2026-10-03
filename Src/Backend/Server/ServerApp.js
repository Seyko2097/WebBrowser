// Assemblage du mode serveur (VPS) : base, file d'exploration, sites de départ, robot continu, serveur public.
import { Database } from '../Storage/Database.js';
import { Indexer } from '../Crawler/Indexer/Indexer.js';
import { SearchIndex } from '../Crawler/Indexer/SearchIndex.js';
import { WebValidator } from '../Crawler/Web-Crawler/WebValidator.js';
import { HttpClient } from '../Network/HttpClient.js';
import { Frontier } from './Frontier.js';
import { SeedStore } from './SeedStore.js';
import { CrawlerDaemon } from './CrawlerDaemon.js';
import { PublicServer } from './PublicServer.js';

export function botUserAgent(config, version) {
  const contact = config.get('server.contact');
  return `Mozilla/5.0 (compatible; ${config.get('server.botName')}/${version}; +${contact || 'https://github.com/seyko2097/webbrowser'})`;
}

export class ServerApp {
  constructor({ config, logger, version = '0.0.0', crawl = true, dbOptions = {} }) {
    this.config = config;
    this.logger = logger;
    this.version = version;
    const c = (k) => config.get(`server.${k}`);
    this.dbFile = config.path('database.file');
    this.db = new Database(this.dbFile, { cacheMB: c('dbCacheMB'), ...dbOptions });
    this.indexer = new Indexer(this.db);
    this.searchIndex = new SearchIndex(this.db);
    this.frontier = new Frontier(this.db);
    this.seeds = new SeedStore(this.db, this.frontier);
    if (crawl) {
      const userAgent = botUserAgent(config, version);
      this.daemon = new CrawlerDaemon({
        db: this.db, frontier: this.frontier, seeds: this.seeds, indexer: this.indexer,
        client: new HttpClient({
          userAgent, timeoutMs: config.get('network.timeoutMs'), maxBytes: config.get('network.maxBytes'),
          maxRedirects: config.get('network.maxRedirects'), proxy: config.get('network.proxy'),
        }),
        validator: new WebValidator({ allowPrivateHosts: config.get('crawler.allowPrivateHosts') }),
        logger: logger.child('robot'),
        userAgent,
        concurrency: c('concurrency'),
        hostDelayMs: c('hostDelayMs'),
        recrawlAfterDays: c('recrawlAfterDays'),
        maxLinksPerPage: c('maxLinksPerPage'),
        maxPages: c('maxPages'),
        maxFrontier: c('maxFrontier'),
        maxDbSizeMB: c('maxDbSizeMB'),
        dbFile: this.dbFile,
        maxBodyChars: config.get('crawler.maxBodyChars'),
        respectRobots: config.get('crawler.respectRobots'),
      });
    }
  }

  createPublicServer(overrides = {}) {
    const c = (k) => this.config.get(`server.${k}`);
    return new PublicServer({
      searchIndex: this.searchIndex, frontier: this.frontier, seeds: this.seeds, daemon: this.daemon,
      logger: this.logger, version: this.version,
      host: c('host'), port: c('port'), adminToken: c('adminToken'), adminRemote: c('adminRemote'),
      trustProxy: c('trustProxy'), searchPerMinute: c('searchPerMinute'),
      ...overrides,
    });
  }

  async close() {
    await this.daemon?.stop();
    this.db.close();
  }
}
