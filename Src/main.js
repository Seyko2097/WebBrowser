#!/usr/bin/env node
// Point d'entrée en ligne de commande : « webbrowser » sans argument lance l'interface plein écran.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Config } from './Backend/Utils/Config.js';
import { Logger } from './Backend/Utils/Logger.js';
import { App } from './Backend/App.js';
import { HL_START, HL_END } from './Backend/Crawler/Indexer/SearchIndex.js';
import { looksLikeUrl, normalizeUrl, withScheme, isOnionUrl } from './Backend/Utils/Validator.js';
import { wrap } from './Frontend/Terminal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const HELP = `WebBrowser ${VERSION} — moteur de recherche, crawler et navigateur pour le terminal

Usage :
  webbrowser                        ouvre l'interface plein écran
  webbrowser <recherche…>           ouvre l'interface avec cette recherche
  webbrowser <url>                  ouvre l'interface sur cette page
  webbrowser crawl <url…>           explore et indexe des sites (les .onion passent par Tor)
  webbrowser search <recherche…>    recherche dans l'index (sortie texte)
  webbrowser open <url>             affiche le texte d'une page
  webbrowser serve                  lance l'API REST (JSON)
  webbrowser stats                  statistiques de l'index
  webbrowser tor                    vérifie que Tor est joignable
  webbrowser paths                  emplacement des données et de la configuration

Options de crawl :
  -n, --max-pages N   pages maximum             -d, --max-depth N   profondeur maximum
  -c, --concurrency N requêtes simultanées      --delay MS          délai entre requêtes vers un même site
  --onion             forcer le réseau Tor      --any-domain        suivre les liens vers d'autres sites
  --ignore-robots     ignorer robots.txt        --allow-private     autoriser localhost / réseau local
  --recrawl           retélécharger les pages déjà indexées

Options de search :  -n, --limit N   --network web|onion   --json
Options de serve :   --host HÔTE   --port PORT
Options générales :  --home DOSSIER (données dans ce dossier)   -v, --verbose   -h, --help   --version

Raccourcis de l'interface : F1 Recherche · F2 Navigateur · F3 Historique · F4 Paramètres · Ctrl-C Quitter`;

const OPTIONS = {
  'max-pages': { type: 'string', short: 'n' },
  'max-depth': { type: 'string', short: 'd' },
  concurrency: { type: 'string', short: 'c' },
  delay: { type: 'string' },
  onion: { type: 'boolean' },
  'any-domain': { type: 'boolean' },
  'ignore-robots': { type: 'boolean' },
  'allow-private': { type: 'boolean' },
  recrawl: { type: 'boolean' },
  limit: { type: 'string' },
  network: { type: 'string' },
  json: { type: 'boolean' },
  host: { type: 'string' },
  port: { type: 'string' },
  home: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

const COMMANDS = new Set(['tui', 'crawl', 'search', 'open', 'serve', 'stats', 'tor', 'paths', 'help']);

function int(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} attend un entier positif`);
  return n;
}

function makeApp(values, { console: toConsole = false } = {}) {
  if (values.home) process.env.WEBBROWSER_HOME = path.resolve(values.home);
  const config = new Config();
  const logger = new Logger({
    level: values.verbose ? 'debug' : config.get('log.level'),
    file: config.path('log.file'),
    console: toConsole && values.verbose,
  });
  return new App({ config, logger });
}

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);

async function cmdTui(app, positionals) {
  const { TuiApp } = await import('./Frontend/App.js');
  const text = positionals.join(' ').trim();
  const tui = new TuiApp({ services: app, version: VERSION });
  if (text && looksLikeUrl(text)) await tui.run({ url: text });
  else await tui.run({ query: text });
}

async function cmdCrawl(app, urls, values) {
  if (!urls.length) throw new Error('indiquez au moins une URL à explorer');
  const seeds = urls.map((u) => normalizeUrl(withScheme(u)));
  if (seeds.some((u) => !u)) throw new Error('URL invalide');
  const network = values.onion || seeds.every(isOnionUrl) ? 'onion' : 'web';
  const crawler = app.createCrawler(network, {
    maxPages: int(values['max-pages'], 'max-pages'),
    maxDepth: int(values['max-depth'], 'max-depth'),
    concurrency: int(values.concurrency, 'concurrency'),
    delayMs: int(values.delay, 'delay'),
    sameDomain: values['any-domain'] ? false : undefined,
    respectRobots: values['ignore-robots'] ? false : undefined,
    allowPrivateHosts: values['allow-private'] ? true : undefined,
    recrawlAfterMs: values.recrawl ? 0 : undefined,
  });
  crawler.on('page', ({ url, title, depth }) => console.log(`${green('+')} [${String(crawler.stats.indexed).padStart(4)}] ${dim(`p${depth}`)} ${url}  ${dim(title)}`));
  crawler.on('skip', ({ url, reason }) => values.verbose && console.log(`${dim('·')} ${url}  ${dim(reason)}`));
  crawler.on('fetch-error', ({ url, reason }) => console.error(`! ${url}  ${reason}`));
  const onSigint = () => {
    console.error('\nArrêt demandé, fin des requêtes en cours…');
    crawler.stop();
  };
  process.once('SIGINT', onSigint);
  console.log(`Exploration ${network === 'onion' ? 'onion via Tor' : 'web'} : ${seeds.join(', ')} (max ${crawler.maxPages} pages, profondeur ${crawler.maxDepth})`);
  const r = await crawler.crawl(seeds);
  process.off('SIGINT', onSigint);
  console.log(`\nTerminé en ${(r.durationMs / 1000).toFixed(1)} s : ${bold(r.indexed)} page(s) indexée(s), ${r.reused} déjà connue(s), ${r.skipped} ignorée(s), ${r.errors} erreur(s).`);
  console.log(`Index : ${app.searchIndex.count()} pages au total.`);
}

function cmdSearch(app, words, values) {
  const query = words.join(' ');
  if (!query.trim()) throw new Error('indiquez une recherche');
  const limit = int(values.limit, 'limit') ?? 10;
  const { results, total } = app.searchIndex.search(query, { limit, network: values.network ?? null });
  if (values.json) {
    const strip = (s) => s.replaceAll(HL_START, '').replaceAll(HL_END, '');
    console.log(JSON.stringify({ query, total, results: results.map((r) => ({ ...r, snippet: strip(r.snippet) })) }, null, 2));
    return total ? 0 : 1;
  }
  console.log(dim(`${total} résultat(s) pour « ${query} »`));
  results.forEach((r, i) => {
    const snippet = r.snippet.replace(new RegExp(`${HL_START}([^${HL_END}]*)${HL_END}`, 'g'), (_, w) => bold(w));
    console.log(`\n${i + 1}. ${bold(r.title)}${r.network === 'onion' ? dim(' [onion]') : ''}\n   ${green(r.url)}\n   ${snippet}`);
  });
  return total ? 0 : 1;
}

async function cmdOpen(app, args) {
  if (!args[0]) throw new Error('indiquez une adresse');
  const page = await app.browser.open(args[0]);
  const width = Math.min(process.stdout.columns || 100, 100);
  console.log(`${bold(page.title)}\n${green(page.url)}\n`);
  console.log(wrap(page.text, width).join('\n'));
  if (page.links.length) {
    console.log(`\n${bold('Liens')}`);
    for (const l of page.links) console.log(`[${l.number}] ${l.url}`);
  }
}

async function cmdServe(app, values) {
  const { ApiServer } = await import('./Backend/API/Server.js');
  const server = new ApiServer({
    app,
    host: values.host ?? app.config.get('api.host'),
    port: int(values.port, 'port') ?? app.config.get('api.port'),
    version: VERSION,
  });
  const { host, port } = await server.start();
  console.log(`API WebBrowser sur http://${host}:${port}/api  (Ctrl-C pour arrêter)`);
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.stop();
}

