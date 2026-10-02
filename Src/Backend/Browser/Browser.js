// Navigateur texte : charge des pages (direct ou via Tor), gère cookies/historique,
// peut indexer les pages visitées et télécharger des fichiers.
// Moteur « http » léger par défaut ; moteur « playwright » optionnel pour les sites en JavaScript.
import { EventEmitter } from 'node:events';
import { Page } from './Page.js';
import { Context } from './Context.js';
import { BrowserPool } from './BrowserPool.js';
import { Document } from '../Crawler/Indexer/Document.js';
import { HttpClient } from '../Network/HttpClient.js';
import { saveDownload } from '../Storage/Files.js';
import { normalizeUrl, withScheme, isOnionUrl } from '../Utils/Validator.js';

export class Browser extends EventEmitter {
  constructor({
    client = new HttpClient(), torClient = null, tor = null, indexer = null, history = null,
    engine = 'http', poolSize = 2, indexVisited = false, recordHistory = true, downloadsDir = null, logger = null,
  } = {}) {
    super();
    this.client = client;
    this.torClient = torClient;
    this.tor = tor;
    this.indexer = indexer;
    this.history = history;
    this.engine = engine;
    this.poolSize = poolSize;
    this.indexVisited = indexVisited;
    this.recordHistory = recordHistory;
    this.downloadsDir = downloadsDir;
    this.logger = logger;
    this.defaultContext = new Context();
    this.pools = {};
  }

  newContext(options) {
    return new Context(options);
  }

  usesTor(url, context) {
    return context.network === 'tor' || (context.network === 'auto' && isOnionUrl(url));
  }

  clientFor(url, context) {
    if (this.usesTor(url, context)) {
      if (!this.torClient) throw new Error('Tor n’est pas configuré');
      return this.torClient;
    }
    return this.client;
  }

  /** Ouvre une URL (ou une saisie sans schéma) et renvoie une Page. */
  async open(input, { context = this.defaultContext, push = true, noCache = true } = {}) {
    const url = normalizeUrl(withScheme(input));
    if (!url) throw new Error(`adresse invalide : ${input}`);
    const network = isOnionUrl(url) ? 'onion' : 'web';
    if (this.usesTor(url, context) && this.tor && !(await this.tor.isAvailable())) {
      throw new Error(`Tor injoignable sur ${this.tor.address} : lancez Tor pour ouvrir les adresses .onion`);
    }
    this.emit('loading', { url });
    let page;
    try {
      page = await this.load(url, context, network, noCache);
    } catch (err) {
      // Adresse saisie sans schéma : si HTTPS échoue, on retente en HTTP
      const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(input).trim());
      if (typedScheme || !url.startsWith('https://')) throw err;
      page = await this.load(`http://${url.slice(8)}`, context, network, noCache);
    }

    if (push) context.push(page.url);
    else context.replace(page.url);
    if (this.recordHistory && this.history) this.history.addVisit(page.url, page.title);
    if (this.indexVisited && this.indexer && page.kind === 'html' && page.status < 400 && page.meta && !page.meta.robots?.noindex) {
      this.index(page);
    }
    this.emit('load', { url: page.url, title: page.title });
    return page;
  }

  async load(url, context, network, noCache) {
    if (this.engine === 'playwright') return this.openWithPlaywright(url, context, network);
    return Page.fromResponse(await this.clientFor(url, context).get(url, { context, noCache }), { network });
  }

  /** Ajoute la page à l'index de recherche. */
  index(page) {
    if (!this.indexer) throw new Error('aucun index configuré');
    const doc = new Document({
      url: page.url, title: page.title, description: page.meta?.description ?? '', keywords: page.meta?.keywords ?? [],
      body: page.text.replace(/\[\d+\]/g, ''), lang: page.meta?.lang ?? '', network: page.network,
      status: page.status, links: page.links.map((l) => l.url),
    });
    this.indexer.add(doc);
    return doc;
  }

  async back(context = this.defaultContext) {
    const url = context.back();
    return url ? this.open(url, { context, push: false }) : null;
  }

  async forward(context = this.defaultContext) {
    const url = context.forward();
    return url ? this.open(url, { context, push: false }) : null;
  }

  async reload(context = this.defaultContext) {
    return context.current ? this.open(context.current, { context, push: false }) : null;
  }

  /** Télécharge une ressource dans le dossier des téléchargements ; renvoie le chemin du fichier. */
  async download(input, { context = this.defaultContext } = {}) {
    if (!this.downloadsDir) throw new Error('dossier de téléchargement non configuré');
    const url = normalizeUrl(withScheme(input));
    if (!url) throw new Error(`adresse invalide : ${input}`);
    const res = await this.clientFor(url, context).get(url, { context, noCache: true, maxBytes: 500 * 1024 * 1024, accept: '*/*' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file = saveDownload(this.downloadsDir, {
      url: res.url, body: res.body, mime: res.mime, contentDisposition: res.headers['content-disposition'],
    });
    this.emit('download', { url, file });
    return file;
  }

  // ---------------------------------------------------------------- moteur Playwright (optionnel)

  async playwrightPool(useTor) {
    const key = useTor ? 'tor' : 'direct';
    if (this.pools[key]) return this.pools[key];
    let playwright;
    try {
      playwright = await import('playwright');
    } catch {
      throw new Error('moteur « playwright » indisponible : installez-le avec « npm i playwright »');
    }
    const launchOptions = { headless: true };
    if (useTor && this.tor) launchOptions.proxy = { server: `socks5://${this.tor.address}` };
    if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    const browser = await playwright.chromium.launch(launchOptions);
    const pool = new BrowserPool({
      size: this.poolSize,
      create: async () => (await browser.newContext({ javaScriptEnabled: true })).newPage(),
      destroy: async (page) => page.context().close(),
    });
    pool.browser = browser;
    this.pools[key] = pool;
    return pool;
  }

  async openWithPlaywright(url, context, network) {
    const pool = await this.playwrightPool(this.usesTor(url, context));
    return pool.use(async (pwPage) => {
      const response = await pwPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pwPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const html = await pwPage.content();
      const page = Page.fromHtml(html, normalizeUrl(pwPage.url()) ?? url, {
        status: response?.status() ?? 200, mime: 'text/html', network, size: html.length,
      });
      page.rawHtml = html;
      return page;
    });
  }

  async close() {
    for (const pool of Object.values(this.pools)) {
      await pool.close();
      await pool.browser?.close().catch(() => {});
    }
    this.pools = {};
  }
}
