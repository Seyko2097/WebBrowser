// Serveur HTTP du mode VPS : page de recherche publique, API JSON publique (lecture seule, limitée en débit)
// et API d'administration (clé secrète + connexions locales uniquement par défaut).
import crypto from 'node:crypto';
import http from 'node:http';
import { Router } from '../API/Routes/Router.js';
import { ApiError, badRequest, notFound } from '../API/Controllers/HttpErrors.js';
import { RateLimiter } from './RateLimiter.js';
import { homePage, resultsPage, escapeHtml } from './SearchPage.js';
import { toInt, normalizeUrl } from '../Utils/Validator.js';

const MAX_QUERY = 300;
const MAX_BODY = 64 * 1024;
const PER_PAGE = 10;

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class PublicServer {
  constructor({ searchIndex, frontier, seeds, daemon, logger, version = '', host = '0.0.0.0', port = 8080,
    adminToken = null, adminRemote = false, trustProxy = false, searchPerMinute = 120 }) {
    Object.assign(this, { searchIndex, frontier, seeds, daemon, version, host, port, adminToken, adminRemote, trustProxy });
    this.logger = logger?.child('serveur');
    this.limiter = new RateLimiter({ perMinute: searchPerMinute });
    this.statsCache = { at: 0, value: null };
    this.router = this.buildRoutes();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 30_000;
    this.server.keepAliveTimeout = 5_000;
  }

  // ---------------------------------------------------------------- routes

  buildRoutes() {
    const r = new Router();
    r.get('/', (ctx) => ctx.html(homePage({ pages: this.publicStats().pages })));
    r.get('/search', (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim().slice(0, MAX_QUERY);
      if (!q) return ctx.redirect('/');
      this.limit(ctx);
      const page = toInt(ctx.query.get('p'), { min: 1, max: 50, fallback: 1 }) - 1;
      const t = Date.now();
      const { results, total, totalCapped } = this.searchIndex.search(q, { limit: PER_PAGE, offset: page * PER_PAGE, network: 'web' });
      return ctx.html(resultsPage({ q, results, total, totalCapped, page, perPage: PER_PAGE, tookMs: Date.now() - t }));
    });
    r.get('/robots.txt', (ctx) => ctx.text('User-agent: *\nDisallow: /search\nDisallow: /api/\n'));
    r.get('/api', (ctx) => ctx.json({
      name: 'WebBrowser', version: this.version,
      public: ['GET /api/search?q=…&limit=&offset=', 'GET /api/stats', 'GET /api/health'],
      admin: 'Authorization: Bearer <clé> — /api/admin/…',
    }));
    r.get('/api/health', (ctx) => ctx.json({ ok: true, version: this.version }));
    r.get('/api/stats', (ctx) => ctx.json(this.publicStats()));
    r.get('/api/search', (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim();
      if (!q) throw badRequest('paramètre « q » manquant');
      if (q.length > MAX_QUERY) throw badRequest(`recherche trop longue (${MAX_QUERY} caractères max)`);
      this.limit(ctx);
      const limit = toInt(ctx.query.get('limit'), { min: 1, max: 50, fallback: 10 });
      const offset = toInt(ctx.query.get('offset'), { min: 0, max: 500, fallback: 0 });
      const t = Date.now();
      const { results, total, totalCapped } = this.searchIndex.search(q, { limit, offset, network: 'web' });
      const strip = (s) => s.replace(/[\u0003\u0004]/g, '');
      ctx.json({
        query: q, total, totalCapped, limit, offset, tookMs: Date.now() - t,
        results: results.map((x) => ({ url: x.url, title: x.title, snippet: strip(x.snippet), fetchedAt: x.fetchedAt, score: x.score })),
      });
    });

    // Administration
    r.get('/api/admin/status', (ctx) => {
      this.admin(ctx);
      ctx.json({ crawler: this.daemon?.status() ?? null, frontier: this.frontier.counts(), seeds: this.seeds.list().length, index: this.searchIndex.stats() });
    });
    r.get('/api/admin/seeds', (ctx) => {
      this.admin(ctx);
      ctx.json({ seeds: this.seeds.list() });
    });
    r.post('/api/admin/seeds', async (ctx) => {
      this.admin(ctx);
      const body = await ctx.body();
      const urls = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
      if (!urls.length) throw badRequest('« url » ou « urls » attendu');
      const out = [];
      for (const u of urls) {
        try {
          out.push(this.seeds.add(String(u), {
            maxDepth: toInt(body.maxDepth, { min: 0, max: 50, fallback: 3 }),
            maxPages: toInt(body.maxPages, { min: 1, max: 10_000_000, fallback: 10000 }),
            sameDomain: body.sameDomain !== false,
          }));
        } catch (err) {
          throw badRequest(err.message);
        }
      }
      this.daemon?.signal();
      ctx.json({ seeds: out }, 201);
    });
    r.delete('/api/admin/seeds/:id', (ctx) => {
      this.admin(ctx);
      const removed = this.seeds.remove(Number(ctx.params.id), { purge: ctx.query.get('purge') === '1' });
      if (!removed) throw notFound('site de départ inconnu');
      ctx.json(removed);
    });
    r.get('/api/admin/hosts', (ctx) => {
      this.admin(ctx);
      ctx.json({ hosts: this.frontier.topHosts(toInt(ctx.query.get('limit'), { min: 1, max: 200, fallback: 30 })) });
    });
    r.post('/api/admin/recrawl', async (ctx) => {
      this.admin(ctx);
      const url = normalizeUrl(String((await ctx.body()).url ?? ''));
      if (!url || !this.frontier.prioritize(url)) throw notFound('URL absente de la file');
      this.daemon?.signal();
      ctx.json({ ok: true });
    });
    r.post('/api/admin/pause', (ctx) => {
      this.admin(ctx);
      this.daemon?.pause();
      ctx.json({ paused: true });
    });
    r.post('/api/admin/resume', (ctx) => {
      this.admin(ctx);
      this.daemon?.resume();
      ctx.json({ paused: false });
    });
    return r;
  }

  publicStats() {
    const now = Date.now();
    if (!this.statsCache.value || now - this.statsCache.at > 30_000) {
      const s = this.searchIndex.stats();
      const f = this.frontier.counts();
      this.statsCache = {
        at: now,
        value: { pages: s.total, sites: s.hosts, queued: f.pending, lastFetchedAt: s.lastFetchedAt, pagesPerMinute: this.daemon?.status().pagesPerMinute ?? 0 },
      };
    }
    return this.statsCache.value;
  }

  clientIp(req) {
    if (this.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? '?';
  }

  limit(ctx) {
    const { ok, retryAfterMs } = this.limiter.take(ctx.ip);
    if (!ok) {
      ctx.res.setHeader('retry-after', Math.ceil(retryAfterMs / 1000));
      throw new ApiError(429, 'trop de requêtes, réessayez dans quelques secondes');
    }
  }

  admin(ctx) {
    if (!this.adminToken) throw new ApiError(403, 'administration désactivée : définissez WEBBROWSER_ADMIN_TOKEN');
    if (!this.adminRemote && !isLoopback(ctx.req.socket.remoteAddress)) {
      throw new ApiError(403, 'administration réservée aux connexions locales (utilisez SSH)');
    }
    const auth = String(ctx.req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !safeEqual(token, this.adminToken)) throw new ApiError(401, 'clé d’administration invalide');
  }

  // ---------------------------------------------------------------- HTTP

  async handle(req, res) {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const isApi = url.pathname.startsWith('/api');
    const headers = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    };
    const send = (status, body, type) => {
      if (res.headersSent) return;
      const buf = Buffer.from(body);
      res.writeHead(status, {
        ...headers,
        'content-type': type,
        'content-length': buf.length,
        'cache-control': status === 200 && !url.pathname.startsWith('/api/admin') ? 'public, max-age=60' : 'no-store',
        ...(isApi && !url.pathname.startsWith('/api/admin') ? { 'access-control-allow-origin': '*' } : {}),
        ...(type.startsWith('text/html') ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    };
    const ctx = {
      req, res, url, params: {}, query: url.searchParams, ip: this.clientIp(req),
      json: (data, status = 200) => send(status, JSON.stringify(data), 'application/json; charset=utf-8'),
      html: (html, status = 200) => send(status, html, 'text/html; charset=utf-8'),
      text: (t, status = 200) => send(status, t, 'text/plain; charset=utf-8'),
      redirect: (to) => {
        res.writeHead(302, { ...headers, location: to });
        res.end();
      },
      body: () => this.readBody(req),
    };
    try {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      if (method === 'OPTIONS' && isApi) {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' });
        res.end();
        return;
      }
      const { handler, params, allowed } = this.router.match(method, url.pathname);
      if (!handler) throw new ApiError(allowed?.length ? 405 : 404, allowed?.length ? 'méthode non autorisée' : 'page introuvable');
      ctx.params = params;
      await handler(ctx);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) this.logger?.error('erreur', { path: url.pathname, error: err.stack });
      const message = status === 500 ? 'erreur interne' : err.message;
      if (isApi) ctx.json({ error: message }, status);
      else ctx.html(`<!doctype html><meta charset="utf-8"><title>${status}</title><p>${escapeHtml(message)}</p><p><a href="/">Accueil</a></p>`, status);
    } finally {
      this.logger?.debug(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }

  readBody(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return Promise.reject(new ApiError(415, 'Content-Type: application/json attendu'));
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new ApiError(413, 'corps trop volumineux'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new ApiError(400, 'JSON invalide'));
        }
      });
      req.on('error', reject);
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        const { address, port } = this.server.address();
        this.port = port;
        this.logger?.info(`serveur à l'écoute sur http://${address}:${port}`);
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
