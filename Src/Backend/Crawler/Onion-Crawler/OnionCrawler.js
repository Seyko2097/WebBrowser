// Crawler du réseau Tor : tout le trafic (robots.txt compris) passe par le proxy SOCKS5 de Tor,
// avec résolution DNS distante. Aucune URL hors .onion n'est contactée, sauf option explicite.
import { Crawler } from '../Core/Crawler.js';
import { OnionValidator } from './OnionValidator.js';
import { parseOnionPage } from './OnionParser.js';
import { HttpClient } from '../../Network/HttpClient.js';
import { Tor } from '../../Network/Tor.js';

export class OnionCrawler extends Crawler {
  constructor({ tor = new Tor(), client = null, validator = null, blocklistFile = null, blocklist,
    allowClearnet = false, timeoutMs = 60000, maxBytes, skipTorCheck = false, ...options } = {}) {
    super({
      maxPages: 50, maxDepth: 2, concurrency: 2, delayMs: 2000, sameDomain: false,
      ...options,
      network: 'onion',
      parse: parseOnionPage,
      client: client ?? new HttpClient({ proxy: tor.proxyUrl, torSafe: true, timeoutMs, maxBytes }),
      validator: validator ?? new OnionValidator({ blocklistFile, blocklist, allowClearnet }),
    });
    this.tor = tor;
    this.skipTorCheck = skipTorCheck;
    if (!this.client.usesProxy) throw new Error('OnionCrawler : le client HTTP doit passer par Tor');
  }

  async crawl(seeds) {
    if (!this.skipTorCheck && !(await this.tor.isAvailable())) {
      throw new Error(`Tor injoignable sur ${this.tor.address}. Installez et lancez Tor (ex. « sudo apt install tor »), ou réglez tor.host / tor.port.`);
    }
    return super.crawl(seeds);
  }
}
