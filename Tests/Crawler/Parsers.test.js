import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseHtml, parsePage, decodeEntities } from '../../Src/Backend/Crawler/Parsers/HtmlParser.js';
import { resolveLinks, followableUrls } from '../../Src/Backend/Crawler/Parsers/LinkParser.js';
import { parseMetadata, parseRobotsDirectives } from '../../Src/Backend/Crawler/Parsers/MetadataParser.js';
import { parseRobots, RobotsCache } from '../../Src/Backend/Crawler/Parsers/RobotsParser.js';
import { FIXTURES } from '../helpers.js';

const index = fs.readFileSync(path.join(FIXTURES, 'site/index.html'), 'utf8');

test('HtmlParser : titre, texte visible, scripts et styles ignorés', () => {
  const doc = parseHtml(index);
  assert.equal(doc.title, 'Accueil du site de test');
  assert.equal(doc.lang, 'fr');
  assert.match(doc.text, /moteurs de recherche et d'éléphants ?d'Afrique|moteurs de recherche et d'éléphants d'Afrique/);
  assert.doesNotMatch(doc.text, /motcache|color: red/);
  assert.match(doc.text, /• Python/);
  assert.equal(doc.headings[0].text, 'Bienvenue');
});

test('HtmlParser : entités, commentaires, balises cassées', () => {
  assert.equal(decodeEntities('&eacute;t&eacute; &amp; &#233;&#x41;&lt;&unknown; &#150;'), 'été & éA<&unknown; –');
  const doc = parseHtml('<p>a <!-- caché --> b</p><p>x < y et 3>2</p><svg><text>non</text></svg><p>c</p>');
  assert.equal(doc.text, 'a b\n\nx < y et 3>2\n\nc');
});

test('HtmlParser : marqueurs de liens et texte des ancres', () => {
  const doc = parseHtml('<p>Voir <a href="/a">la page A</a> et <a href="/b"><img alt="logo B"></a></p>');
  assert.equal(doc.anchors.length, 2);
  assert.equal(doc.anchors[0].text, 'la page A');
  assert.equal(doc.anchors[1].text, 'logo B');
  assert.match(doc.markedText, /la page A\u00010\u0002/);
  assert.doesNotMatch(doc.text, /\u0001/);
});

test('LinkParser : résolution, fragments, paramètres de suivi, nofollow, schémas exclus', () => {
  const doc = parseHtml(index);
  const links = resolveLinks(doc, 'http://site.test/index.html');
  const urls = links.map((l) => l.url);
  assert.ok(urls.includes('http://site.test/python.html'));
  assert.ok(urls.includes('http://site.test/rust.html'));
  assert.ok(urls.includes('http://site.test/docs/guide.html'));
  assert.ok(!urls.some((u) => u.startsWith('mailto')));
  const follow = followableUrls(links);
  assert.ok(!follow.includes('http://site.test/sponsor.html'));
  assert.ok(urls.includes('http://site.test/sponsor.html'));
});

test('LinkParser : <base href>', () => {
  const doc = parseHtml('<head><base href="https://cdn.test/dir/"></head><a href="x.html">x</a>');
  assert.equal(resolveLinks(doc, 'https://site.test/')[0].url, 'https://cdn.test/dir/x.html');
});

test('MetadataParser : description, mots-clés, canonique, robots', () => {
  const meta = parseMetadata(parseHtml(index), 'http://site.test/index.html');
  assert.equal(meta.description, 'Un petit site pour tester le crawler.');
  assert.deepEqual(meta.keywords, ['test', 'crawler', 'moteur']);
  assert.equal(meta.canonical, 'http://site.test/index.html');
  assert.equal(meta.robots.noindex, false);
  assert.deepEqual(parseRobotsDirectives('NOINDEX, follow'), { noindex: true, nofollow: false, noarchive: false });
  assert.deepEqual(parseRobotsDirectives('none'), { noindex: true, nofollow: true, noarchive: false });
  const og = parseMetadata(parseHtml('<meta property="og:title" content="OG"><h1>H</h1>'), 'http://x/');
  assert.equal(og.title, 'OG');
});

test('parsePage combine tout', () => {
  const page = parsePage(index, 'http://site.test/');
  assert.equal(page.meta.title, 'Accueil du site de test');
  assert.ok(page.links.length >= 8);
});

test('RobotsParser : groupes, règle la plus longue, jokers, Crawl-delay', () => {
  const rules = parseRobots(`
    # commentaire
    User-agent: *
    Disallow: /prive/
    Allow: /prive/public.html
    Disallow: /*.pdf$
    Crawl-delay: 2

    User-agent: WebBrowser
    User-agent: autre
    Disallow: /interdit
    Sitemap: https://site.test/sitemap.xml
  `);
  assert.equal(rules.isAllowed('/prive/x.html', 'Google'), false);
  assert.equal(rules.isAllowed('/prive/public.html', 'Google'), true);
  assert.equal(rules.isAllowed('/doc.pdf', 'Google'), false);
  assert.equal(rules.isAllowed('/doc.pdf?x=1', 'Google'), true);
  assert.equal(rules.crawlDelay('Google'), 2);
  // groupe spécifique : remplace le groupe '*'
  assert.equal(rules.isAllowed('/prive/x.html', 'WebBrowser/0.2'), true);
  assert.equal(rules.isAllowed('/interdit/page', 'WebBrowser/0.2'), false);
  assert.equal(rules.isAllowed('/robots.txt', 'Google'), true);
  assert.deepEqual(rules.sitemaps, ['https://site.test/sitemap.xml']);
  assert.equal(parseRobots('User-agent: *\nDisallow:').isAllowed('/tout', 'x'), true);
});

test('RobotsCache : 404 = tout permis, 5xx = rien, un seul téléchargement par origine', async () => {
  let calls = 0;
  const statuses = { 'http://a.test': 404, 'http://b.test': 503, 'http://c.test': 200 };
  const cache = new RobotsCache({
    userAgent: 'WebBrowser',
    fetcher: async (url) => {
      calls++;
      const origin = new URL(url).origin;
      return { status: statuses[origin], text: 'User-agent: *\nDisallow: /x' };
    },
  });
  assert.equal(await cache.isAllowed('http://a.test/x'), true);
  assert.equal(await cache.isAllowed('http://b.test/y'), false);
  assert.equal(await cache.isAllowed('http://c.test/x/1'), false);
  assert.equal(await cache.isAllowed('http://c.test/ok'), true);
  await Promise.all([cache.isAllowed('http://c.test/1'), cache.isAllowed('http://c.test/2')]);
  assert.equal(calls, 3);
});
