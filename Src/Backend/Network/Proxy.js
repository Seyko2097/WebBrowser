// Connexions via proxy : SOCKS5 (RFC 1928/1929, avec résolution DNS distante) et tunnel HTTP CONNECT.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const SOCKS_ERRORS = {
  0x01: 'échec général du serveur SOCKS',
  0x02: 'connexion interdite par les règles du proxy',
  0x03: 'réseau injoignable',
  0x04: 'hôte injoignable',
  0x05: 'connexion refusée',
  0x06: 'TTL expiré',
  0x07: 'commande non supportée',
  0x08: "type d'adresse non supporté",
  // Codes étendus de Tor pour les services onion
  0xf0: 'descripteur du service onion introuvable (service hors ligne ?)',
  0xf1: 'descripteur du service onion invalide',
  0xf2: "échec de l'introduction au service onion",
  0xf3: 'échec du point de rendez-vous onion',
  0xf4: 'authentification client onion requise',
  0xf5: 'authentification client onion incorrecte',
  0xf6: 'adresse onion invalide',
  0xf7: "délai d'introduction onion dépassé",
};

export class ProxyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
  }
}

/** "socks5h://user:pass@127.0.0.1:9050" → objet de configuration. */
export function parseProxyUrl(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const url = new URL(value.includes('://') ? value : `socks5h://${value}`);
  const protocol = url.protocol.replace(':', '');
  if (!['socks5', 'socks5h', 'socks', 'http'].includes(protocol)) {
    throw new ProxyError(`protocole de proxy non supporté : ${protocol}`);
  }
  return {
    protocol: protocol === 'http' ? 'http' : 'socks5',
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || (protocol === 'http' ? 8080 : 1080),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

/** Lecteur d'octets sur une socket, pour les poignées de main. */
class ByteReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.error = null;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    };
    this.onEnd = () => this.fail(new ProxyError('le proxy a fermé la connexion'));
    this.onError = (err) => this.fail(err);
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('error', this.onError);
  }

  fail(err) {
    this.error = err;
    this.flush();
  }

  flush() {
    if (!this.waiter) return;
    const { test, resolve, reject } = this.waiter;
    const n = test(this.buffer);
    if (n > 0) {
      this.waiter = null;
      const out = this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      resolve(out);
    } else if (this.error) {
      this.waiter = null;
      reject(this.error);
    }
  }

  /** test(buffer) renvoie le nombre d'octets à consommer, ou 0 s'il en faut davantage. */
  read(test) {
    return new Promise((resolve, reject) => {
      this.waiter = { test, resolve, reject };
      this.flush();
    });
  }

  bytes(n) {
    return this.read((buf) => (buf.length >= n ? n : 0));
  }

  release() {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('error', this.onError);
    // Pas de pause : le serveur n'envoie rien avant la requête du client, et le module http
    // ne relancerait pas une socket mise en pause explicitement.
    if (this.buffer.length) this.socket.unshift(this.buffer);
  }
}

function connectTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ProxyError(`délai dépassé en se connectant au proxy ${host}:${port}`, 'ETIMEDOUT'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new ProxyError(`proxy ${host}:${port} injoignable (${err.code || err.message})`, err.code));
    });
  });
}

