import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../../Src/Backend/App.js';
import { ApiServer } from '../../Src/Backend/API/Server.js';
import { Config } from '../../Src/Backend/Utils/Config.js';
import { Logger } from '../../Src/Backend/Utils/Logger.js';
import { Document } from '../../Src/Backend/Crawler/Indexer/Document.js';
import { startServer, tmpDir, freePort } from '../helpers.js';

let site;
let app;
let api;
let base;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  site = await startServer();
  const home = tmpDir();
  const config = new Config({
    env: { WEBBROWSER_HOME: home },
    overrides: { crawler: { allowPrivateHosts: true, delayMs: 0 }, tor: { port: await freePort() } },
  });
  app = new App({ config, logger: Logger.silent() });
  app.indexer.add(new Document({ url: 'https://a.test/', title: 'Chats', body: 'Les chats dorment beaucoup.' }));
  api = new ApiServer({ app, port: 0, version: 'test' });
  const { port } = await api.start();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await api.stop();
  await app.close();
  await site.close();
});

test('santé, liste des routes, erreurs 404/405', async () => {
  assert.deepEqual((await call('GET', '/api/health')).data, { ok: true, version: 'test' });
  assert.ok((await call('GET', '/api')).data.routes.length > 5);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('PUT', '/api/search')).status, 405);
});

test('recherche', async () => {
  const { data } = await call('GET', '/api/search?q=chat&highlight=html&record=1');
  assert.equal(data.total, 1);
  assert.match(data.results[0].snippet, /<mark>chats<\/mark>/);
  assert.equal((await call('GET', '/api/search')).status, 400);
  assert.equal((await call('GET', '/api/history?kind=search')).data.entries[0].value, 'chat');
  assert.equal((await call('GET', '/api/documents?url=https://a.test/')).data.title, 'Chats');
  assert.equal((await call('GET', '/api/documents?url=https://b.test/')).status, 404);
});

test('exploration en arrière-plan', async () => {
  const start = await call('POST', '/api/crawl', { urls: [`${site.url}/index.html`], maxPages: 3, maxDepth: 1 });
  assert.equal(start.status, 202);
  let job = start.data;
  for (let i = 0; i < 100 && job.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    job = (await call('GET', `/api/crawl/${job.id}`)).data;
  }
  assert.equal(job.status, 'done');
  assert.equal(job.stats.indexed, 3);
  assert.equal((await call('GET', '/api/crawl')).data.jobs.length, 1);
  assert.equal((await call('POST', '/api/crawl', { urls: 'pas une liste' })).status, 400);
  assert.equal((await call('POST', '/api/crawl', { urls: ['ftp://x'] })).status, 400);
  assert.equal((await call('DELETE', '/api/crawl/999')).status, 404);
  const stats = (await call('GET', '/api/stats')).data;
  assert.equal(stats.index.total, 4);
  assert.equal(stats.tor.available, false);
});

test('page via le navigateur, protection contre les adresses locales', async () => {
  const ok = await call('GET', `/api/page?url=${encodeURIComponent(`${site.url}/rust.html`)}`);
  assert.equal(ok.data.title, 'Le langage Rust');
  app.config.data.crawler.allowPrivateHosts = false;
  const strict = new ApiServer({ app, port: 0 });
  const { port } = await strict.start();
  const res = await fetch(`http://127.0.0.1:${port}/api/page?url=${encodeURIComponent(`${site.url}/`)}`);
  assert.equal(res.status, 400);
  await strict.stop();
});

test('JSON invalide', async () => {
  const res = await fetch(`${base}/api/crawl`, { method: 'POST', body: '{oups' });
  assert.equal(res.status, 400);
});
