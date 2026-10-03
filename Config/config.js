// Configuration par défaut. Les chemins sont relatifs à la racine du projet.
// Les valeurs modifiées depuis l'écran Paramètres sont enregistrées dans Data/settings.json
// et des variables d'environnement peuvent surcharger certaines clés (voir Src/Backend/Utils/Config.js).

export default {
  paths: {
    data: 'Data',
    cache: 'Data/Cache',
    downloads: 'Data/Downloads',
    index: 'Data/Index',
    logs: 'Logs',
    settings: 'Data/settings.json',
  },

  database: {
    file: 'Data/Index/index.db',
  },

  network: {
    userAgent: 'WebBrowser/0.2 (+https://github.com/seyko2097/webbrowser)',
    acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8',
    timeoutMs: 15000,
    maxBytes: 5 * 1024 * 1024,
    maxRedirects: 5,
    // Proxy optionnel pour le web classique : "socks5://hôte:port" ou "http://hôte:port"
    proxy: null,
  },

  tor: {
    host: '127.0.0.1',
    port: 9050,
    controlPort: 9051,
    controlPassword: null,
    timeoutMs: 60000,
  },

  crawler: {
    maxPages: 100,
    maxDepth: 3,
    concurrency: 4,
    delayMs: 500,
    sameDomain: true,
    respectRobots: true,
    allowPrivateHosts: false,
    recrawlAfterMs: 24 * 3600 * 1000,
    maxBodyChars: 200000,
  },

  onion: {
    maxPages: 50,
    maxDepth: 2,
    concurrency: 2,
    delayMs: 2000,
    sameDomain: false,
    // Liste d'adresses .onion (ou de leurs empreintes MD5, format Ahmia) à ne jamais explorer ni indexer.
    blocklistFile: 'Config/onion-blocklist.txt',
  },

  browser: {
    engine: 'http', // "http" (léger) ou "playwright" (rendu JavaScript, nécessite `npm i playwright`)
    poolSize: 2,
    indexVisited: true,
    recordHistory: true,
  },

  desktop: {
    searchEngine: 'webbrowser',
    restoreTabs: true,
    theme: 'system',
  },

  // Mode serveur (VPS) : exploration continue + recherche publique — « webbrowser server »
  server: {
    host: '0.0.0.0',
    port: 8080,
    adminToken: null, // clé d'administration (WEBBROWSER_ADMIN_TOKEN)
    adminRemote: false, // false : administration réservée aux connexions locales (SSH)
    trustProxy: false, // true derrière un proxy inverse (Caddy, nginx) pour lire X-Forwarded-For
    botName: 'WebBrowserBot',
    contact: '', // URL ou e-mail ajouté au User-Agent du robot (recommandé pour un crawler public)
    concurrency: 16,
    hostDelayMs: 1000,
    recrawlAfterDays: 7,
    maxLinksPerPage: 300,
    maxPages: 5_000_000,
    maxFrontier: 50_000_000,
    maxDbSizeMB: 100_000,
    dbCacheMB: 512,
    searchPerMinute: 120,
  },

  api: {
    host: '127.0.0.1',
    port: 8080,
  },

  cache: {
    enabled: true,
    ttlMs: 3600 * 1000,
    memoryItems: 200,
  },

  log: {
    level: 'info',
    console: false,
    file: 'Logs/webbrowser.log',
  },
};
