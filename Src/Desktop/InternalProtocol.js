// Protocole interne webbrowser:// : pages de l'application (accueil, recherche, historique…) et leur API JSON.
// Aucune dépendance directe à Electron : `handleInternalRequest` prend un objet Request standard (fetch).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from '../Backend/API/Routes/Router.js';
import { SearchController } from '../Backend/API/Controllers/SearchController.js';
import { CrawlController } from '../Backend/API/Controllers/CrawlController.js';
import { HistoryController } from '../Backend/API/Controllers/HistoryController.js';
import { StatsController } from '../Backend/API/Controllers/StatsController.js';
import { ApiError, badRequest, notFound } from '../Backend/API/Controllers/HttpErrors.js';
import { settingsFor, findSetting, coerceSetting, SEARCH_ENGINES } from '../Backend/Utils/SettingsSchema.js';
import { normalizeUrl } from '../Backend/Utils/Validator.js';

const PAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'Pages');
const PAGES = new Set(['home', 'search', 'cached', 'history', 'settings', 'crawls', 'downloads', 'error', 'tor', 'about']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action webbrowser:; base-uri 'none'; frame-ancestors 'none'";

function response(body, status = 200, type = 'application/json; charset=utf-8', extra = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, ...extra },
  });
}

/**
 * Routes JSON propres à l'application graphique, en plus de celles de l'API REST.
 * `desktop` fournit : downloads (liste), openPath(file), showInFolder(file), clearCache(), setDefaultBrowser(), version.
 */
export function buildInternalRouter(services, desktop = {}) {
  const { config, searchIndex, history, jobs, tor, indexer } = services;
  const search = new SearchController({ searchIndex, history });
  const crawl = new CrawlController({ jobs });
  const hist = new HistoryController({ history });
  const stats = new StatsController({ searchIndex, tor, jobs, version: desktop.version ?? '' });
  const router = new Router();

  router
    .get('/api/search', search.search)
    .get('/api/documents', search.document)
    .post('/api/crawl', crawl.start)
    .get('/api/crawl', crawl.list)
    .get('/api/crawl/:id', crawl.get)
    .delete('/api/crawl/:id', crawl.stop)
    .get('/api/history', hist.list)
    .delete('/api/history', hist.clear)
    .delete('/api/history/:id', hist.remove)
    .get('/api/stats', stats.stats)
    .get('/api/health', stats.health);

  router.get('/api/settings', (ctx) => ctx.json({
    fields: settingsFor('desktop').map((f) => (f.key ? { ...f, value: config.get(f.key) } : f)),
    settingsFile: config.settingsFile,
    engines: Object.fromEntries(Object.entries(SEARCH_ENGINES).map(([k, v]) => [k, v.label])),
  }));

  router.post('/api/settings', async (ctx) => {
    const { key, value } = await ctx.body();
    const field = findSetting(key);
    if (!field || field.ui === 'tui') throw badRequest('réglage inconnu');
    let v;
    try {
      v = coerceSetting(field, value);
    } catch (err) {
      throw badRequest(err.message);
    }
    config.set(key, v);
    config.save();
    services.refreshSettings?.();
    desktop.onSettingsChanged?.(key, v);
    ctx.json({ key, value: v, restart: Boolean(field.restart) });
  });

  router.post('/api/maintenance/:action', async (ctx) => {
    switch (ctx.params.action) {
      case 'cache':
        services.cache.clear();
        await desktop.clearCache?.();
        return ctx.json({ ok: true, message: 'Cache vidé.' });
      case 'index-web':
      case 'index-onion': {
        const n = indexer.clear(ctx.params.action === 'index-web' ? 'web' : 'onion');
        return ctx.json({ ok: true, message: `${n} page(s) retirée(s) de l’index.` });
      }
      case 'default-browser': {
        const ok = await desktop.setDefaultBrowser?.();
        return ctx.json({ ok: Boolean(ok), message: ok ? 'WebBrowser est maintenant le navigateur par défaut.' : 'Impossible de modifier le navigateur par défaut (xdg-settings).' });
      }
      default:
        throw notFound('action inconnue');
    }
  });

  router.get('/api/downloads', (ctx) => ctx.json({ downloads: desktop.downloads?.() ?? [] }));
  router.post('/api/downloads/:id/:action', (ctx) => {
    const item = (desktop.downloads?.() ?? []).find((d) => d.id === ctx.params.id);
    if (!item) throw notFound('téléchargement inconnu');
    if (ctx.params.action === 'open') desktop.openPath?.(item.file);
    else if (ctx.params.action === 'show') desktop.showInFolder?.(item.file);
    else if (ctx.params.action === 'cancel') desktop.cancelDownload?.(item.id);
    else throw notFound('action inconnue');
    ctx.json({ ok: true });
  });

  router.get('/api/backlinks', (ctx) => {
    const url = normalizeUrl(ctx.query.get('url') ?? '');
    if (!url) throw badRequest('paramètre « url » invalide');
    ctx.json({ backlinks: indexer.backlinks(url, 20), links: indexer.getLinks(url).length });
  });

  router.get('/api/about', (ctx) => ctx.json({
    version: desktop.version ?? '', versions: desktop.versions ?? {}, paths: {
      settings: config.settingsFile, index: config.path('database.file'),
      downloads: config.path('paths.downloads'), cache: config.path('paths.cache'),
    },
  }));

  return router;
}

/** Traite une requête webbrowser://<page>/… : page HTML, fichier statique ou API JSON. */
export async function handleInternalRequest(request, router) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return response('{"error":"adresse invalide"}', 400);
  }
  const page = url.hostname || 'home';
  const pathname = url.pathname || '/';

  if (pathname.startsWith('/api/')) {
    // L'API n'est accessible qu'aux pages internes (jamais à un site web)
    const referrer = request.referrer || request.headers.get('referer') || '';
    if (!referrer.startsWith('webbrowser://')) return response('{"error":"accès refusé"}', 403);
    return handleApi(request, router, url);
  }

  if (pathname.startsWith('/assets/')) {
    const name = pathname.slice('/assets/'.length);
    if (!/^[\w.-]+$/.test(name)) return response('introuvable', 404, 'text/plain');
    const file = path.join(PAGES_DIR, 'assets', name);
    try {
      const body = await fs.promises.readFile(file);
      return response(body, 200, TYPES[path.extname(name)] ?? 'application/octet-stream');
    } catch {
      return response('introuvable', 404, 'text/plain');
    }
  }

  const name = PAGES.has(page) ? page : 'error';
  const body = await fs.promises.readFile(path.join(PAGES_DIR, `${name}.html`));
  return response(body, PAGES.has(page) ? 200 : 404, TYPES['.html']);
}

async function handleApi(request, router, url) {
  return new Promise((resolve) => {
    let done = false;
    const send = (data, status = 200) => {
      if (done) return;
      done = true;
      resolve(response(JSON.stringify(data), status));
    };
    const ctx = {
      params: {},
      query: url.searchParams,
      body: async () => {
        const text = await request.text();
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          throw badRequest('JSON invalide');
        }
      },
      json: send,
    };
    const { handler, params, allowed } = router.match(request.method, url.pathname);
    if (!handler) {
      send({ error: allowed?.length ? 'méthode non autorisée' : 'route inconnue' }, allowed?.length ? 405 : 404);
      return;
    }
    ctx.params = params;
    Promise.resolve()
      .then(() => handler(ctx))
      .then(() => send({ ok: true }))
      .catch((err) => {
        const status = err instanceof ApiError ? err.status : 500;
        send({ error: status === 500 ? `erreur interne : ${err.message}` : err.message }, status);
      });
  });
}
