// Interprétation de robots.txt (RFC 9309) : groupes par user-agent, Allow/Disallow avec * et $,
// règle la plus longue prioritaire, Crawl-delay et Sitemap.

function compilePattern(pattern) {
  let src = '';
  for (const ch of pattern) {
    if (ch === '*') src += '.*';
    else if (ch === '$') src += '$';
    else src += ch.replace(/[.+?^{}()|[\]\\/]/g, '\\$&');
  }
  // Un '$' n'a de sens qu'en fin de motif
  src = src.replace(/\$(?!$)/g, '\\$');
  return new RegExp(`^${src}`);
}

function normalizePath(p) {
  // Décode les octets non réservés pour comparer motifs et chemins de façon homogène
  try {
    return p.replace(/%[0-9a-f]{2}/gi, (m) => {
      const c = String.fromCharCode(parseInt(m.slice(1), 16));
      return /[A-Za-z0-9\-._~]/.test(c) ? c : m.toUpperCase();
    });
  } catch {
    return p;
  }
}

export class RobotsRules {
  constructor(groups = [], sitemaps = []) {
    this.groups = groups;
    this.sitemaps = sitemaps;
  }

  static allowAll() {
    return new RobotsRules();
  }

  static disallowAll() {
    return new RobotsRules([{ agents: ['*'], rules: [{ allow: false, path: '/', re: /^\// }], crawlDelay: null }]);
  }

  /** Groupe applicable : le token d'agent le plus spécifique qui correspond, sinon '*'. */
  groupFor(userAgent) {
    const token = String(userAgent ?? '').split(/[\/\s]/)[0].toLowerCase();
    let best = null;
    let bestLen = -1;
    const merged = [];
    for (const g of this.groups) {
      for (const a of g.agents) {
        if (a !== '*' && token && token.includes(a)) {
          if (a.length > bestLen) {
            best = a;
            bestLen = a.length;
            merged.length = 0;
          }
          if (a === best) merged.push(g);
        }
      }
    }
    if (!merged.length) merged.push(...this.groups.filter((g) => g.agents.includes('*')));
    if (!merged.length) return null;
    return {
      rules: merged.flatMap((g) => g.rules),
      crawlDelay: merged.map((g) => g.crawlDelay).find((d) => d != null) ?? null,
    };
  }

  isAllowed(urlOrPath, userAgent = '*') {
    let target = urlOrPath;
    if (/^https?:\/\//i.test(target)) {
      const u = new URL(target);
      target = u.pathname + u.search;
    }
    target = normalizePath(target || '/');
    if (target === '/robots.txt') return true;
    const group = this.groupFor(userAgent);
    if (!group) return true;
    let match = null;
    for (const rule of group.rules) {
      if (!rule.re.test(target)) continue;
      const len = rule.path.length;
      if (!match || len > match.len || (len === match.len && rule.allow && !match.allow)) match = { len, allow: rule.allow };
    }
    return match ? match.allow : true;
  }

  crawlDelay(userAgent = '*') {
    return this.groupFor(userAgent)?.crawlDelay ?? null;
  }
}

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? '').split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (!value) continue; // "Disallow:" vide = tout permis
      const p = normalizePath(value.startsWith('/') || value.startsWith('*') ? value : `/${value}`);
      current.rules.push({ allow: key === 'allow', path: p, re: compilePattern(p) });
    } else if (key === 'crawl-delay') {
      const d = Number.parseFloat(value);
      if (Number.isFinite(d) && d >= 0) current.crawlDelay = d;
    }
  }
  return new RobotsRules(groups, sitemaps);
}

/** Cache des robots.txt par origine, téléchargés via une fonction fetcher(url) → { status, text }. */
export class RobotsCache {
  constructor({ fetcher, userAgent = '*', ttlMs = 24 * 3600_000, maxEntries = 50000 } = {}) {
    this.maxEntries = maxEntries;
    this.fetcher = fetcher;
    this.userAgent = userAgent;
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  async rulesFor(url) {
    const { origin } = new URL(url);
    const cached = this.entries.get(origin);
    if (cached && cached.expires > Date.now()) return cached.pending ?? cached.rules;
    const pending = this.load(origin).then((rules) => {
      this.entries.set(origin, { rules, expires: Date.now() + this.ttlMs });
      return rules;
    });
    // Limite mémoire : on oublie les origines les plus anciennes
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(origin, { pending, expires: Infinity });
    return pending;
  }

  async load(origin) {
    try {
      const { status, text } = await this.fetcher(`${origin}/robots.txt`);
      if (status >= 200 && status < 300) return parseRobots(text);
      if (status >= 400 && status < 500) return RobotsRules.allowAll();
      return RobotsRules.disallowAll(); // 5xx : on s'abstient
    } catch {
      return RobotsRules.allowAll(); // hôte injoignable : la page elle-même échouera
    }
  }

  async isAllowed(url) {
    return (await this.rulesFor(url)).isAllowed(url, this.userAgent);
  }

  async crawlDelay(url) {
    return (await this.rulesFor(url)).crawlDelay(this.userAgent);
  }
}