function withTimeout(promise, ms, socket, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        socket.destroy();
        reject(new ProxyError(`délai dépassé : ${what}`, 'ETIMEDOUT'));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Ouvre une connexion TCP vers host:port à travers un proxy SOCKS5.
 * Le nom d'hôte est toujours transmis au proxy (DNS distant) : indispensable pour .onion
 * et pour ne pas faire fuiter les requêtes DNS hors de Tor.
 */
export async function socksConnect({ proxyHost, proxyPort, host, port, username, password, timeoutMs = 30000 }) {
  const socket = await connectTcp(proxyHost, proxyPort, Math.min(timeoutMs, 15000));
  const reader = new ByteReader(socket);
  const handshake = async () => {
    const methods = username !== undefined ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const [ver, method] = await reader.bytes(2);
    if (ver !== 0x05) throw new ProxyError("le proxy ne parle pas SOCKS5");
    if (method === 0x02) {
      const u = Buffer.from(username ?? '');
      const p = Buffer.from(password ?? '');
      socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const [, status] = await reader.bytes(2);
      if (status !== 0x00) throw new ProxyError('authentification SOCKS refusée');
    } else if (method !== 0x00) {
      throw new ProxyError('aucune méthode d’authentification SOCKS acceptée');
    }

    let addr;
    const ipKind = net.isIP(host);
    if (ipKind === 4) addr = Buffer.from([0x01, ...host.split('.').map(Number)]);
    else if (ipKind === 6) {
      const full = expandIpv6(host);
      addr = Buffer.concat([Buffer.from([0x04]), Buffer.from(full.flatMap((h) => [h >> 8, h & 0xff]))]);
    } else {
      const name = Buffer.from(host);
      if (name.length > 255) throw new ProxyError('nom d’hôte trop long');
      addr = Buffer.concat([Buffer.from([0x03, name.length]), name]);
    }
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, Buffer.from([port >> 8, port & 0xff])]));

    const reply = await reader.read((buf) => {
      if (buf.length < 5) return 0;
      const atyp = buf[3];
      const len = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 7 + buf[4] : 10;
      return buf.length >= len ? len : 0;
    });
    if (reply[1] !== 0x00) {
      const msg = SOCKS_ERRORS[reply[1]] ?? `erreur SOCKS 0x${reply[1].toString(16)}`;
      throw new ProxyError(`${host}:${port} — ${msg}`, `SOCKS_${reply[1]}`);
    }
  };
  try {
    await withTimeout(handshake(), timeoutMs, socket, `connexion SOCKS vers ${host}`);
  } catch (err) {
    socket.destroy();
    throw err;
  }
  reader.release();
  return socket;
}

function expandIpv6(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const missing = ip.includes('::') ? 8 - h.length - t.length : 0;
  return [...h, ...Array(missing).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
}

/** Ouvre un tunnel TCP via un proxy HTTP (méthode CONNECT). */
export async function httpConnect({ proxyHost, proxyPort, host, port, username, password, timeoutMs = 30000 }) {
  const socket = await connectTcp(proxyHost, proxyPort, Math.min(timeoutMs, 15000));
  const reader = new ByteReader(socket);
  const target = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
  const auth = username !== undefined
    ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}\r\n` : '';
  try {
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    const head = await withTimeout(reader.read((buf) => {
      const i = buf.indexOf('\r\n\r\n');
      return i === -1 ? 0 : i + 4;
    }), timeoutMs, socket, `tunnel CONNECT vers ${target}`);
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'));
    if (!status || status[1] !== '200') {
      throw new ProxyError(`le proxy a refusé le tunnel vers ${target} (${status ? status[1] : 'réponse invalide'})`);
    }
  } catch (err) {
    socket.destroy();
    throw err;
  }
  reader.release();
  return socket;
}

export function proxyConnect(proxy, host, port, timeoutMs) {
  const opts = {
    proxyHost: proxy.host, proxyPort: proxy.port, host, port,
    username: proxy.username, password: proxy.password, timeoutMs,
  };
  return proxy.protocol === 'http' ? httpConnect(opts) : socksConnect(opts);
}

class ProxyHttpAgent extends http.Agent {
  constructor(proxy, timeoutMs) {
    super({ keepAlive: false });
    this.proxy = proxy;
    this.timeoutMs = timeoutMs;
  }

  createConnection(options, callback) {
    proxyConnect(this.proxy, options.host, Number(options.port) || 80, this.timeoutMs)
      .then((socket) => callback(null, socket), callback);
  }
}

class ProxyHttpsAgent extends https.Agent {
  constructor(proxy, timeoutMs) {
    super({ keepAlive: false });
    this.proxy = proxy;
    this.timeoutMs = timeoutMs;
  }

  createConnection(options, callback) {
    const host = options.host;
    proxyConnect(this.proxy, host, Number(options.port) || 443, this.timeoutMs).then((socket) => {
      const secure = tls.connect({
        socket,
        servername: options.servername || (net.isIP(host) ? undefined : host),
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: options.rejectUnauthorized !== false,
      });
      callback(null, secure);
    }, callback);
  }
}

/** Agents http/https qui font passer toutes les connexions par le proxy. */
export function createProxyAgents(proxyConfig, { timeoutMs = 30000 } = {}) {
  const proxy = parseProxyUrl(proxyConfig);
  if (!proxy) return null;
  return { http: new ProxyHttpAgent(proxy, timeoutMs), https: new ProxyHttpsAgent(proxy, timeoutMs), proxy };
}
