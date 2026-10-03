import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../Src/Backend/Storage/Database.js';
import { Frontier } from '../../Src/Backend/Server/Frontier.js';
import { SeedStore } from '../../Src/Backend/Server/SeedStore.js';
import { RateLimiter } from '../../Src/Backend/Server/RateLimiter.js';

function setup() {
  let t = 1_000_000;
  const db = new Database(':memory:');
  const frontier = new Frontier(db, { now: () => t });
  return { db, frontier, seeds: new SeedStore(db, frontier), advance: (ms) => { t += ms; }, now: () => t };
}

test('ajout sans doublon, réservation répartie entre les sites', () => {
  const { frontier } = setup();
  assert.equal(frontier.add('http://a.test/1'), true);
  assert.equal(frontier.add('http://a.test/1'), false);
  frontier.addMany(['http://a.test/2', 'http://a.test/3', 'http://a.test/4', 'http://b.test/1'].map((url) => ({ url, depth: 1 })));
  const tasks = frontier.lease({ hosts: 10, perHost: 2 });
  assert.deepEqual(tasks.map((t) => t.url).sort(), ['http://a.test/1', 'http://a.test/2', 'http://b.test/1']);
  assert.equal(tasks.find((t) => t.url === 'http://a.test/1').depth, 0);
  // déjà réservées : pas redistribuées
  assert.equal(frontier.lease({ hosts: 10, perHost: 5 }).length, 0);
});

test('réservations expirées ou libérées au redémarrage', () => {
  const { frontier, advance } = setup();
  frontier.add('http://a.test/1');
  assert.equal(frontier.lease({ leaseMs: 1000 }).length, 1);
  advance(10_000);
  assert.equal(frontier.lease({ leaseMs: 1000 }).length, 1, 'réservation expirée redistribuée');
  assert.equal(frontier.releaseLeases(), 1);
});

test('succès : replanifié pour la réexploration, première indexation signalée une seule fois', () => {
  const { frontier, advance } = setup();
  frontier.add('http://a.test/1');
  frontier.lease();
  assert.deepEqual(frontier.complete('http://a.test/1', { nextAt: 1_000_000 + 5000, indexed: true }), { firstIndex: true });
  assert.equal(frontier.lease().length, 0);
  advance(6000);
  const again = frontier.lease();
  assert.equal(again.length, 1);
  assert.deepEqual(frontier.complete('http://a.test/1', { indexed: true }), { firstIndex: false });
  assert.equal(frontier.counts().indexed, 1);
});

test('erreurs : délai croissant puis abandon', () => {
  const { frontier, advance } = setup();
  frontier.add('http://a.test/1');
  for (let i = 0; i < 4; i++) {
    frontier.lease();
    assert.equal(frontier.fail('http://a.test/1', { maxAttempts: 5 }), 'retry');
    assert.equal(frontier.lease().length, 0, 'retenté trop tôt');
    advance(3600_000 * 2 ** i + 1);
  }
  frontier.lease();
  assert.equal(frontier.fail('http://a.test/1', { maxAttempts: 5 }), 'dead');
  assert.equal(frontier.counts().dead, 1);
  advance(30 * 24 * 3600_000);
  assert.equal(frontier.lease().length, 0);
  assert.equal(frontier.prioritize('http://a.test/1'), true);
  assert.equal(frontier.lease().length, 1);
});

test('sites de départ : ajout, limites, suppression', () => {
  const { seeds, frontier } = setup();
  const s = seeds.add('https://www.exemple.fr/', { maxDepth: 2, maxPages: 2 });
  assert.equal(s.created, true);
  assert.equal(seeds.add('https://www.exemple.fr/', { maxDepth: 4, maxPages: 2 }).created, false);
  const seed = seeds.cached(s.id);
  assert.equal(seed.maxDepth, 4);
  assert.equal(seeds.accepts(seed, 'https://exemple.fr/a', 1), true);
  assert.equal(seeds.accepts(seed, 'https://blog.exemple.fr/a', 1), true);
  assert.equal(seeds.accepts(seed, 'https://autre.fr/a', 1), false);
  assert.equal(seeds.accepts(seed, 'https://exemple.fr/a', 5), false);
  seeds.incrementIndexed(s.id);
  seeds.incrementIndexed(s.id);
  assert.equal(seeds.accepts(seeds.cached(s.id), 'https://exemple.fr/b', 1), false, 'limite de pages');
  frontier.add('https://exemple.fr/x', { seedId: s.id, depth: 1 });
  assert.equal(seeds.remove(s.id).removedUrls, 2);
  assert.equal(seeds.list().length, 0);
  assert.throws(() => seeds.add('pas une url'), /invalide/);
});

test('RateLimiter : rafale puis refus, recharge dans le temps', () => {
  const rl = new RateLimiter({ perMinute: 60, burst: 3 });
  const t = 0;
  assert.ok(rl.take('a', t).ok && rl.take('a', t).ok && rl.take('a', t).ok);
  const refused = rl.take('a', t);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 1000);
  assert.equal(rl.take('b', t).ok, true, 'autre client indépendant');
  assert.equal(rl.take('a', t + 1001).ok, true);
});
