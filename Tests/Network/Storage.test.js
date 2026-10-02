import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Cache } from '../../Src/Backend/Storage/Cache.js';
import { Database, HistoryStore } from '../../Src/Backend/Storage/Database.js';
import { safeFilename, uniquePath, filenameFromResponse, saveDownload, formatBytes } from '../../Src/Backend/Storage/Files.js';
import { Config } from '../../Src/Backend/Utils/Config.js';
import { normalizeUrl, looksLikeUrl, withScheme, isPrivateHost, hasBinaryExtension } from '../../Src/Backend/Utils/Validator.js';
import { tmpDir } from '../helpers.js';

test('Cache : LRU, expiration, nettoyage', async () => {
  const dir = tmpDir();
  const cache = new Cache({ dir, memoryItems: 2, ttlMs: 50 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.memory.size, 2);
  assert.equal(cache.get('a'), 1); // relu depuis le disque
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cache.get('b'), undefined);
  cache.set('d', 4, 10_000);
  assert.ok(cache.prune() >= 1);
  assert.equal(cache.get('d'), 4);
  cache.clear();
  assert.equal(cache.get('d'), undefined);
});

test('Database : migrations idempotentes, transactions imbriquées', () => {
  const file = path.join(tmpDir(), 'idx', 'test.db');
  const db = new Database(file);
  db.close();
  const db2 = new Database(file);
  assert.throws(() => db2.transaction(() => {
    db2.run('INSERT INTO history(kind, value, created_at) VALUES (?, ?, ?)', 'search', 'x', 1);
    throw new Error('annulé');
  }), /annulé/);
  assert.equal(db2.get('SELECT COUNT(*) AS n FROM history').n, 0);
  db2.transaction(() => {
    db2.run('INSERT INTO history(kind, value, created_at) VALUES (?, ?, ?)', 'search', 'a', 1);
    try {
      db2.transaction(() => {
        db2.run('INSERT INTO history(kind, value, created_at) VALUES (?, ?, ?)', 'search', 'b', 1);
        throw new Error('interne');
      });
    } catch { /* attendu */ }
  });
  assert.deepEqual(db2.all('SELECT value FROM history').map((r) => r.value), ['a']);
  db2.close();
});

test('HistoryStore : ajout, dédoublonnage, filtre, suppression', () => {
  const h = new HistoryStore(new Database(':memory:'));
  h.addSearch('chats');
  h.addSearch('chats');
  h.addVisit('https://a.test/', 'Page A');
  h.addSearch('  ');
  assert.equal(h.count(), 2);
  assert.equal(h.list({ kind: 'visit' })[0].title, 'Page A');
  assert.equal(h.list({ filter: 'chat' }).length, 1);
  assert.equal(h.remove(h.list()[0].id), true);
  assert.equal(h.clear(), 1);
});

test('Files : noms sûrs, collisions, téléchargements', () => {
  assert.equal(safeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(safeFilename(''), 'fichier');
  assert.equal(filenameFromResponse('https://a.test/docs/rapport%20final.pdf', 'application/pdf'), 'rapport final.pdf');
  assert.equal(filenameFromResponse('https://a.test/', 'text/html'), 'a.test.html');
  assert.equal(filenameFromResponse('https://a.test/x', 'text/plain', 'attachment; filename="note.txt"'), 'note.txt');
  const dir = tmpDir();
  const f1 = saveDownload(dir, { url: 'https://a.test/f.txt', body: Buffer.from('1'), mime: 'text/plain' });
  const f2 = saveDownload(dir, { url: 'https://a.test/f.txt', body: Buffer.from('2'), mime: 'text/plain' });
  assert.equal(path.basename(f2), 'f (2).txt');
  assert.equal(fs.readFileSync(f1, 'utf8'), '1');
  assert.equal(uniquePath(dir, 'nouveau.txt'), path.join(dir, 'nouveau.txt'));
  assert.equal(formatBytes(1536), '1.5 Ko');
});

test('Config : valeurs par défaut, réglages enregistrés, variables d’environnement, mode système (XDG)', () => {
  const dir = tmpDir();
  const settingsFile = path.join(dir, 'settings.json');
  const c = new Config({ settingsFile, env: { WEBBROWSER_TOR_PORT: '9150' } });
  assert.equal(c.get('tor.port'), 9150);
  assert.equal(c.get('crawler.maxPages'), 100);
  c.set('crawler.maxPages', 7);
  c.save();
  assert.equal(new Config({ settingsFile, env: {} }).get('crawler.maxPages'), 7);
  const sys = new Config({ env: { WEBBROWSER_MODE: 'system', HOME: '/home/alice', WEBBROWSER_SYSTEM_CONFIG: '/nonexistent' } });
  assert.equal(sys.mode, 'system');
  assert.equal(sys.path('database.file'), '/home/alice/.local/share/webbrowser/Index/index.db');
  assert.equal(sys.settingsFile, '/home/alice/.config/webbrowser/settings.json');
  assert.equal(sys.path('paths.cache'), '/home/alice/.cache/webbrowser');
});

test('Validator', () => {
  assert.equal(normalizeUrl('HTTP://Exemple.FR:80/a/../b?utm_source=x&q=1#frag'), 'http://exemple.fr/b?q=1');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('/rel', 'https://a.test/x/'), 'https://a.test/rel');
  assert.equal(looksLikeUrl('exemple.fr'), true);
  assert.equal(looksLikeUrl('exemple.fr/page?x=1'), true);
  assert.equal(looksLikeUrl('chat noir'), false);
  assert.equal(looksLikeUrl('node.js'), true);
  assert.equal(looksLikeUrl('bonjour'), false);
  assert.equal(withScheme('abc.onion/x'), 'http://abc.onion/x');
  assert.equal(withScheme('exemple.fr'), 'https://exemple.fr');
  assert.equal(withScheme('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.equal(withScheme('ftp://x'), 'ftp://x');
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('[::1]'), true);
  assert.equal(isPrivateHost('172.20.0.1'), true);
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(hasBinaryExtension('https://a.test/x.JPG'), true);
  assert.equal(hasBinaryExtension('https://a.test/x.html'), false);
});
