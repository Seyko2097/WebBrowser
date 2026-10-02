import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { HttpClient } from '../../Src/Backend/Network/HttpClient.js';
import { Cache } from '../../Src/Backend/Storage/Cache.js';
import { buildHeaders, parseContentType } from '../../Src/Backend/Network/Headers.js';
import { Context } from '../../Src/Backend/Browser/Context.js';
import { startServer, tmpDir } from '../helpers.js';

let server;
let hits = 0;

before(async () => {
  server = await startServer({
    routes: {
      '/gzip': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync('<p>compressé gzip</p>'));
      },
      '/br': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' });
        res.end(zlib.brotliCompressSync('brotli ok'));
      },
      '/latin1': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=ISO-8859-1' });
        res.end(Buffer.from('<p>caf\xe9</p>', 'latin1'));
      },
      '/meta-charset': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>'), Buffer.from([0xe9, 0x80]), Buffer.from('</p>')]));
      },
      '/r1': (req, res) => { res.writeHead(302, { location: '/r2' }); res.end(); },
      '/r2': (req, res) => { res.writeHead(301, { location: '/python.html' }); res.end(); },
      '/loop': (req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); },
      '/big': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(100_000));
      },
      '/slow': () => {},
      '/cookie': (req, res) => {
        res.writeHead(200, { 'set-cookie': ['session=abc; Path=/', 'pref=fr; Max-Age=3600'], 'content-type': 'text/plain' });
        res.end(req.headers.cookie ?? '');
      },
      '/count': (req, res) => {
        hits++;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`appel ${hits}`);
      },
      '/headers': (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.headers));
      },
    },
  });
});

after(() => server.close());

test('décompression gzip et brotli', async () => {
  const c = new HttpClient();
  assert.equal((await c.get(`${server.url}/gzip`)).text(), '<p>compressé gzip</p>');
  assert.equal((await c.get(`${server.url}/br`)).text(), 'brotli ok');
});

test('encodages : en-tête ISO-8859-1 et <meta charset>', async () => {
  const c = new HttpClient();
  assert.equal((await c.get(`${server.url}/latin1`)).text(), '<p>café</p>');
  assert.match((await c.get(`${server.url}/meta-charset`)).text(), /<p>é.<\/p>/);
});

test('redirections suivies, boucle limitée', async () => {
  const c = new HttpClient({ maxRedirects: 3 });
  const res = await c.get(`${server.url}/r1`);
  assert.equal(res.status, 200);
  assert.equal(res.url, `${server.url}/python.html`);
  assert.equal(res.redirects.length, 2);
  const loop = await c.get(`${server.url}/loop`);
  assert.equal(loop.status, 302);
});

test('taille maximale et délai dépassé', async () => {
  const c = new HttpClient({ maxBytes: 1000, timeoutMs: 300 });
  const res = await c.get(`${server.url}/big`);
  assert.equal(res.body.length, 1000);
  assert.equal(res.truncated, true);
  await assert.rejects(c.get(`${server.url}/slow`), /délai dépassé/);
  await assert.rejects(c.get('http://127.0.0.1:1/'), /ECONNREFUSED/);
});

test('cookies via un contexte de navigation', async () => {
  const c = new HttpClient();
  const ctx = new Context();
  assert.equal((await c.get(`${server.url}/cookie`, { context: ctx })).text(), '');
  assert.equal((await c.get(`${server.url}/cookie`, { context: ctx })).text(), 'session=abc; pref=fr');
});

test('cache mémoire et disque', async () => {
  const dir = tmpDir();
  const c = new HttpClient({ cache: new Cache({ dir }) });
  const a = await c.get(`${server.url}/count`);
  const b = await c.get(`${server.url}/count`);
  assert.equal(a.text(), b.text());
  assert.equal(b.fromCache, true);
  const c2 = new HttpClient({ cache: new Cache({ dir }) }); // nouveau processus : lecture disque
  assert.equal((await c2.get(`${server.url}/count`)).text(), a.text());
  assert.notEqual((await c.get(`${server.url}/count`, { noCache: true })).text(), a.text());
});

test('en-têtes : User-Agent, et en-têtes génériques en mode Tor', async () => {
  const normal = JSON.parse((await new HttpClient({ userAgent: 'WebBrowser/test' }).get(`${server.url}/headers`)).text());
  assert.equal(normal['user-agent'], 'WebBrowser/test');
  assert.match(normal['accept-encoding'], /gzip/);
  const tor = JSON.parse((await new HttpClient({ userAgent: 'WebBrowser/test', torSafe: true }).get(`${server.url}/headers`)).text());
  assert.match(tor['user-agent'], /Firefox/);
  assert.equal(tor['accept-language'], 'en-US,en;q=0.5');
  assert.deepEqual(parseContentType('Text/HTML; Charset="UTF-8"'), { mime: 'text/html', charset: 'utf-8' });
  assert.equal(buildHeaders({ userAgent: 'x', extra: { accept: null } }).accept, undefined);
});
