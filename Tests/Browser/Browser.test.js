import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Browser } from '../../Src/Backend/Browser/Browser.js';
import { Page } from '../../Src/Backend/Browser/Page.js';
import { Context, CookieJar } from '../../Src/Backend/Browser/Context.js';
import { BrowserPool } from '../../Src/Backend/Browser/BrowserPool.js';
import { HttpClient } from '../../Src/Backend/Network/HttpClient.js';
import { Tor } from '../../Src/Backend/Network/Tor.js';
import { Database, HistoryStore } from '../../Src/Backend/Storage/Database.js';
import { Indexer } from '../../Src/Backend/Crawler/Indexer/Indexer.js';
import { SearchIndex } from '../../Src/Backend/Crawler/Indexer/SearchIndex.js';
import { startServer, startSocksServer, makeOnion, freePort, tmpDir } from '../helpers.js';

let server;

before(async () => {
  server = await startServer({
    routes: {
      '/file.bin': (req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="données.bin"' });
        res.end(Buffer.from([1, 2, 3]));
      },
      '/notes.txt': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Simple texte.');
      },
    },
  });
});

after(() => server.close());

function makeBrowser(extra = {}) {
  const db = new Database(':memory:');
  const history = new HistoryStore(db);
  const indexer = new Indexer(db);
  const browser = new Browser({ client: new HttpClient(), history, indexer, downloadsDir: tmpDir(), ...extra });
  return { browser, history, indexer, search: new SearchIndex(db) };
}

test('Page : liens numérotés dans le texte, doublons regroupés', () => {
  const page = Page.fromHtml('<title>T</title><p><a href="/a">A</a>, <a href="/b">B</a> puis <a href="/a#x">encore A</a>.</p>', 'http://s.test/');
  assert.equal(page.title, 'T');
  assert.equal(page.text, 'A[1], B[2] puis encore A[1].');
  assert.deepEqual(page.links.map((l) => [l.number, l.url]), [[1, 'http://s.test/a'], [2, 'http://s.test/b']]);
  assert.equal(page.link(2).url, 'http://s.test/b');
  assert.deepEqual(Page.findInLines(['Bonjour', 'ÉLÉPHANT ici', 'rien'], 'elephant'), [1]);
});

test('ouvre une page, enregistre l’historique et l’indexe', async () => {
  const { browser, history, search } = makeBrowser({ indexVisited: true });
  const page = await browser.open(`${server.url}/index.html`);
  assert.equal(page.title, 'Accueil du site de test');
  assert.match(page.text, /Python\[\d+\]/);
  assert.equal(history.list()[0].value, `${server.url}/index.html`);
  assert.equal(search.search('éléphants').total, 1);
  assert.doesNotMatch(search.get(`${server.url}/index.html`).body, /\[\d+\]/);
});

test('adresse sans schéma : repli sur HTTP si HTTPS échoue', async () => {
  const { browser } = makeBrowser();
  const page = await browser.open(`127.0.0.1:${server.port}/rust.html`);
  assert.equal(page.title, 'Le langage Rust');
  // Nom d'hôte quelconque : https d'abord, puis http
  const tries = [];
  const fake = { get: async (url) => { tries.push(url); if (url.startsWith('https:')) throw new Error('EPROTO'); return new HttpClient().get(`${server.url}/python.html`); } };
  const { browser: b2 } = makeBrowser({ client: fake });
  assert.equal((await b2.open('site.example/python.html')).title, 'Le langage Python');
  assert.deepEqual(tries, ['https://site.example/python.html', 'http://site.example/python.html']);
  await assert.rejects(b2.open('https://site.example/'), /EPROTO/);
});

