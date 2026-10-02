// Validation des adresses .onion v3 (somme de contrôle comprise) et liste noire.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { hostOf, normalizeUrl, hasBinaryExtension } from '../../Utils/Validator.js';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Partie « adresse » d'un hôte .onion (sans sous-domaine), ou null. */
export function onionAddress(host) {
  const m = /(?:^|\.)([a-z2-7]{56})\.onion\.?$/i.exec(String(host ?? ''));
  return m ? `${m[1].toLowerCase()}.onion` : null;
}

/** Vérifie une adresse onion v3 : 56 caractères base32 = clé publique (32) + somme (2) + version (1). */
export function isValidOnionV3(host) {
  const address = onionAddress(host);
  if (!address) return false;
  const decoded = base32Decode(address.slice(0, 56));
  if (!decoded || decoded.length !== 35) return false;
  const pubkey = decoded.subarray(0, 32);
  const checksum = decoded.subarray(32, 34);
  const version = decoded[34];
  if (version !== 0x03) return false;
  const expected = crypto.createHash('sha3-256')
    .update(Buffer.concat([Buffer.from('.onion checksum'), pubkey, Buffer.from([version])]))
    .digest()
    .subarray(0, 2);
  return expected.equals(checksum);
}

export function loadBlocklist(file) {
  const entries = new Set();
  if (!file) return entries;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return entries;
  }
  for (const line of text.split(/\r?\n/)) {
    const v = line.replace(/#.*$/, '').trim().toLowerCase();
    if (v) entries.add(v);
  }
  return entries;
}

export class OnionValidator {
  constructor({ blocklist = new Set(), blocklistFile = null, allowClearnet = false } = {}) {
    this.blocklist = new Set([...blocklist, ...loadBlocklist(blocklistFile)].map((s) => s.toLowerCase()));
    this.allowClearnet = allowClearnet;
  }

  isBlocked(address) {
    if (!this.blocklist.size) return false;
    const md5 = crypto.createHash('md5').update(address).digest('hex');
    return this.blocklist.has(address) || this.blocklist.has(md5) || this.blocklist.has(address.replace(/\.onion$/, ''));
  }

  accepts(url) {
    if (!normalizeUrl(url)) return { ok: false, reason: 'URL non http(s)' };
    const host = hostOf(url);
    const address = onionAddress(host);
    if (!address) {
      return this.allowClearnet ? { ok: true } : { ok: false, reason: 'hors réseau onion' };
    }
    if (!isValidOnionV3(host)) return { ok: false, reason: 'adresse onion invalide (v2 obsolète ou somme de contrôle fausse)' };
    if (this.isBlocked(address)) return { ok: false, reason: 'service onion sur liste noire' };
    if (hasBinaryExtension(url)) return { ok: false, reason: 'fichier non HTML' };
    return { ok: true };
  }

  async check(url) {
    return this.accepts(url);
  }
}
