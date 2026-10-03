// Description des réglages modifiables par l'utilisateur, partagée par l'interface terminal
// et l'application graphique (types, bornes, sections, prise en compte immédiate ou au redémarrage).

export const SEARCH_ENGINES = {
  webbrowser: { label: 'WebBrowser (index local)', url: 'webbrowser://search/?q=%s' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', onion: 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/?q=%s' },
  startpage: { label: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  brave: { label: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  qwant: { label: 'Qwant', url: 'https://www.qwant.com/?q=%s' },
};

export const SETTINGS = [
  { section: 'Application', ui: 'desktop' },
  { key: 'desktop.searchEngine', label: 'Moteur de la barre d’adresse', type: 'enum', ui: 'desktop',
    options: Object.keys(SEARCH_ENGINES), optionLabels: Object.fromEntries(Object.entries(SEARCH_ENGINES).map(([k, v]) => [k, v.label])) },
  { key: 'desktop.restoreTabs', label: 'Rouvrir les onglets au démarrage', type: 'bool', ui: 'desktop' },
  { key: 'desktop.theme', label: 'Thème', type: 'enum', ui: 'desktop', options: ['system', 'light', 'dark'],
    optionLabels: { system: 'Celui du système', light: 'Clair', dark: 'Sombre' } },
  { section: 'Exploration du web' },
  { key: 'crawler.maxPages', label: 'Pages max par exploration', type: 'int', min: 1, max: 100000 },
  { key: 'crawler.maxDepth', label: 'Profondeur max', type: 'int', min: 0, max: 50 },
  { key: 'crawler.concurrency', label: 'Requêtes simultanées', type: 'int', min: 1, max: 32 },
  { key: 'crawler.delayMs', label: 'Délai entre requêtes (ms)', type: 'int', min: 0, max: 60000 },
  { key: 'crawler.sameDomain', label: 'Rester sur le même site', type: 'bool' },
  { key: 'crawler.respectRobots', label: 'Respecter robots.txt', type: 'bool' },
  { key: 'crawler.allowPrivateHosts', label: 'Autoriser les adresses locales', type: 'bool' },
  { section: 'Exploration onion (Tor)' },
  { key: 'onion.maxPages', label: 'Pages max par exploration', type: 'int', min: 1, max: 100000 },
  { key: 'onion.maxDepth', label: 'Profondeur max', type: 'int', min: 0, max: 50 },
  { key: 'onion.delayMs', label: 'Délai entre requêtes (ms)', type: 'int', min: 0, max: 60000 },
  { key: 'onion.sameDomain', label: 'Rester sur le même service', type: 'bool' },
  { key: 'tor.host', label: 'Hôte du proxy Tor', type: 'string', restart: true },
  { key: 'tor.port', label: 'Port SOCKS de Tor', type: 'int', min: 1, max: 65535, restart: true,
    help: '9050 pour le service tor, 9150 si Tor Browser est ouvert' },
  { section: 'Navigation' },
  { key: 'browser.indexVisited', label: 'Indexer les pages visitées', type: 'bool',
    help: 'Les pages ouvertes dans les onglets Tor ne sont jamais indexées ni enregistrées' },
  { key: 'browser.recordHistory', label: 'Enregistrer l’historique', type: 'bool' },
  { key: 'browser.engine', label: 'Moteur de rendu (terminal)', type: 'enum', options: ['http', 'playwright'], restart: true, ui: 'tui' },
  { key: 'network.timeoutMs', label: 'Délai réseau (ms)', type: 'int', min: 1000, max: 300000, restart: true },
  { key: 'network.proxy', label: 'Proxy web (socks5://… ou http://…)', type: 'string', nullable: true, restart: true },
  { section: 'API' },
  { key: 'api.port', label: 'Port de l’API (webbrowser serve)', type: 'int', min: 1, max: 65535 },
];

export function findSetting(key) {
  return SETTINGS.find((s) => s.key === key) ?? null;
}

/** Réglages destinés à une interface ('tui' ou 'desktop'). */
export function settingsFor(ui) {
  return SETTINGS.filter((s) => !s.ui || s.ui === ui);
}

/** Valide et convertit une valeur ; lève une erreur lisible si elle est refusée. */
export function coerceSetting(field, value) {
  switch (field.type) {
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw new Error(`${field.label} : oui ou non attendu`);
    case 'int': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isInteger(n) || n < field.min || n > field.max) {
        throw new Error(`${field.label} : entier entre ${field.min} et ${field.max} attendu`);
      }
      return n;
    }
    case 'enum':
      if (!field.options.includes(value)) throw new Error(`${field.label} : valeur inconnue`);
      return value;
    default: {
      const s = value === null || value === undefined ? '' : String(value).trim();
      if (!s && field.nullable) return null;
      if (!s) throw new Error(`${field.label} : valeur vide`);
      return s;
    }
  }
}