test('précédent / suivant / recharger', async () => {
  const { browser } = makeBrowser();
  const ctx = browser.newContext();
  await browser.open(`${server.url}/index.html`, { context: ctx });
  await browser.open(`${server.url}/python.html`, { context: ctx });
  await browser.open(`${server.url}/rust.html`, { context: ctx });
  assert.equal((await browser.back(ctx)).title, 'Le langage Python');
  assert.equal((await browser.back(ctx)).title, 'Accueil du site de test');
  assert.equal(await browser.back(ctx), null);
  assert.equal((await browser.forward(ctx)).title, 'Le langage Python');
  await browser.open(`${server.url}/docs/guide.html`, { context: ctx });
  assert.equal(ctx.canGoForward(), false);
  assert.equal((await browser.reload(ctx)).title, "Guide d'utilisation");
});

test('texte brut, fichier binaire et téléchargement', async () => {
  const { browser } = makeBrowser();
  const txt = await browser.open(`${server.url}/notes.txt`);
  assert.equal(txt.kind, 'text');
  assert.equal(txt.text, 'Simple texte.');
  const bin = await browser.open(`${server.url}/file.bin`);
  assert.equal(bin.kind, 'binary');
  const file = await browser.download(`${server.url}/file.bin`);
  assert.match(file, /données\.bin$/);
  assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3]);
});

test('adresses .onion : passent par Tor, erreur claire si Tor est absent', async () => {
  const onion = await makeOnion('browser');
  const socks = await startSocksServer({ resolve: () => ({ host: '127.0.0.1', port: server.port }) });
  const tor = new Tor({ host: '127.0.0.1', port: socks.port });
  const { browser } = makeBrowser({ tor, torClient: new HttpClient({ proxy: tor.proxyUrl, torSafe: true }) });
  const page = await browser.open(`${onion}/python.html`);
  assert.equal(page.network, 'onion');
  assert.equal(page.url, `http://${onion}/python.html`);
  assert.equal(socks.seen[0].host, onion);
  await socks.close();

  const deadTor = new Tor({ host: '127.0.0.1', port: await freePort() });
  const { browser: b2 } = makeBrowser({ tor: deadTor, torClient: new HttpClient({ proxy: deadTor.proxyUrl }) });
  await assert.rejects(b2.open(`http://${onion}/`), /Tor injoignable/);
  await assert.rejects(b2.open('pas une url'), /adresse invalide/);
});

test('CookieJar : domaine, chemin, Secure, expiration, domaine étranger refusé', () => {
  const jar = new CookieJar();
  jar.store('https://www.site.test/compte/login', [
    'a=1; Path=/', 'b=2; Domain=site.test; Path=/', 'c=3; Secure', 'd=4; Max-Age=0', 'e=5; Domain=autre.test',
  ]);
  assert.equal(jar.header('https://www.site.test/'), 'a=1; b=2');
  assert.equal(jar.header('https://api.site.test/'), 'b=2');
  assert.equal(jar.header('https://www.site.test/compte/x'), 'c=3; a=1; b=2');
  assert.equal(jar.header('http://www.site.test/compte/x'), 'a=1; b=2');
  const ctx = new Context({ cookies: false });
  ctx.storeCookies('https://x.test/', ['a=1']);
  assert.equal(ctx.cookieHeader('https://x.test/'), '');
});

test('BrowserPool : taille maximale, file d’attente, ressource défectueuse', async () => {
  let created = 0;
  const destroyed = [];
  const pool = new BrowserPool({ size: 2, create: async () => ({ id: ++created }), destroy: async (r) => destroyed.push(r.id), acquireTimeoutMs: 200 });
  const a = await pool.acquire();
  const b = await pool.acquire();
  const waiting = pool.acquire();
  pool.release(a);
  assert.equal((await waiting).id, a.id);
  await assert.rejects(pool.use(async () => { throw new Error('plantage'); }), /plantage|délai/);
  pool.release(b);
  await assert.rejects(pool.use(async () => { throw new Error('plantage'); }), /plantage/);
  assert.ok(destroyed.length >= 1);
  const r = await pool.use(async (res) => res.id);
  assert.ok(r >= 1);
  await pool.close();
  await assert.rejects(pool.acquire(), /fermé/);
});
