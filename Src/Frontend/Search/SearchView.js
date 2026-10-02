// Écran de recherche : saisie instantanée, résultats avec extraits surlignés, filtres web/onion.
import { S, LineInput, clip, textWidth } from '../Terminal.js';
import { HL_START, HL_END } from '../../Backend/Crawler/Indexer/SearchIndex.js';
import { looksLikeUrl } from '../../Backend/Utils/Validator.js';

const RESULT_ROWS = 4;
const NETWORKS = [null, 'web', 'onion'];
const NETWORK_LABEL = { null: 'tout', web: 'web', onion: 'onion' };

export class SearchView {
  constructor(app) {
    this.app = app;
    this.title = 'Recherche';
    this.input = new LineInput();
    this.focus = 'input';
    this.results = [];
    this.total = 0;
    this.selected = 0;
    this.top = 0;
    this.network = null;
    this.pageSize = 100;
  }

  get help() {
    return this.focus === 'input'
      ? 'Entrée: résultats / ouvrir l’URL  ↓: résultats  ^R: explorer l’URL  ^O: filtre web/onion  ^U: effacer'
      : '↑↓ jk: naviguer  Entrée: ouvrir  p: version indexée  c: explorer le site  /: chercher  q: quitter';
  }

  get query() {
    return this.input.value;
  }

  setQuery(q) {
    this.input.set(q);
    this.focus = 'input';
    this.run();
  }

  run() {
    const { results, total } = this.app.services.searchIndex.search(this.query, { limit: this.pageSize, network: this.network });
    this.results = results;
    this.total = total;
    this.selected = 0;
    this.top = 0;
  }

  /** Relance la recherche courante (après une exploration) en gardant la sélection. */
  refresh() {
    if (!this.query.trim()) return;
    const sel = this.results[this.selected]?.url;
    this.run();
    const idx = this.results.findIndex((r) => r.url === sel);
    if (idx >= 0) this.selected = idx;
  }

  record() {
    if (this.query.trim() && this.lastRecorded !== this.query) {
      this.app.services.history.addSearch(this.query);
      this.lastRecorded = this.query;
    }
  }

  snippetSegments(snippet) {
    const segs = [];
    for (const part of snippet.split(new RegExp(`(${HL_START}[^${HL_END}]*${HL_END})`))) {
      if (!part) continue;
      if (part.startsWith(HL_START)) segs.push([part.slice(1, -1), S.hl]);
      else segs.push([part, S.none]);
    }
    return segs;
  }

  render(width, height) {
    const rows = [];
    const focused = this.focus === 'input';
    const filter = `[${NETWORK_LABEL[this.network]}]`;
    const inputWidth = Math.max(10, width - 6 - filter.length);
    const { text, cursorCol } = this.input.view(inputWidth);
    rows.push([
      [' › ', S.accent],
      [text || (focused ? '' : 'tapez / pour chercher'), text ? (focused ? S.bold : S.none) : S.dim],
      [' '.repeat(Math.max(1, inputWidth - textWidth(text) + 1)), S.none],
      [filter, this.network === 'onion' ? S.onion : S.dim],
    ]);
    const info = this.query.trim() ? ` ${this.total} résultat${this.total > 1 ? 's' : ''} ` : '';
    rows.push([['─'.repeat(Math.max(0, width - textWidth(info) - 2)), S.dim], [info, S.dim], ['──', S.dim]]);

    const bodyH = height - 2;
    if (!this.query.trim()) {
      rows.push(...this.welcome(width));
    } else if (!this.results.length) {
      rows.push([], [['  Aucun résultat.', S.dim]]);
      if (looksLikeUrl(this.query)) {
        rows.push([['  Entrée : ouvrir cette adresse dans le navigateur · Ctrl-R : l’explorer et l’indexer', S.dim]]);
      } else {
        rows.push([['  Astuce : ajoutez des pages à l’index en tapant une URL puis Ctrl-R.', S.dim]]);
      }
    } else {
      const visible = Math.max(1, Math.floor(bodyH / RESULT_ROWS));
      if (this.selected < this.top) this.top = this.selected;
      if (this.selected >= this.top + visible) this.top = this.selected - visible + 1;
      for (let i = this.top; i < Math.min(this.results.length, this.top + visible); i++) {
        const r = this.results[i];
        const sel = i === this.selected && this.focus === 'list';
        const bar = sel ? [['▌ ', S.accent]] : [['  ', S.none]];
        const badge = r.network === 'onion' ? [[' onion ', S.onion]] : [];
        rows.push([...bar, [`${i + 1}. `, S.dim], [clip(r.title, width - 12), sel ? S.selTitle : S.title], ...badge]);
        rows.push([...bar, [r.url, S.url]]);
        rows.push([...bar, ...this.snippetSegments(r.snippet || r.description || '')]);
        rows.push([]);
      }
    }
    return { rows, cursor: focused ? { row: 0, col: 3 + cursorCol } : null };
  }

