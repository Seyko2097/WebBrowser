// Déclaration des routes de l'API.
import { Router } from './Router.js';

export function buildRoutes(controllers) {
  const { search, crawl, page, history, stats } = controllers;
  const router = new Router();
  router
    .get('/api/health', stats.health)
    .get('/api/stats', stats.stats)
    .get('/api/search', search.search)
    .get('/api/documents', search.document)
    .get('/api/page', page.open)
    .post('/api/crawl', crawl.start)
    .get('/api/crawl', crawl.list)
    .get('/api/crawl/:id', crawl.get)
    .delete('/api/crawl/:id', crawl.stop)
    .get('/api/history', history.list)
    .delete('/api/history', history.clear)
    .delete('/api/history/:id', history.remove);
  router.get('/api', (ctx) => ctx.json({ routes: router.list() }));
  return router;
}
