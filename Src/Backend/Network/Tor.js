// Accès au réseau Tor via son proxy SOCKS5 local (tor ou Tor Browser) et son port de contrôle.
import net from 'node:net';
import { createProxyAgents } from './Proxy.js';

export class Tor {
  constructor({ host = '127.0.0.1', port = 9050, controlPort = 9051, controlPassword = null, timeoutMs = 60000 } = {}) {
    this.host = host;
    this.port = port;
    this.controlPort = controlPort;
    this.controlPassword = controlPassword;
    this.timeoutMs = timeoutMs;
    this._agents = null;
  }

  get proxyUrl() {
    return `socks5h://${this.host}:${this.port}`;
  }

  get address() {
    return `${this.host}:${this.port}`;
  }

  agents() {
    this._agents ??= createProxyAgents(this.proxyUrl, { timeoutMs: this.timeoutMs });
    return this._agents;
  }

  /** Vérifie qu'un serveur SOCKS5 répond sur le port de Tor (sans rien contacter au-delà). */
  isAvailable(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const done = (ok) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
      socket.once('data', (buf) => done(buf[0] === 0x05 && buf[1] === 0x00));
      socket.once('error', () => done(false));
      socket.once('end', () => done(false));
    });
  }

  /** Vérifie, via le service officiel, que le trafic sort bien par Tor. */
  async checkConnection(httpClient) {
    const res = await httpClient.get('https://check.torproject.org/api/ip', { accept: 'application/json', noCache: true });
    return JSON.parse(res.text());
  }

  /** Demande un nouveau circuit (SIGNAL NEWNYM) via le port de contrôle. */
  newIdentity() {
    return this.control(['SIGNAL NEWNYM']);
  }

  control(commands) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.controlPort });
      const auth = this.controlPassword == null ? 'AUTHENTICATE' : `AUTHENTICATE "${this.controlPassword.replace(/["\\]/g, '\\$&')}"`;
      const queue = [auth, ...commands, 'QUIT'];
      const replies = [];
      let buffer = '';
      const timer = setTimeout(() => fail(new Error('délai dépassé sur le port de contrôle Tor')), 10000);
      const fail = (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      socket.on('error', (err) => fail(new Error(`port de contrôle Tor injoignable (${err.code || err.message})`)));
      socket.on('connect', () => socket.write(queue.shift() + '\r\n'));
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (/^\d{3} /.test(line)) {
            replies.push(line);
            if (!line.startsWith('250')) return fail(new Error(`Tor a répondu : ${line}`));
            if (queue.length) socket.write(queue.shift() + '\r\n');
            else {
              clearTimeout(timer);
              socket.end();
              return resolve(replies);
            }
          }
        }
      });
    });
  }
}
