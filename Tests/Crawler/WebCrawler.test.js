import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../Src/Backend/Storage/Database.js';
import { Indexer } from '../../Src/Backend/Crawler/Indexer/Indexer.js';
import { SearchIndex } from '../../Src/Backend/Crawler/Indexer/SearchIndex.js';
import { WebCrawler } from '../../Src/Backend/Crawler/Web-Crawler/WebCrawler.js';
import { WebValidator } from '../../Src/Backend/Crawler/Web-Crawler/WebValidator.js';
import { startServer } from '../helpers.js';

let server;

before(async () => {
  server = await startServer({
    routes: {
      '/redirect': (req, res) => {
        res.writeHead(301, { location: '/python.html' });
        res.end();
      },
      '/robots-delay/robots.txt': (req, res) => res.end('User-agent: *\nCrawl-delay: 1'),
      '/header-noindex': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', 'x-robots-tag': 'noindex' });
        res.end('<title>X</title><p>caché par en-tête</p>');
      },
      '/copy-of-rust': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Copie</title></head><body><p>Rust est un langage compilé, rapide et sûr.\nLes moteurs de recherche modernes l\'utilisent parfois.</p></body></html>');
      },
    },
  });
});

after(() => server.close());

function setup(options = {}) {
  const db = new Database(':memory:');
  const indexer = new Indexer(db);
  const crawler = new WebCrawler({ indexer, allowPrivateHosts: true, delayMs: 0, maxPages: 50, ...options });
  return { db, indexer, crawler, search: new SearchIndex(db) };
}

test('explore le site, respecte robots.txt, noindex, nofollow et la profondeur', async () => {
  const { crawler, search, indexer } = setup({ maxDepth: 1 });
  const skipped = [];
  crawler.on('skip', (e) => skipped.push(e));
  const result = await crawler.crawl([`${server.url}/index.html`]);
  const urls = search.recent({ limit: 50 }).map((r) => r.url.replace(server.url, ''));
  assert.deepEqual(urls.sort(), ['/docs/guide.html', '/index.html', '/python.html', '/rust.html'].sort());
  assert.equal(result.indexed, 4);
  assert.ok(skipped.some((s) => s.reason === 'interdit par robots.txt'));
  assert.ok(skipped.some((s) => s.reason === 'noindex'));
  assert.ok(!server.requests.some((r) => r.path === '/sponsor.html'), 'lien nofollow suivi');
  assert.ok(!server.requests.some((r) => r.path === '/image.png'), 'image téléchargée');
  assert.ok(!server.requests.some((r) => r.path === '/docs/profond.html'), 'profondeur dépassée');
  assert.equal(search.search('zygomorphe').total, 1);
  assert.equal(search.search('ornithorynque').total, 0);
  assert.equal(search.search('motcache').total, 0);
  assert.ok(indexer.getLinks(`${server.url}/index.html`).includes(`${server.url}/python.html`));
});

test('seconde exploration : réutilise les liens des pages déjà indexées sans les retélécharger', async () => {
  const { crawler, db, indexer } = setup({ maxDepth: 1 });
  await crawler.crawl([`${server.url}/index.html`]);
  const before = server.requests.length;
  const second = new WebCrawler({ indexer, allowPrivateHosts: true, delayMs: 0, maxDepth: 3 });
  const r = await second.crawl([`${server.url}/index.html`]);
  const fetched = server.requests.slice(before).map((q) => q.path);
  assert.ok(r.reused >= 3);
  assert.ok(fetched.includes('/docs/profond.html'), 'nouvelle profondeur atteinte');
  assert.ok(!fetched.includes('/python.html'), 'page connue retéléchargée');
  db.close();
});

test('limite de pages, redirections, contenu en double, X-Robots-Tag', async () => {
  const { crawler, search } = setup({ maxPages: 2, maxDepth: 0, sameDomain: false });
  const r = await crawler.crawl([`${server.url}/redirect`, `${server.url}/header-noindex`, `${server.url}/rust.html`, `${server.url}/copy-of-rust`]);
  assert.equal(r.indexed, 2);
  const urls = search.recent().map((x) => x.url.replace(server.url, ''));
  assert.ok(urls.includes('/python.html'), 'URL finale après redirection');
  assert.ok(!urls.includes('/header-noindex'));
  assert.ok(!urls.includes('/copy-of-rust'));
});

test('refuse les hôtes privés par défaut (anti-SSRF)', async () => {
  const db = new Database(':memory:');
  const crawler = new WebCrawler({ indexer: new Indexer(db), delayMs: 0 });
  const skipped = [];
  crawler.on('skip', (e) => skipped.push(e.reason));
  const r = await crawler.crawl([`${server.url}/index.html`]);
  assert.equal(r.indexed, 0);
  assert.match(skipped[0], /privé/);
});

test('WebValidator : DNS vers une adresse privée, .onion, extensions, hôtes bloqués', async () => {
  const v = new WebValidator({ blockedHosts: ['pub.example'], resolver: async (h) => (h === 'evil.example' ? [{ address: '10.0.0.1' }] : [{ address: '93.184.216.34' }]) });
  assert.equal((await v.check('http://evil.example/')).ok, false);
  assert.equal((await v.check('http://good.example/')).ok, true);
  assert.equal(v.accepts('http://ads.pub.example/').ok, false);
  assert.equal(v.accepts('http://abc.onion/').ok, false);
  assert.equal(v.accepts('http://good.example/a.zip').ok, false);
  assert.equal(v.accepts('http://192.168.1.1/').ok, false);
  assert.equal(v.accepts('ftp://good.example/').ok, false);
});

test('stop() interrompt une exploration', async () => {
  const { crawler } = setup({ delayMs: 200 });
  crawler.once('page', () => crawler.stop());
  const r = await crawler.crawl([`${server.url}/index.html`]);
  assert.equal(r.stopped, true);
  assert.ok(r.indexed <= 2);
});

test('Crawl-delay ralentit les requêtes vers l’hôte', async () => {
  const { crawler } = setup({ maxDepth: 1, maxPages: 3 });
  crawler.scheduler.setCrawlDelay(new URL(server.url).host, 0.3);
  const t = Date.now();
  await crawler.crawl([`${server.url}/python.html`]);
  assert.ok(Date.now() - t >= 300, 'délai respecté');
});