function cmdStats(app, values) {
  const s = app.searchIndex.stats();
  if (values.json) return console.log(JSON.stringify(s, null, 2));
  console.log(`Pages indexées : ${bold(s.total)} (web ${s.web}, onion ${s.onion})`);
  console.log(`Sites          : ${s.hosts}`);
  console.log(`Liens          : ${s.links}`);
  console.log(`Historique     : ${app.history.count()} entrées`);
  console.log(`Dernière page  : ${s.lastFetchedAt ? new Date(s.lastFetchedAt).toLocaleString('fr-FR') : '—'}`);
  console.log(`Base           : ${app.config.path('database.file')}`);
  return 0;
}

async function cmdTor(app) {
  const ok = await app.tor.isAvailable();
  if (!ok) {
    console.error(`Tor injoignable sur ${app.tor.address}.`);
    console.error('Installez-le (ex. « sudo apt install tor ») ou lancez Tor Browser (port 9150 : réglez tor.port).');
    return 1;
  }
  console.log(`Proxy SOCKS de Tor joignable sur ${app.tor.address}.`);
  try {
    const info = await app.tor.checkConnection(app.torClient);
    console.log(info.IsTor ? `Le trafic sort bien par Tor (IP de sortie ${info.IP}).` : 'Attention : le trafic ne semble pas passer par Tor.');
  } catch (err) {
    console.log(`(vérification en ligne impossible : ${err.message})`);
  }
  return 0;
}

function cmdPaths(app) {
  const c = app.config;
  console.log(`Mode           : ${c.mode}`);
  console.log(`Paramètres     : ${c.settingsFile}`);
  console.log(`Index          : ${c.path('database.file')}`);
  console.log(`Cache          : ${c.path('paths.cache')}`);
  console.log(`Téléchargements: ${c.path('paths.downloads')}`);
  console.log(`Journaux       : ${c.path('log.file')}`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(`${err.message}\n\nwebbrowser --help pour l'aide.`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  let [command, ...rest] = positionals;
  if (values.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (!COMMANDS.has(command)) {
    rest = positionals;
    command = 'tui';
  }
  const app = makeApp(values, { console: command !== 'tui' });
  try {
    switch (command) {
      case 'tui': await cmdTui(app, rest); return 0;
      case 'crawl': await cmdCrawl(app, rest, values); return 0;
      case 'search': return cmdSearch(app, rest, values);
      case 'open': await cmdOpen(app, rest); return 0;
      case 'serve': await cmdServe(app, values); return 0;
      case 'stats': return cmdStats(app, values);
      case 'tor': return await cmdTor(app);
      case 'paths': return cmdPaths(app);
      default: return 2;
    }
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    if (values.verbose) console.error(err.stack);
    return 1;
  } finally {
    await app.close();
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code ?? 0));
}
