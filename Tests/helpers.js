// Outils de test : serveur HTTP de fixtures et faux proxy SOCKS5 (simule Tor).
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'Fixtures');

const TYPES = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png' };

/**
 * Serveur HTTP local. `routes` : { '/chemin': (req, res) => void } prioritaire sur les fichiers de `dir`.
 * Renvoie { url, port, requests, close }.
 */
export async function startServer({ dir = path.join(FIXTURES, 'site'), routes = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: pathname, headers: req.headers });
    if (routes[pathname]) return routes[pathname](req, res);
    const file = path.join(dir, decodeURIComponent(pathname).replace(/\/$/, '/index.html'));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<h1>404</h1>');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(r);
    }),
  };
}

/**
 * Faux serveur SOCKS5 : redirige chaque hôte demandé vers `resolve(host, port)` → { host, port } ou null (refus).
 * Enregistre les hôtes demandés (pour vérifier que la résolution DNS est bien distante).
 */
export async function startSocksServer({ resolve, auth = null, failCode = 0x04 } = {}) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    client.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (auth) {
          if (!methods.includes(0x02)) return client.end(Buffer.from([0x05, 0xff]));
          client.write(Buffer.from([0x05, 0x02]));
          stage = 'auth';
        } else {
          client.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        }
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString();
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        const ok = user === auth.username && pass === auth.password;
        client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) return client.end();
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host;
        let end;
        if (atyp === 0x03) {
          end = 5 + buf[4];
          if (buf.length < end + 2) return;
          host = buf.subarray(5, end).toString();
        } else if (atyp === 0x01) {
          end = 8;
          if (buf.length < end + 2) return;
          host = [...buf.subarray(4, 8)].join('.');
        } else return client.end();
        const port = buf.readUInt16BE(end);
        buf = buf.subarray(end + 2);
        seen.push({ host, port, atyp });
        stage = 'proxy';
        client.off('data', onData);
        const target = resolve(host, port);
        if (!target) {
          client.end(Buffer.from([0x05, failCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return undefined;
        }
        const upstream = net.connect(target.port, target.host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          if (buf.length) upstream.write(buf);
          client.pipe(upstream).pipe(client);
        });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.on('error', () => client.destroy());
      }
      return undefined;
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port,
    host: '127.0.0.1',
    seen,
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(r);
    }),
  };
}

export function gzip(text) {
  return zlib.gzipSync(Buffer.from(text));
}

export function tmpDir(prefix = 'webbrowser-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Port TCP local libre (fermé aussitôt) pour simuler un service absent. */
export async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** Génère une adresse onion v3 valide (somme de contrôle correcte) à partir d'une graine. */
export async function makeOnion(seed) {
  const crypto = await import('node:crypto');
  const pubkey = crypto.createHash('sha256').update(String(seed)).digest();
  const version = Buffer.from([0x03]);
  const checksum = crypto.createHash('sha3-256')
    .update(Buffer.concat([Buffer.from('.onion checksum'), pubkey, version])).digest().subarray(0, 2);
  const bytes = Buffer.concat([pubkey, checksum, version]);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${out}.onion`;
}
