// Client HTTP/HTTPS : redirections, décompression, détection d'encodage, limite de taille,
// délai global, proxy (SOCKS5/HTTP/Tor), cookies (via un Context) et cache optionnel.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { createProxyAgents } from './Proxy.js';
import { buildHeaders, parseContentType, sniffCharset, headerList, ACCEPT_HTML } from './Headers.js';

export class HttpError extends Error {
  constructor(message, { url, code } = {}) {
    super(message);
    this.name = 'HttpError';
    this.url = url;
    this.code = code;
  }
}

export class Response {
  constructor({ url, status, statusText, headers, body, redirects = [], truncated = false, fromCache = false }) {
    this.url = url;
    this.status = status;
    this.statusText = statusText;
    this.headers = headers;
    this.body = body;
    this.redirects = redirects;
    this.truncated = truncated;
    this.fromCache = fromCache;
    const { mime, charset } = parseContentType(headers['content-type']);
    this.mime = mime;
    this.charset = charset;
  }

  get ok() {
    return this.status >= 200 && this.status < 300;
  }

  text() {
    if (this._text !== undefined) return this._text;
    const charset = this.charset || (this.mime.includes('html') || !this.mime ? sniffCharset(this.body) : null) || 'utf-8';
    let decoder;
    try {
      decoder = new TextDecoder(charset === 'iso-8859-1' ? 'windows-1252' : charset);
    } catch {
      decoder = new TextDecoder('utf-8');
    }
    this._text = decoder.decode(this.body);
    return this._text;
  }

  toJSON() {
    return {
      url: this.url, status: this.status, statusText: this.statusText, headers: this.headers,
      body: this.body.toString('base64'), redirects: this.redirects, truncated: this.truncated,
    };
  }

  static fromJSON(data) {
    return new Response({ ...data, body: Buffer.from(data.body, 'base64'), fromCache: true });
  }
}

function decompress(buffer, encoding, partial) {
  const opts = partial ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : {};
  const enc = String(encoding ?? '').trim().toLowerCase();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer, opts);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buffer, opts);
      } catch {
        return zlib.inflateRawSync(buffer, opts);
      }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buffer, partial ? { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH } : {});
  } catch {
    return buffer; // contenu mal compressé : on renvoie les octets bruts
  }
  return buffer;
}

export class HttpClient {
  constructor({
    userAgent = 'WebBrowser/0.2', acceptLanguage, timeoutMs = 15000, maxBytes = 5 * 1024 * 1024,
    maxRedirects = 5, proxy = null, torSafe = false, cache = null, logger = null, headers = {},
  } = {}) {
    this.userAgent = userAgent;
    this.acceptLanguage = acceptLanguage;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.maxRedirects = maxRedirects;
    this.torSafe = torSafe;
    this.cache = cache;
    this.logger = logger;
    this.extraHeaders = headers;
    this.agents = proxy ? createProxyAgents(proxy, { timeoutMs }) : null;
  }

  get usesProxy() {
    return Boolean(this.agents);
  }

  /**
   * Télécharge une URL. Options : headers, accept, context (cookies), noCache, maxBytes, method.
   * Les statuts HTTP d'erreur ne lèvent pas d'exception : c'est à l'appelant de tester response.ok.
   */
  async get(url, options = {}) {
    const method = options.method ?? 'GET';
    const cacheKey = `${method} ${url}`;
    if (this.cache && method === 'GET' && !options.noCache && !options.context) {
      const hit = this.cache.get(cacheKey);
      if (hit) return Response.fromJSON(hit);
    }
    const redirects = [];
    let current = url;
    let currentMethod = method;
    for (let hop = 0; ; hop++) {
      const res = await this.requestOnce(current, { ...options, method: currentMethod });
      if (res.status >= 300 && res.status < 400 && res.headers.location && hop < this.maxRedirects) {
        let next;
        try {
          next = new URL(res.headers.location, current).toString();
        } catch {
          return res;
        }
        if (!/^https?:/.test(next)) return res;
        redirects.push(current);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) currentMethod = 'GET';
        current = next;
        continue;
      }
      res.redirects = redirects;
      if (this.cache && method === 'GET' && res.status === 200 && !options.noCache && !options.context && !res.truncated) {
        this.cache.set(cacheKey, res.toJSON());
      }
      return res;
    }
  }

  async head(url, options = {}) {
    return this.get(url, { ...options, method: 'HEAD' });
  }

  requestOnce(url, { headers = {}, accept = ACCEPT_HTML, context = null, method = 'GET', maxBytes = this.maxBytes, signal } = {}) {
    let target;
    try {
      target = new URL(url);
    } catch {
      return Promise.reject(new HttpError(`URL invalide : ${url}`, { url, code: 'EINVAL' }));
    }
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const reqHeaders = buildHeaders({
      userAgent: this.userAgent, acceptLanguage: this.acceptLanguage, accept, torSafe: this.torSafe,
      extra: { ...this.extraHeaders, ...headers },
    });
    const cookie = context?.cookieHeader(url);
    if (cookie) reqHeaders.cookie = cookie;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const req = lib.request(target, {
        method,
        headers: reqHeaders,
        agent: this.agents ? (isHttps ? this.agents.https : this.agents.http) : undefined,
        signal,
      });
      const timer = setTimeout(() => {
        req.destroy();
        finish(reject, new HttpError(`délai dépassé (${Math.round(this.timeoutMs / 1000)} s) : ${url}`, { url, code: 'ETIMEDOUT' }));
      }, this.timeoutMs);

      req.on('error', (err) => finish(reject, err instanceof HttpError || err.name === 'ProxyError'
        ? err : new HttpError(`${err.code || err.message} : ${url}`, { url, code: err.code })));
      req.on('response', (res) => {
        const setCookie = headerList(res.headers['set-cookie']);
        if (context && setCookie.length) context.storeCookies(url, setCookie);
        const chunks = [];
        let size = 0;
        let truncated = false;
        const done = () => {
          const raw = Buffer.concat(chunks);
          const body = decompress(raw, res.headers['content-encoding'], truncated);
          finish(resolve, new Response({
            url, status: res.statusCode, statusText: res.statusMessage, headers: res.headers,
            body: body.length > maxBytes ? body.subarray(0, maxBytes) : body, truncated,
          }));
        };
        if (method === 'HEAD' || (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)) {
          res.resume();
          return done();
        }
        res.on('data', (chunk) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            truncated = true;
            done();
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', done);
        res.on('error', (err) => finish(reject, new HttpError(`${err.message} : ${url}`, { url })));
        res.on('close', () => { if (!settled) done(); });
      });
      req.end();
    });
  }
}
