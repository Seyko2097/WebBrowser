import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../Src/Backend/Storage/Database.js';
import { Indexer } from '../../Src/Backend/Crawler/Indexer/Indexer.js';
import { SearchIndex, buildFtsQuery, HL_START } from '../../Src/Backend/Crawler/Indexer/SearchIndex.js';
import { Document } from '../../Src/Backend/Crawler/Indexer/Document.js';

let db;
let indexer;
let search;

beforeEach(() => {
  db = new Database(':memory:');
  indexer = new Indexer(db);
  search = new SearchIndex(db);
  indexer.add(new Document({ url: 'http://a.test/1', title: "Éléphants d'Afrique", body: 'Les éléphants vivent en troupeaux.', links: ['http://a.test/2'] }));
  indexer.add(new Document({ url: 'http://a.test/2', title: 'Python', body: "Un langage. On parle aussi d'éléphants ici." }));
  indexer.add(new Document({ url: 'http://b.test/3', title: 'Rust', body: 'Un autre langage.', description: 'Langage système' }));
  indexer.add(new Document({ url: 'http://x.onion/', title: 'Annuaire', body: 'Un langage caché.', network: 'onion' }));
});

test('buildFtsQuery : préfixe, phrases, exclusions, site:, saisie hostile', () => {
  assert.deepEqual(buildFtsQuery('pyth'), { match: '"pyth"*', site: null });
  assert.deepEqual(buildFtsQuery('python '), { match: '"python"', site: null });
  assert.equal(buildFtsQuery('"moteur de recherche" -google').match, '"moteur de recherche" NOT "google"');
  assert.deepEqual(buildFtsQuery('langage site:B.test'), { match: '"langage"', site: 'b.test' });
  assert.equal(buildFtsQuery('a" OR (').match, '"a"*');
  assert.equal(buildFtsQuery('  ').match, '');
});

test('recherche insensible aux accents, titre favorisé, extraits surlignés', () => {
  const { results, total } = search.search('elephant');
  assert.equal(total, 2);
  assert.equal(results[0].url, 'http://a.test/1');
  assert.ok(results[0].snippet.includes(HL_START));
});

test('NOT, site:, filtre réseau, saisie bizarre', () => {
  assert.equal(search.search('langage -rust').total, 2);
  assert.equal(search.search('langage site:b.test').total, 1);
  assert.equal(search.search('langage', { network: 'onion' }).total, 1);
  assert.equal(search.search('langage', { network: 'web' }).total, 2);
  for (const q of ['"', '(', '*', 'NOT', 'a AND', '-', '"ouvert', 'site:', ')))']) search.search(q);
});

test('mise à jour d’une page et suppression', () => {
  indexer.add(new Document({ url: 'http://b.test/3', title: 'Rust', body: 'Plus rien à voir.' }));
  assert.equal(search.search('langage ').total, 2);
  assert.equal(search.count(), 4);
  assert.equal(indexer.remove('http://b.test/3'), true);
  assert.equal(search.count(), 3);
  assert.equal(indexer.clear('onion'), 1);
  assert.equal(search.count(), 2);
});

test('liens sortants et rétroliens', () => {
  assert.deepEqual(indexer.getLinks('http://a.test/1'), ['http://a.test/2']);
  assert.deepEqual(indexer.backlinks('http://a.test/2').map((r) => r.url), ['http://a.test/1']);
  assert.ok(indexer.fetchedAt('http://a.test/1') > 0);
  assert.equal(indexer.fetchedAt('http://nope/'), null);
});

test('statistiques', () => {
  const s = search.stats();
  assert.equal(s.total, 4);
  assert.equal(s.web, 3);
  assert.equal(s.onion, 1);
  assert.equal(s.hosts, 3);
  assert.equal(search.get('http://a.test/2').title, 'Python');
  assert.equal(search.recent({ limit: 2 }).length, 2);
});
