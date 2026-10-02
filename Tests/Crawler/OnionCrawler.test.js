import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../../Src/Backend/Storage/Database.js';
import { Indexer } from '../../Src/Backend/Crawler/Indexer/Indexer.js';
import { SearchIndex } from '../../Src/Backend/Crawler/Indexer/SearchIndex.js';
import { OnionCrawler } from '../../Src/Backend/Crawler/Onion-Crawler/OnionCrawler.js';
import { OnionValidator, isValidOnionV3, onionAddress } from '../../Src/Backend/Crawler/Onion-Crawler/OnionValidator.js';
import { extractOnionAddresses, parseOnionPage } from '../../Src/Backend/Crawler/Onion-Crawler/OnionParser.js';
import { Tor } from '../../Src/Backend/Network/Tor.js';
import { startServer, startSocksServer, makeOnion, freePort, tmpDir } from '../helpers.js';

let A; let B; let C; let BLOCKED;
let site; let socks;

before(async () => {
  [A, B, C, BLOCKED] = await Promise.all(['a', 'b', 'c', 'blocked'].map(makeOnion));
  const pages = {
    [A]: `<html><head><title>Annuaire A</title></head><body><p>Bienvenue sur l'annuaire.
      Services : ${B} (en texte brut) et <a href="http://${C}/page">le service C</a>.
      Aussi <a href="http://${BLOCKED}/">bloqué</a> et <a href="https://clearnet.example/">clearnet</a>.</p></body></html>`,
    [B]: '<html><head><title>Service B</title></head><body><p>Forum caché : cryptographie.</p></body></html>',
    [C]: '<html><head><title>Service C</title></head><body><p>Bibliothèque : manuscrits anciens.</p></body></html>',
    [BLOCKED]: '<html><body>ne doit jamais être contacté</body></html>',
  };
  site = await startServer({
    routes: {
      '/': (req, res) => {
        const host = req.headers.host.split(':')[0];
        res.writeHead(pages[host] ? 200 : 404, { 'content-type': 'text/html' });
        res.end(pages[host] ?? 'inconnu');
      },
      '/page': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(pages[req.headers.host.split(':')[0]]);
      },
      '/robots.txt': (req, res) => {
        res.writeHead(404);
        res.end();
      },
    },
  });
  // Le faux Tor ne connaît que les .onion : tout le reste est refusé
  socks = await startSocksServer({ resolve: (host) => (host.endsWith('.onion') ? { host: '127.0.0.1', port: site.port } : null) });
});

after(async () => {
  await socks.close();
  await site.close();
});

test('OnionValidator : v3 valide, somme fausse, v2, clearnet, liste noire (adresse ou MD5)', async () => {
  assert.equal(isValidOnionV3(A), true);
  assert.equal(isValidOnionV3(`www.${A}`), true);
  assert.equal(onionAddress(`sub.${A}`), A);
  const broken = `${A.slice(0, 50)}${A[50] === 'a' ? 'b' : 'a'}${A.slice(51)}`;
  assert.equal(isValidOnionV3(broken), false);
  assert.equal(isValidOnionV3('expyuzz4wqqyqhjn.onion'), false);
  const md5 = crypto.createHash('md5').update(BLOCKED).digest('hex');
  const dir = tmpDir();
  const file = path.join(dir, 'blocklist.txt');
  fs.writeFileSync(file, `# liste\n${md5}\n`);
  const v = new OnionValidator({ blocklistFile: file });
  assert.equal(v.accepts(`http://${A}/`).ok, true);
  assert.equal(v.accepts(`http://${BLOCKED}/`).ok, false);
  assert.equal(v.accepts('https://example.com/').ok, false);
  assert.equal(new OnionValidator({ allowClearnet: true }).accepts('https://example.com/').ok, true);
});

test('OnionParser : adresses citées en texte brut', () => {
  assert.deepEqual(extractOnionAddresses(`voir ${B.toUpperCase()} et ${B} ou abc.onion`), [B]);
  const page = parseOnionPage(`<p>${B}</p><a href="http://${C}/">c</a>`, `http://${A}/`);
  assert.deepEqual(page.extraLinks, [`http://${B}/`]);
});

test('explore les services onion via Tor (SOCKS5, DNS distant), sans jamais sortir du réseau onion', async () => {
  const db = new Database(':memory:');
  const search = new SearchIndex(db);
  const crawler = new OnionCrawler({
    tor: new Tor({ host: socks.host, port: socks.port }),
    indexer: new Indexer(db), delayMs: 0, maxDepth: 2, blocklist: [BLOCKED],
  });
  const r = await crawler.crawl([`http://${A}/`]);
  assert.equal(r.indexed, 3);
  const hosts = new Set(socks.seen.map((s) => s.host));
  assert.ok(hosts.has(B) && hosts.has(C));
  assert.ok(!hosts.has(BLOCKED), 'service sur liste noire contacté');
  assert.ok(!hosts.has('clearnet.example'), 'fuite vers le web classique');
  assert.ok(socks.seen.every((s) => s.atyp === 0x03), 'résolution DNS locale');
  assert.equal(site.requests.filter((q) => q.headers['user-agent'].includes('WebBrowser')).length, 0, 'User-Agent identifiable');
  const hit = search.search('manuscrits');
  assert.equal(hit.results[0].network, 'onion');
  assert.equal(search.count({ network: 'onion' }), 3);
});

test('refuse de démarrer si Tor est injoignable', async () => {
  const crawler = new OnionCrawler({ tor: new Tor({ host: '127.0.0.1', port: await freePort() }) });
  await assert.rejects(crawler.crawl([`http://${A}/`]), /Tor injoignable/);
});
