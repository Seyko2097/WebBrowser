// Paramètres : modification des réglages (enregistrés dans settings.json) et actions de maintenance.
import { S, LineInput, clip } from '../Terminal.js';
import { formatBytes } from '../../Backend/Storage/Files.js';
import fs from 'node:fs';

const FIELDS = [
  { section: 'Exploration du web' },
  { key: 'crawler.maxPages', label: 'Pages max par exploration', type: 'int', min: 1, max: 100000 },
  { key: 'crawler.maxDepth', label: 'Profondeur max', type: 'int', min: 0, max: 50 },
  { key: 'crawler.concurrency', label: 'Requêtes simultanées', type: 'int', min: 1, max: 32 },
  { key: 'crawler.delayMs', label: 'Délai entre requêtes (ms)', type: 'int', min: 0, max: 60000 },
  { key: 'crawler.sameDomain', label: 'Rester sur le même site', type: 'bool' },
  { key: 'crawler.respectRobots', label: 'Respecter robots.txt', type: 'bool' },
  { key: 'crawler.allowPrivateHosts', label: 'Autoriser les adresses locales', type: 'bool' },
  { section: 'Exploration onion (Tor)' },
  { key: 'onion.maxPages', label: 'Pages max par exploration', type: 'int', min: 1, max: 100000 },
  { key: 'onion.maxDepth', label: 'Profondeur max', type: 'int', min: 0, max: 50 },
  { key: 'onion.delayMs', label: 'Délai entre requêtes (ms)', type: 'int', min: 0, max: 60000 },
  { key: 'onion.sameDomain', label: 'Rester sur le même service', type: 'bool' },
  { key: 'tor.host', label: 'Hôte du proxy Tor', type: 'string', restart: true },
  { key: 'tor.port', label: 'Port SOCKS de Tor', type: 'int', min: 1, max: 65535, restart: true },
  { section: 'Navigateur' },
  { key: 'browser.indexVisited', label: 'Indexer les pages visitées', type: 'bool' },
  { key: 'browser.recordHistory', label: 'Enregistrer l’historique', type: 'bool' },
  { key: 'browser.engine', label: 'Moteur de rendu', type: 'enum', options: ['http', 'playwright'], restart: true },
  { key: 'network.timeoutMs', label: 'Délai réseau (ms)', type: 'int', min: 1000, max: 300000, restart: true },
  { key: 'network.proxy', label: 'Proxy web (socks5://… ou http://…)', type: 'string', nullable: true, restart: true },
  { section: 'API' },
  { key: 'api.port', label: 'Port de l’API (webbrowser serve)', type: 'int', min: 1, max: 65535 },
  { section: 'Maintenance' },
  { action: 'tor', label: 'Tester la connexion à Tor' },
  { action: 'cache', label: 'Vider le cache' },
  { action: 'history', label: 'Effacer l’historique', confirm: true },
  { action: 'index-web', label: 'Vider l’index web', confirm: true },
  { action: 'index-onion', label: 'Vider l’index onion', confirm: true },
];

export class SettingsView {
  constructor(app) {
    this.app = app;
    this.title = 'Paramètres';
    this.items = FIELDS;
    this.selected = 1;
    this.top = 0;
    this.editing = null;
    this.confirming = null;
  }

  get config() {
    return this.app.services.config;
  }

  get help() {
    if (this.editing) return 'Entrée: valider  Échap: annuler';
    if (this.confirming) return `${this.confirming.label} ? o: oui  autre touche: non`;
    return '↑↓: choisir  Entrée/Espace: modifier  ←→: ajuster  q: quitter';
  }

  valueText(f) {
    const v = this.config.get(f.key);
    if (f.type === 'bool') return v ? '[x] oui' : '[ ] non';
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  }

  render(width, height) {
    const rows = [[[' Paramètres', S.accent], [`  ${this.config.settingsFile}`, S.dim]], [['─'.repeat(width), S.dim]]];
    let cursor = null;
    const bodyH = height - 2;
    if (this.selected < this.top) this.top = this.selected;
    if (this.selected >= this.top + bodyH) this.top = this.selected - bodyH + 1;
    const labelW = Math.min(40, Math.floor(width * 0.45));
    for (let i = this.top; i < Math.min(this.items.length, this.top + bodyH); i++) {
      const f = this.items[i];
      const sel = i === this.selected;
      if (f.section) {
        rows.push([[` ${f.section}`, S.bold]]);
        continue;
      }
      const label = clip(f.label, labelW - 4).padEnd(labelW - 4);
      const row = [[sel ? ' ▌ ' : '   ', S.accent], [label, sel ? S.sel : S.none], [' ', S.none]];
      if (f.action) {
        row[1] = [clip(`› ${f.label}`, labelW - 4).padEnd(labelW - 4), sel ? S.sel : S.link];
      } else if (this.editing && sel) {
        const { text, cursorCol } = this.editing.input.view(width - labelW - 2);
        row.push([text, S.input]);
        cursor = { row: rows.length, col: labelW + cursorCol };
      } else {
        const v = this.valueText(f);
        row.push([v, f.type === 'bool' ? (this.config.get(f.key) ? S.ok : S.dim) : S.bold]);
        if (f.restart) row.push(['  (au prochain lancement)', S.dim]);
      }
      rows.push(row);
    }
    return { rows, cursor };
  }

