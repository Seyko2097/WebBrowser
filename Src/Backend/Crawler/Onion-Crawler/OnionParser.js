// Analyse spécifique aux pages onion : en plus des liens <a>, les annuaires .onion citent souvent
// des adresses en texte brut ; on les récupère pour la découverte de services.
import { parsePage } from '../Parsers/HtmlParser.js';
import { isValidOnionV3 } from './OnionValidator.js';

const ONION_RE = /\b([a-z2-7]{56})\.onion\b/gi;

export function extractOnionAddresses(text) {
  const found = new Set();
  for (const m of String(text ?? '').matchAll(ONION_RE)) {
    const address = `${m[1].toLowerCase()}.onion`;
    if (isValidOnionV3(address)) found.add(address);
  }
  return [...found];
}

export function parseOnionPage(html, url) {
  const page = parsePage(html, url);
  const linked = new Set(page.links.map((l) => new URL(l.url).hostname));
  page.extraLinks = extractOnionAddresses(page.doc.text)
    .filter((addr) => !linked.has(addr))
    .map((addr) => `http://${addr}/`);
  page.onionAddresses = extractOnionAddresses(`${page.doc.text} ${page.links.map((l) => l.url).join(' ')}`);
  return page;
}