  welcome(width) {
    const stats = this.app.services.searchIndex.stats();
    const lines = [
      [],
      [['  WebBrowser', S.accent], ['  —  moteur de recherche et navigateur pour le terminal', S.dim]],
      [],
      [[`  Index : ${stats.total} pages (${stats.web} web, ${stats.onion} onion) sur ${stats.hosts} sites`, S.none]],
      [],
      [['  Tapez votre recherche : les résultats s’affichent pendant la frappe.', S.none]],
      [],
      [['    mots clés          ', S.bold], ['tous les mots doivent apparaître', S.dim]],
      [['    "une phrase"       ', S.bold], ['expression exacte', S.dim]],
      [['    -mot               ', S.bold], ['exclure un mot', S.dim]],
      [['    site:exemple.fr    ', S.bold], ['limiter à un site', S.dim]],
      [],
      [['  Tapez une adresse puis ', S.none], ['Entrée', S.bold], [' pour la visiter, ou ', S.none], ['Ctrl-R', S.bold],
        [' pour explorer et indexer le site.', S.none]],
      [['  Les adresses .onion passent automatiquement par Tor.', S.dim]],
      [],
      [['  F1 ', S.bold], ['Recherche  ', S.dim], ['F2 ', S.bold], ['Navigateur  ', S.dim], ['F3 ', S.bold],
        ['Historique  ', S.dim], ['F4 ', S.bold], ['Paramètres  ', S.dim], ['Ctrl-C ', S.bold], ['Quitter', S.dim]],
    ];
    if (stats.total === 0) lines.splice(4, 0, [['  L’index est vide : commencez par explorer un site (Ctrl-R sur une URL).', S.hl]]);
    return lines.map((l) => l.map(([t, s]) => [clip(t, width), s]));
  }

  onKey(key) {
    return this.focus === 'input' ? this.onInputKey(key) : this.onListKey(key);
  }

  onInputKey(key) {
    const q = this.query.trim();
    switch (key.name) {
      case 'enter':
        if (looksLikeUrl(q)) {
          this.app.openUrl(q);
        } else if (this.results.length) {
          this.record();
          this.focus = 'list';
        }
        return true;
      case 'ctrl-r':
        if (looksLikeUrl(q)) this.app.startCrawl(q);
        else this.app.flash('Tapez une adresse (ex. exemple.fr) puis Ctrl-R pour l’explorer.', 'warn');
        return true;
      case 'ctrl-o':
        this.network = NETWORKS[(NETWORKS.indexOf(this.network) + 1) % NETWORKS.length];
        this.run();
        this.app.flash(`Filtre : ${NETWORK_LABEL[this.network]}`);
        return true;
      case 'down':
      case 'tab':
      case 'pagedown':
      case 'escape':
        if (this.results.length) this.focus = 'list';
        return true;
      default: {
        const r = this.input.handle(key);
        if (r === 'changed') this.run();
        return Boolean(r);
      }
    }
  }

  onListKey(key) {
    const n = this.results.length;
    const page = Math.max(1, Math.floor((this.app.bodyHeight - 2) / RESULT_ROWS));
    const current = this.results[this.selected];
    const name = key.name === 'char' ? key.char : key.name;
    switch (name) {
      case 'down': case 'j': this.selected = Math.min(n - 1, this.selected + 1); return true;
      case 'up': case 'k':
        if (this.selected === 0) this.focus = 'input';
        else this.selected--;
        return true;
      case 'pagedown': case ' ': this.selected = Math.min(n - 1, this.selected + page); return true;
      case 'pageup': this.selected = Math.max(0, this.selected - page); return true;
      case 'home': case 'g': this.selected = 0; return true;
      case 'end': case 'G': this.selected = Math.max(0, n - 1); return true;
      case 'enter': case 'right': case 'l':
        if (current) {
          this.record();
          this.app.openUrl(current.url, { highlight: this.query });
        }
        return true;
      case 'p':
        if (current) this.app.openCached(current.url, { highlight: this.query });
        return true;
      case 'c':
        if (current) this.app.startCrawl(current.url);
        return true;
      case 'q': this.app.quit(); return true;
      case '/': case 'i': case 'tab': case 'escape': this.focus = 'input'; return true;
      default:
        if (key.name === 'char' || key.name === 'backspace' || key.name === 'paste') {
          this.focus = 'input';
          return this.onInputKey(key);
        }
        return false;
    }
  }
}
