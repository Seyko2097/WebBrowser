// Application plein écran : onglets (Recherche, Navigateur, Historique, Paramètres),
// barre d'état, raccourcis globaux et suivi des explorations en arrière-plan.
import { spawn } from 'node:child_process';
import { Terminal, S, clip, textWidth, filledRow } from './Terminal.js';
import { SearchView } from './Search/SearchView.js';
import { BrowserView } from './Browser/BrowserView.js';
import { HistoryView } from './History/HistoryView.js';
import { SettingsView } from './Settings/SettingsView.js';

const FLASH_STYLE = { info: S.bar, ok: '30;42', warn: '30;43', err: '97;41' };

export class TuiApp {
  constructor({ services, terminal = new Terminal(), version = '' }) {
    this.services = services;
    this.term = terminal;
    this.version = version;
    this.searchView = new SearchView(this);
    this.browserView = new BrowserView(this);
    this.historyView = new HistoryView(this);
    this.settingsView = new SettingsView(this);
    this.views = [this.searchView, this.browserView, this.historyView, this.settingsView];
    this.active = 0;
    this.flashMsg = null;
    this.torOk = null;
    this.pending = false;
    this.done = null;
  }

  get width() {
    return this.term.width;
  }

  get bodyHeight() {
    return this.term.height - 2;
  }

  get view() {
    return this.views[this.active];
  }

  // ------------------------------------------------------------------ cycle de vie

  run({ query = '', url = null } = {}) {
    this.term.start();
    this.onKey = (key) => this.handleKey(key);
    this.onResize = () => this.invalidate();
    this.term.on('key', this.onKey);
    this.term.on('resize', this.onResize);
    const { jobs } = this.services;
    this.onJobUpdate = () => this.invalidate();
    this.onJobFinished = (job) => {
      const s = job.stats;
      if (job.status === 'error') this.flash(`Exploration impossible : ${job.error}`, 'err', 8000);
      else this.flash(`Exploration ${job.status === 'stopped' ? 'arrêtée' : 'terminée'} : ${s.indexed} page(s) indexée(s), ${s.errors} erreur(s).`, 'ok', 6000);
      this.searchView.refresh();
    };
    jobs.on('update', this.onJobUpdate);
    jobs.on('finished', this.onJobFinished);
    this.checkTor();
    this.torTimer = setInterval(() => this.checkTor(), 30000);
    this.torTimer.unref();
    if (query) this.searchView.setQuery(query);
    if (url) this.openUrl(url);
    this.draw();
    return new Promise((resolve) => {
      this.done = resolve;
    });
  }

  quit() {
    clearInterval(this.torTimer);
    clearTimeout(this.flashTimer);
    this.term.off('key', this.onKey);
    this.term.off('resize', this.onResize);
    this.services.jobs.off('update', this.onJobUpdate);
    this.services.jobs.off('finished', this.onJobFinished);
    this.term.stop();
    this.done?.();
  }

  async checkTor() {
    this.setTorStatus(await this.services.tor.isAvailable(1500));
  }

  setTorStatus(ok) {
    if (this.torOk !== ok) {
      this.torOk = ok;
      this.invalidate();
    }
  }

  // ------------------------------------------------------------------ actions partagées

  switchTo(index) {
    if (index === this.active) return;
    this.active = index;
    this.view.onShow?.();
    this.invalidate();
  }

