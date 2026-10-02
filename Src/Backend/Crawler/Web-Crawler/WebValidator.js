// Règles d'acceptation des URL du web classique (anti-SSRF : pas d'hôtes privés par défaut).
import dns from 'node:dns/promises';
import net from 'node:net';
import { hostOf, isOnionHost, isPrivateHost, isPrivateIp, hasBinaryExtension, normalizeUrl } from '../../Utils/Validator.js';

export class WebValidator {
  constructor({ allowPrivateHosts = false, blockedHosts = [], resolver = dns.lookup } = {}) {
    this.allowPrivateHosts = allowPrivateHosts;
    this.blockedHosts = new Set(blockedHosts.map((h) => h.toLowerCase()));
    this.resolver = resolver;
    this.dnsCache = new Map();
  }

  isBlocked(host) {
    for (let h = host; h; h = h.includes('.') ? h.slice(h.indexOf('.') + 1) : '') {
      if (this.blockedHosts.has(h)) return true;
    }
    return false;
  }

  /** Vérification synchrone (sans DNS) : schéma, .onion, extension, hôte bloqué ou privé. */
  accepts(url) {
    if (!normalizeUrl(url)) return { ok: false, reason: 'URL non http(s)' };
    const host = hostOf(url);
    if (isOnionHost(host)) return { ok: false, reason: 'adresse .onion : utilisez le crawler Onion (Tor)' };
    if (hasBinaryExtension(url)) return { ok: false, reason: 'fichier non HTML' };
    if (this.isBlocked(host)) return { ok: false, reason: 'hôte bloqué' };
    if (!this.allowPrivateHosts && isPrivateHost(host)) return { ok: false, reason: 'hôte privé/local refusé' };
    return { ok: true };
  }

  /** Vérification complète : ajoute la résolution DNS pour refuser les noms pointant vers un réseau privé. */
  async check(url) {
    const verdict = this.accepts(url);
    if (!verdict.ok || this.allowPrivateHosts) return verdict;
    const host = hostOf(url).replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return verdict;
    let addresses = this.dnsCache.get(host);
    if (!addresses) {
      try {
        addresses = (await this.resolver(host, { all: true })).map((a) => a.address);
      } catch {
        addresses = [];
      }
      this.dnsCache.set(host, addresses);
    }
    if (addresses.some(isPrivateIp)) return { ok: false, reason: 'le nom résout vers une adresse privée' };
    return verdict;
  }
}
