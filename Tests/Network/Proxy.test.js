import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { parseProxyUrl, socksConnect } from '../../Src/Backend/Network/Proxy.js';
import { HttpClient } from '../../Src/Backend/Network/HttpClient.js';
import { Tor } from '../../Src/Backend/Network/Tor.js';
import { startServer, startSocksServer, freePort } from '../helpers.js';

let site;

before(async () => {
  site = await startServer();
});

after(() => site.close());

test('parseProxyUrl', () => {
  assert.deepEqual(parseProxyUrl('socks5h://u:p%40ss@127.0.0.1:9050'), { protocol: 'socks5', host: '127.0.0.1', port: 9050, username: 'u', password: 'p@ss' });
  assert.equal(parseProxyUrl('127.0.0.1:9150').port, 9150);
  assert.equal(parseProxyUrl('http://proxy:3128').protocol, 'http');
  assert.throws(() => parseProxyUrl('ftp://x:1'), /non supporté/);
  assert.equal(parseProxyUrl(null), null);
});

test('SOCKS5 avec authentification, nom d’hôte transmis au proxy', async () => {
  const socks = await startSocksServer({ auth: { username: 'moi', password: 'secret' }, resolve: () => ({ host: '127.0.0.1', port: site.port }) });
  const ok = new HttpClient({ proxy: `socks5://moi:secret@127.0.0.1:${socks.port}` });
  const res = await ok.get('http://site-distant.test/python.html');
  assert.equal(res.status, 200);
  assert.match(res.text(), /Python/);
  assert.equal(socks.seen[0].host, 'site-distant.test');
  const bad = new HttpClient({ proxy: `socks5://moi:faux@127.0.0.1:${socks.port}` });
  await assert.rejects(bad.get('http://site-distant.test/'), /authentification SOCKS refusée/);
  await socks.close();
});

test('SOCKS5 : codes d’erreur de Tor traduits', async () => {
  const socks = await startSocksServer({ resolve: () => null, failCode: 0xf0 });
  await assert.rejects(
    socksConnect({ proxyHost: '127.0.0.1', proxyPort: socks.port, host: 'x.onion', port: 80 }),
    /descripteur du service onion introuvable/,
  );
  await socks.close();
  await assert.rejects(
    socksConnect({ proxyHost: '127.0.0.1', proxyPort: await freePort(), host: 'a', port: 80 }),
    /injoignable/,
  );
});

test('proxy HTTP (CONNECT)', async () => {
  const targets = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, client) => {
    targets.push(req.url);
    const upstream = net.connect(site.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client).pipe(upstream);
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const c = new HttpClient({ proxy: `http://127.0.0.1:${proxy.address().port}` });
  const res = await c.get('http://via-proxy.test/rust.html');
  assert.match(res.text(), /Rust/);
  assert.deepEqual(targets, ['via-proxy.test:80']);
  proxy.closeAllConnections();
  await new Promise((r) => proxy.close(r));
});

test('Tor : disponibilité et port de contrôle (NEWNYM)', async () => {
  const socks = await startSocksServer({ resolve: () => null });
  assert.equal(await new Tor({ host: '127.0.0.1', port: socks.port }).isAvailable(), true);
  assert.equal(await new Tor({ host: '127.0.0.1', port: await freePort() }).isAvailable(500), false);
  await socks.close();

  const received = [];
  const control = net.createServer((sock) => {
    sock.on('data', (d) => {
      for (const line of d.toString().split('\r\n').filter(Boolean)) {
        received.push(line);
        sock.write(line === 'QUIT' ? '250 closing connection\r\n' : '250 OK\r\n');
      }
    });
  });
  await new Promise((r) => control.listen(0, '127.0.0.1', r));
  const tor = new Tor({ host: '127.0.0.1', controlPort: control.address().port, controlPassword: 'mot"de"passe' });
  await tor.newIdentity();
  assert.deepEqual(received, ['AUTHENTICATE "mot\\"de\\"passe"', 'SIGNAL NEWNYM', 'QUIT']);
  await new Promise((r) => control.close(r));
});
