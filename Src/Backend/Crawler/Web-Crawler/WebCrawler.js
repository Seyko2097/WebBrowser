// Crawler du web classique (connexion directe ou via le proxy configuré).
import { Crawler } from '../Core/Crawler.js';
import { WebValidator } from './WebValidator.js';
import { HttpClient } from '../../Network/HttpClient.js';

export class WebCrawler extends Crawler {
  constructor({ client = null, validator = null, proxy = null, allowPrivateHosts = false, blockedHosts = [],
    userAgent = 'WebBrowser/0.2', timeoutMs = 15000, maxBytes, ...options } = {}) {
    super({
      ...options,
      userAgent,
      network: 'web',
      client: client ?? new HttpClient({ userAgent, timeoutMs, maxBytes, proxy }),
      validator: validator ?? new WebValidator({ allowPrivateHosts, blockedHosts }),
    });
  }
}
