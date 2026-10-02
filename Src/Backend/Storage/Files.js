// Utilitaires fichiers : JSON atomique, noms de fichiers sûrs, téléchargements.
import fs from 'node:fs';
import path from 'node:path';

const EXT_BY_MIME = {
  'text/html': 'html', 'application/xhtml+xml': 'html', 'text/plain': 'txt', 'text/css': 'css',
  'application/json': 'json', 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/zip': 'zip',
  'application/xml': 'xml', 'text/xml': 'xml', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function safeFilename(name, fallback = 'fichier') {
  const cleaned = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

/** Évite d'écraser un fichier existant : « nom (2).ext », « nom (3).ext »… */
export function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

export function filenameFromResponse(url, mime, contentDisposition) {
  const cd = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition ?? '');
  let name = cd ? decodeURIComponent(cd[1]) : '';
  let fromHost = false;
  if (!name) {
    try {
      const { pathname, hostname } = new URL(url);
      name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
      if (!name) {
        name = hostname;
        fromHost = true;
      }
    } catch {
      name = '';
    }
  }
  name = safeFilename(name, 'telechargement');
  if ((fromHost || !path.extname(name)) && EXT_BY_MIME[mime]) name += `.${EXT_BY_MIME[mime]}`;
  return name;
}

export function saveDownload(dir, { url, body, mime, contentDisposition }) {
  ensureDir(dir);
  const file = uniquePath(dir, filenameFromResponse(url, mime, contentDisposition));
  fs.writeFileSync(file, body);
  return file;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
