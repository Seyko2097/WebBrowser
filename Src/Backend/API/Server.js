// Serveur HTTP de l'API REST (JSON). Écoute sur 127.0.0.1 par défaut.
import http from 'node:http';
import { buildRoutes } from './Routes/index.js';
import { SearchController } from './Controllers/SearchController.js';
import { CrawlController } from './Controllers/CrawlController.js';
import { PageController } from './Controllers/PageController.js';
import { HistoryController } from './Controllers/HistoryController.js';
import { StatsController } from './Controllers/StatsController.js';
import { ApiError } from './Controllers/HttpErrors.js';

const MAX_BODY = 1024 * 1024;

function readBody(req) {
  // JSON obligatoire : un formulaire envoyé par un site web (CSRF vers 127.0.0.1) est refusé
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    return Promise.reject(new ApiError(415, 'Content-Type: application/json attendu'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'corps de requête trop volumineux'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ApiError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

export class ApiServer {
  constructor({ app, host = '127.0.0.1', port = 8080, version = '0.0.0' }) {
    this.app = app;
    this.host = host;
    this.port = port;
    this.logger = app.logger.child('api');
    this.router = buildRoutes({
      search: new SearchController({ searchIndex: app.searchIndex, history: app.history }),
      crawl: new CrawlController({ jobs: app.jobs }),
      page: new PageController({ browser: app.browser, allowPrivateHosts: app.config.get('crawler.allowPrivateHosts') }),
      history: new HistoryController({ history: app.history }),
      stats: new StatsController({ searchIndex: app.searchIndex, tor: app.tor, jobs: app.jobs, version }),
    });
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const send = (status, data) => {
      if (res.headersSent) return;
      const body = JSON.stringify(data, null, 2);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      res.end(body);
    };
    const ctx = {
      req, res, params: {}, query: url.searchParams,
      body: () => readBody(req),
      json: (data, status = 200) => send(status, data),
    };
    try {
      const { handler, params, allowed } = this.router.match(req.method, url.pathname);
      if (!handler) {
        if (allowed?.length) {
          res.setHeader('allow', allowed.join(', '));
          throw new ApiError(405, 'méthode non autorisée');
        }
        throw new ApiError(404, 'route inconnue');
      }
      ctx.params = params;
      await handler(ctx);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) this.logger.error('erreur API', { path: url.pathname, error: err.stack });
      send(status, { error: status === 500 ? 'erreur interne' : err.message });
    } finally {
      this.logger.debug(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        const { address, port } = this.server.address();
        this.port = port;
        this.logger.info(`API à l'écoute sur http://${address}:${port}`);
        resolve({ host: address, port });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}