  move(dir) {
    let i = this.selected;
    do {
      i += dir;
    } while (i >= 0 && i < this.items.length && this.items[i].section);
    if (i >= 0 && i < this.items.length) this.selected = i;
  }

  save(f, value) {
    this.config.set(f.key, value);
    try {
      this.config.save();
    } catch (err) {
      this.app.flash(`Enregistrement impossible : ${err.message}`, 'err');
      return;
    }
    this.app.services.refreshSettings();
    this.app.flash(`${f.label} : ${this.valueText(f)}${f.restart ? ' — pris en compte au prochain lancement' : ''}`, 'ok');
  }

  commitEdit() {
    const { field: f, input } = this.editing;
    const raw = input.value.trim();
    this.editing = null;
    if (f.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < f.min || n > f.max) {
        this.app.flash(`Valeur invalide : entier entre ${f.min} et ${f.max}.`, 'err');
        return;
      }
      this.save(f, n);
    } else {
      this.save(f, raw === '' && f.nullable ? null : raw);
    }
  }

  async runAction(f) {
    const s = this.app.services;
    switch (f.action) {
      case 'tor': {
        this.app.flash(`Test de Tor sur ${s.tor.address}…`);
        const ok = await s.tor.isAvailable();
        this.app.setTorStatus(ok);
        this.app.flash(ok ? `Tor répond sur ${s.tor.address}.` : `Tor injoignable sur ${s.tor.address} (lancez « tor » ou Tor Browser).`, ok ? 'ok' : 'err');
        break;
      }
      case 'cache': {
        const dir = s.cache.dir;
        let size = 0;
        try {
          for (const f2 of fs.readdirSync(dir, { recursive: true })) {
            try { size += fs.statSync(`${dir}/${f2}`).size; } catch { /* ignoré */ }
          }
        } catch { /* dossier absent */ }
        s.cache.clear();
        this.app.flash(`Cache vidé (${formatBytes(size)} libérés).`, 'ok');
        break;
      }
      case 'history':
        this.app.flash(`${s.history.clear()} entrée(s) d’historique supprimée(s).`, 'ok');
        break;
      case 'index-web':
      case 'index-onion': {
        const n = s.indexer.clear(f.action === 'index-web' ? 'web' : 'onion');
        this.app.flash(`${n} page(s) retirée(s) de l’index.`, 'ok');
        break;
      }
      default:
    }
  }

  onKey(key) {
    if (this.confirming) {
      const f = this.confirming;
      this.confirming = null;
      if (key.name === 'char' && /^[oOyY]$/.test(key.char)) this.runAction(f);
      return true;
    }
    if (this.editing) {
      if (key.name === 'escape') this.editing = null;
      else if (key.name === 'enter') this.commitEdit();
      else this.editing.input.handle(key);
      return true;
    }
    const name = key.name === 'char' ? key.char : key.name;
    const f = this.items[this.selected];
    switch (name) {
      case 'down': case 'j': this.move(1); return true;
      case 'up': case 'k': this.move(-1); return true;
      case 'home': case 'g': this.selected = 0; this.move(1); return true;
      case 'end': case 'G': this.selected = this.items.length; this.move(-1); return true;
      case 'enter': case ' ':
        if (f.action) {
          if (f.confirm) this.confirming = f;
          else this.runAction(f);
        } else if (f.type === 'bool') this.save(f, !this.config.get(f.key));
        else if (f.type === 'enum') this.cycle(f, 1);
        else this.editing = { field: f, input: new LineInput(String(this.config.get(f.key) ?? '')) };
        return true;
      case 'left': case 'right': case '-': case '+': {
        const dir = name === 'left' || name === '-' ? -1 : 1;
        if (f.type === 'bool') this.save(f, dir > 0);
        else if (f.type === 'enum') this.cycle(f, dir);
        else if (f.type === 'int') {
          const v = Number(this.config.get(f.key)) || 0;
          const step = v >= 10000 ? 1000 : v >= 1000 ? 100 : v >= 100 ? 10 : 1;
          this.save(f, Math.min(f.max, Math.max(f.min, v + dir * step)));
        }
        return true;
      }
      case 'q': this.app.quit(); return true;
      default: return false;
    }
  }

  cycle(f, dir) {
    const i = f.options.indexOf(this.config.get(f.key));
    this.save(f, f.options[(i + dir + f.options.length) % f.options.length]);
  }
}
