import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ServerApp } from '../../Src/Backend/Server/ServerApp.js';
import { Config } from '../../Src/Backend/Utils/Config.js';
import { Logger } from '../../Src/Backend/Utils/Logger.js';
import { Document } from '../../Src/Backend/Crawler/Indexer/Document.js';
import { startServer, tmpDir } from '../helpers.js';

let site;
let app;
let server;
let base;

const TOKEN = 'cle-de-test-tres-longue';

function waitFor(fn, ms = 10_000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try {
        ok = fn();
      } catch {
        ok = false;
      }
      if (ok) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('délai dépassé'));
      }
    }, 50);
  });
}

before(async () => {
  site = await startServer({
    routes: {
      '/gone.html': (req, res) => { res.writeHead(410); res.end(); },
      '/flaky.html': (req, res) => { res.writeHead(503); res.end(); },
    },
  });
  const config = new Config({
    env: { WEBBROWSER_HOME: tmpDir() },
    overrides: {
      crawler: { allowPrivateHosts: true },
      server: { adminToken: TOKEN, hostDelayMs: 10, concurrency: 4, searchPerMinute: 30, dbCacheMB: 8 },
    },
  });
  app = new ServerApp({ config, logger: Logger.silent(), version: 'test' });
  server = app.createPublicServer({ host: '127.0.0.1', port: 0 });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server.stop();
  await app.close();
  await site.close();
});

const admin = (path, opts = {}) => fetch(base + path, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(opts.headers ?? {}) },
});

test('le robot explore les sites de départ en continu et respecte robots.txt / noindex / profondeur', async () => {
  app.seeds.add(`${site.url}/index.html`, { maxDepth: 1, maxPages: 100 });
  app.frontier.add(`${site.url}/gone.html`, { seedId: 1, depth: 1 });
  app.frontier.add(`${site.url}/flaky.html`, { seedId: 1, depth: 1 });
  await app.daemon.start();
  await waitFor(() => app.searchIndex.count() >= 4 && app.frontier.counts().dead >= 1);
  const urls = app.searchIndex.recent({ limit: 50 }).map((r) => r.url.replace(site.url, '')).sort();
  assert.deepEqual(urls, ['/docs/guide.html', '/index.html', '/python.html', '/rust.html']);
  assert.ok(!site.requests.some((r) => r.path === '/prive/secret.html'), 'robots.txt ignoré');
  assert.ok(!site.requests.some((r) => r.path === '/docs/profond.html'), 'profondeur dépassée');
  assert.equal(app.frontier.get(`${site.url}/gone.html`).status, 'dead');
  const flaky = app.frontier.get(`${site.url}/flaky.html`);
  assert.equal(flaky.attempts, 1);
  assert.ok(flaky.next_at > Date.now() + 3000_000, 'nouvel essai dans ~1 h');
  const ua = site.requests.find((r) => r.path === '/index.html').headers['user-agent'];
  assert.match(ua, /WebBrowserBot\/test/);
});

test('reprise après redémarrage : rien n’est retéléchargé avant la date de réexploration', async () => {
  await app.daemon.stop();
  const before = site.requests.length;
  await app.daemon.start();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(site.requests.length, before);
  assert.equal(app.daemon.status().running, true);
});

test('page de recherche publique et API JSON', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /pages indexées/);
  const html = await (await fetch(`${base}/search?q=${encodeURIComponent('<script>alert(1)</script> langage')}`)).text();
  assert.ok(!html.includes('<script>alert'), 'injection HTML');
  assert.match(html, /&lt;script&gt;/);
  const res = await fetch(`${base}/search?q=langage`);
  assert.match(await res.text(), /<mark>langage<\/mark>/);
  const api = await (await fetch(`${base}/api/search?q=python`)).json();
  assert.equal(api.results[0].url, `${site.url}/python.html`);
  assert.doesNotMatch(api.results[0].snippet, /[\u0003\u0004]/);
  assert.equal((await fetch(`${base}/api/search?q=`)).status, 400);
  assert.equal((await fetch(`${base}/api/search?q=${'a'.repeat(400)}`)).status, 400);
  assert.equal((await fetch(`${base}/robots.txt`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/search?q=x`)).headers.get('access-control-allow-origin'), '*');
  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.ok(stats.pages >= 4);
});

test('administration : clé obligatoire, JSON obligatoire', async () => {
  assert.equal((await fetch(`${base}/api/admin/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/status`, { headers: { authorization: 'Bearer mauvaise' } })).status, 401);
  const status = await (await admin('/api/admin/status')).json();
  assert.equal(status.crawler.running, true);
  const created = await admin('/api/admin/seeds', { method: 'POST', body: JSON.stringify({ url: `${site.url}/rust.html`, maxDepth: 0 }) });
  assert.equal(created.status, 201);
  const { seeds } = await (await admin('/api/admin/seeds')).json();
  assert.equal(seeds.length, 2);
  const form = await admin('/api/admin/seeds', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  assert.equal((await admin(`/api/admin/seeds/${seeds[1].id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin('/api/admin/pause', { method: 'POST' })).status, 200);
  assert.equal(app.daemon.paused, true);
  await admin('/api/admin/resume', { method: 'POST' });
  assert.equal(app.daemon.paused, false);
  assert.ok((await (await admin('/api/admin/hosts')).json()).hosts.length >= 1);
});

test('administration refusée hors connexion locale (sauf adminRemote)', async () => {
  const fake = { socket: { remoteAddress: '203.0.113.9' }, headers: { authorization: `Bearer ${TOKEN}` } };
  assert.throws(() => server.admin({ req: fake }), /locales/);
  server.adminRemote = true;
  assert.doesNotThrow(() => server.admin({ req: fake }));
  server.adminRemote = false;
});

test('limitation du débit des recherches', async () => {
  let refused = 0;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${base}/api/search?q=rust${i}`);
    if (r.status === 429) {
      refused++;
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
    }
  }
  assert.ok(refused > 0);
});

test('limites de capacité : la découverte s’arrête quand l’index est plein', () => {
  app.daemon.limits.maxPages = 1;
  const cap = app.daemon.checkCapacity(true);
  assert.equal(cap.canGrow, false);
  assert.match(cap.reason, /limite/);
  app.indexer.add(new Document({ url: 'http://x.test/', title: 'x', body: 'x' }));
  assert.equal(app.daemon.enqueueLinks(['http://127.0.0.1/new'], { depth: 1, seedId: 1 }), 0);
  app.daemon.limits.maxPages = 5_000_000;
  app.daemon.checkCapacity(true);
});