  flash(message, kind = 'info', ms = 4000) {
    this.flashMsg = { message, kind };
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashMsg = null;
      this.invalidate();
    }, ms);
    this.invalidate();
  }

  openUrl(url, opts = {}) {
    this.switchTo(1);
    this.browserView.load(url, opts);
  }

  openCached(url, opts = {}) {
    this.switchTo(1);
    this.browserView.showCached(url, opts);
  }

  search(query) {
    this.switchTo(0);
    this.searchView.setQuery(query);
  }

  startCrawl(url) {
    try {
      const job = this.services.jobs.start({ urls: [url] });
      this.flash(`Exploration ${job.network === 'onion' ? 'onion (via Tor)' : 'web'} lancée : ${job.seeds[0]}`, 'info');
    } catch (err) {
      this.flash(err.message, 'err');
    }
  }

  async download(url) {
    this.flash(`Téléchargement de ${url}…`);
    try {
      const file = await this.services.browser.download(url, { context: this.services.browser.defaultContext });
      this.flash(`Enregistré : ${file}`, 'ok', 8000);
    } catch (err) {
      this.flash(`Échec du téléchargement : ${err.message}`, 'err');
    }
  }

  openExternal(url) {
    if (/\.onion(\/|$|:)/i.test(new URL(url).host + '/')) {
      this.flash('Ouvrez les adresses .onion avec Tor Browser, pas un navigateur classique.', 'warn');
      return;
    }
    try {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => this.flash(`Impossible de lancer xdg-open. Adresse : ${url}`, 'err'));
      child.unref();
      this.flash(`Ouverture dans le navigateur par défaut : ${url}`);
    } catch {
      this.flash(`Impossible d’ouvrir un navigateur externe. Adresse : ${url}`, 'err');
    }
  }

  // ------------------------------------------------------------------ clavier

  handleKey(key) {
    if (key.name === 'ctrl-c') return this.quit();
    const tab = { f1: 0, f2: 1, f3: 2, f4: 3, 'alt-1': 0, 'alt-2': 1, 'alt-3': 2, 'alt-4': 3 }[key.name];
    if (tab !== undefined) {
      this.switchTo(tab);
      return undefined;
    }
    if (key.name === 'ctrl-x') {
      const running = this.services.jobs.running();
      if (running.length) {
        this.services.jobs.stopAll();
        this.flash(`Arrêt de ${running.length} exploration(s)…`, 'warn');
      } else this.flash('Aucune exploration en cours.');
      return undefined;
    }
    if (key.name === 'shift-tab') {
      this.switchTo((this.active + this.views.length - 1) % this.views.length);
      return undefined;
    }
    try {
      this.view.onKey(key);
    } catch (err) {
      this.flash(`Erreur : ${err.message}`, 'err');
    }
    this.invalidate();
    return undefined;
  }

  // ------------------------------------------------------------------ rendu

  invalidate() {
    if (this.pending || !this.term.active) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      if (this.term.active) this.draw();
    });
  }

  draw() {
    const w = this.term.width;
    const h = this.term.height;
    const rows = [this.header(w)];
    const { rows: body, cursor } = this.view.render(w, h - 2);
    for (let i = 0; i < h - 2; i++) rows.push(body[i] ?? []);
    rows.push(this.statusBar(w));
    this.term.draw(rows, cursor ? { row: cursor.row + 1, col: cursor.col } : null);
  }

  header(w) {
    const segs = [[' WebBrowser ', S.tab]];
    this.views.forEach((v, i) => {
      segs.push([` F${i + 1} ${v.title} `, i === this.active ? '1;7' : S.tabOff]);
    });
    const count = this.services.searchIndex.count();
    const tor = this.torOk === null ? '' : this.torOk ? ' Tor ● ' : ' Tor ○ ';
    const right = ` ${count} pages ${tor}`;
    const used = segs.reduce((n, [t]) => n + textWidth(t), 0);
    if (used + textWidth(right) < w) {
      segs.push([' '.repeat(w - used - textWidth(right)), S.tabOff]);
      segs.push([` ${count} pages `, S.tabOff]);
      if (tor) segs.push([tor, this.torOk ? '30;42' : '37;100']);
    }
    return filledRow(segs, S.tabOff);
  }

  statusBar(w) {
    if (this.flashMsg) {
      const style = FLASH_STYLE[this.flashMsg.kind] ?? S.bar;
      return filledRow([[` ${clip(this.flashMsg.message, w - 2)}`, style]], style);
    }
    const running = this.services.jobs.running();
    if (running.length) {
      const job = running[running.length - 1];
      const s = job.stats;
      const more = running.length > 1 ? ` (+${running.length - 1})` : '';
      const text = ` ⟳ Exploration${more} ${s.indexed}/${job.maxPages} pages · ${s.queued} en file · ${s.errors} err. — ${job.lastUrl ?? job.seeds[0]}`;
      return filledRow([[clip(text, w - 16), S.bar], ['  ^X: arrêter', S.barDim]], S.bar);
    }
    return filledRow([[` ${clip(this.view.help, w - 2)}`, S.bar]], S.bar);
  }
}
