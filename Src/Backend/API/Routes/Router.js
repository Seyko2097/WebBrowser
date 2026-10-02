// Routeur minimal : méthodes HTTP + chemins avec paramètres (« /api/crawl/:id »).
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '/([^/]+)';
    })}/?$`);
    this.routes.push({ method, pattern, re, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  /** Renvoie { handler, params } ou { allowed: [...] } si le chemin existe pour d'autres méthodes. */
  match(method, pathname) {
    const allowed = [];
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) {
        allowed.push(r.method);
        continue;
      }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { handler: r.handler, params };
    }
    return { allowed };
  }

  list() {
    return this.routes.map(({ method, pattern }) => ({ method, path: pattern }));
  }
}
