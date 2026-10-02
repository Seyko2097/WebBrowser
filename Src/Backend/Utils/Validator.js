import net from 'node:net';

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|yclid)$/i;

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tif', 'tiff', 'avif',
  'mp3', 'mp4', 'm4a', 'm4v', 'avi', 'mov', 'mkv', 'webm', 'ogg', 'wav', 'flac',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'iso', 'dmg', 'exe', 'msi', 'deb', 'rpm', 'apk', 'bin',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'epub',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'css', 'js', 'mjs', 'json', 'xml', 'rss', 'atom', 'wasm',
]);

/** Normalise une URL http(s) : résout par rapport à `base`, retire le fragment et les paramètres de suivi. */
export function normalizeUrl(input, base) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    url = base ? new URL(input.trim(), base) : new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  url.hash = '';
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  let out = url.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

export function isHttpUrl(value) {
  return normalizeUrl(value) !== null;
}

/** Une saisie utilisateur ressemble-t-elle à une URL (avec ou sans schéma) ? */
export function looksLikeUrl(text) {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  return /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(s) && /\.[a-z]{2,}(:\d+)?(\/|$)|^localhost/i.test(s);
}

/** Ajoute https:// (ou http:// pour .onion et localhost) si le schéma manque. */
export function withScheme(text) {
  const s = String(text ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s; // schéma déjà présent (non http : rejeté plus loin)
  const host = s.startsWith('[') ? s.slice(1, s.indexOf(']')) : s.split(/[/:?#]/)[0].toLowerCase();
  const plain = host.endsWith('.onion') || host === 'localhost' || net.isIP(host) !== 0;
  return (plain ? 'http://' : 'https://') + s;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isOnionHost(host) {
  return /\.onion$/i.test(String(host ?? '').replace(/\.$/, ''));
}

export function isOnionUrl(url) {
  return isOnionHost(hostOf(url));
}

export function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
  }
  return false;
}

/** Hôte manifestement local/privé (sans résolution DNS). */
export function isPrivateHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return isPrivateIp(h);
}

export function hasBinaryExtension(url) {
  try {
    const { pathname } = new URL(url);
    const m = /\.([a-z0-9]{1,6})$/i.exec(pathname);
    return Boolean(m && BINARY_EXT.has(m[1].toLowerCase()));
  } catch {
    return false;
  }
}

export function toInt(value, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
