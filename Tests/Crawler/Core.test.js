import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../../Src/Backend/Crawler/Core/Queue.js';
import { Scheduler } from '../../Src/Backend/Crawler/Core/Scheduler.js';
import { Deduplicator } from '../../Src/Backend/Crawler/Core/Deduplicator.js';

test('Queue : FIFO et compaction', () => {
  const q = new Queue([1, 2]);
  for (let i = 3; i <= 3000; i++) q.push(i);
  for (let i = 1; i <= 2500; i++) assert.equal(q.shift(), i);
  assert.equal(q.size, 500);
  assert.equal(q.peek(), 2501);
  assert.deepEqual([...q].slice(0, 2), [2501, 2502]);
  q.clear();
  assert.equal(q.shift(), undefined);
});

test('Deduplicator : URL et contenu', () => {
  const d = new Deduplicator();
  assert.equal(d.markUrl('http://a/'), true);
  assert.equal(d.markUrl('http://a/'), false);
  assert.equal(d.markContent('Bonjour  le\nmonde').duplicate, false);
  assert.equal(d.markContent('bonjour le monde').duplicate, true);
});

test('Scheduler : politesse par hôte et tourniquet', () => {
  const s = new Scheduler({ delayMs: 1000 });
  s.add({ url: 'http://a.test/1' });
  s.add({ url: 'http://a.test/2' });
  s.add({ url: 'http://b.test/1' });
  const t0 = 10_000;
  const first = s.next(t0);
  assert.equal(first.task.url, 'http://a.test/1');
  const second = s.next(t0);
  assert.equal(second.task.url, 'http://b.test/1'); // a.test occupé → b.test
  const wait = s.next(t0);
  assert.ok(wait.waitMs > 0); // a.test : une requête à la fois
  s.done(first.task, t0 + 10);
  assert.ok(s.next(t0 + 500).waitMs >= 500); // délai de politesse
  assert.equal(s.next(t0 + 1010).task.url, 'http://a.test/2');
  s.done(second.task);
  assert.equal(s.next(t0 + 5000), null); // file vide
});

test('Scheduler : Crawl-delay plafonné', () => {
  const s = new Scheduler({ delayMs: 100 });
  s.setCrawlDelay('a.test', 5);
  assert.equal(s.hostState('a.test').delayMs, 5000);
  s.setCrawlDelay('a.test', 9999);
  assert.equal(s.hostState('a.test').delayMs, 60000);
});
