// Navigateur texte : barre d'adresse, page lisible avec liens numérotés [n], historique précédent/suivant,
// recherche dans la page, liste des liens, téléchargement, indexation et exploration depuis la page.
import { S, LineInput, clip, textWidth, wrap, highlight, termsRegex } from '../Terminal.js';
import { Page } from '../../Backend/Browser/Page.js';
import { looksLikeUrl, isOnionUrl } from '../../Backend/Utils/Validator.js';

const LINK_REF = /\[\d+\]/g;
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

export class BrowserView {
  constructor(app) {
    this.app = app;
    this.title = 'Navigateur';
    this.page = null;
    this.lines = [];
    this.wrapWidth = 0;
    this.top = 0;
    this.mode = 'view'; // view | address | find | links
    this.address = new LineInput();
    this.findInput = new LineInput();
    this.findTerm = '';
    this.matches = [];
    this.linkBuffer = '';
    this.linkSelected = 0;
    this.linkTop = 0;
    this.loading = null;
    this.loadToken = 0;
    this.error = null;
    this.highlightTerms = null;
    this.frame = 0;
  }

  get context() {
    return this.app.services.browser.defaultContext;
  }

  get help() {
    switch (this.mode) {
      case 'address': return 'Entrée: ouvrir (ou chercher si ce n’est pas une adresse)  Échap: annuler';
      case 'find': return 'Entrée: chercher dans la page  Échap: annuler';
      case 'links': return '↑↓: choisir  Entrée: ouvrir  d: télécharger  Échap/L: retour à la page';
      default:
        return this.linkBuffer
          ? `Lien ${this.linkBuffer} — Entrée: ouvrir  d: télécharger  Échap: annuler`
          : 'n°+Entrée: suivre un lien  o: adresse  ←/h: précédent  →: suivant  /: chercher  L: liens  r: recharger  i: indexer  c: explorer  d: télécharger  e: navigateur externe';
    }
  }

  // ------------------------------------------------------------------ chargement

  async load(url, { push = true, highlight: terms = null, action = null } = {}) {
    const token = ++this.loadToken;
    this.loading = url;
    this.error = null;
    this.mode = 'view';
    this.linkBuffer = '';
    if (terms !== null) this.highlightTerms = terms;
    this.app.invalidate();
    const spin = setInterval(() => {
      this.frame++;
      this.app.invalidate();
    }, 120);
    try {
      const browser = this.app.services.browser;
      const page = action ? await action() : await browser.open(url, { context: this.context, push });
      if (token !== this.loadToken) return;
      if (page) this.setPage(page);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.error = { url, message: err.message };
    } finally {
      clearInterval(spin);
      if (token === this.loadToken) this.loading = null;
      this.app.invalidate();
    }
  }

  setPage(page) {
    this.page = page;
    this.address.set(page.url);
    this.wrapWidth = 0;
    this.top = 0;
    this.findTerm = '';
    this.matches = [];
    this.linkSelected = 0;
    this.linkTop = 0;
    this.error = null;
    // Saut au premier passage contenant les termes recherchés
    if (this.highlightTerms) {
      this.layout(this.app.width);
      const re = this.termsRe();
      if (re) {
        const first = this.lines.findIndex((l) => {
          re.lastIndex = 0;
          return re.test(l);
        });
        if (first > 3) this.top = first - 2;
      }
    }
  }

  /** Affiche la copie stockée dans l'index (utile hors ligne ou si le site ne répond plus). */
  showCached(url, { highlight: terms = null } = {}) {
    const { searchIndex, indexer } = this.app.services;
    const doc = searchIndex.get(url);
    if (!doc) {
      this.app.flash('Page absente de l’index.', 'err');
      return;
    }
    if (terms !== null) this.highlightTerms = terms;
    const links = indexer.getLinks(url).map((u, i) => ({ number: i + 1, url: u, text: '' }));
    const header = doc.description ? `${doc.description}\n\n` : '';
    const page = new Page({
      url: doc.url, title: `${doc.title} (version indexée du ${new Date(doc.fetchedAt).toLocaleString('fr-FR')})`,
      text: header + doc.body, links, network: doc.network, kind: 'cached', fetchedAt: doc.fetchedAt,
    });
    this.context.push(doc.url);
    this.setPage(page);
    this.app.invalidate();
  }

  termsRe() {
    if (!this.highlightTerms) return null;
    const terms = this.highlightTerms.replace(/(^|\s)(-\S+|site:\S+)/g, ' ').match(/[\p{L}\p{N}_]+/gu) ?? [];
    return termsRegex(terms);
  }

  layout(width) {
    const w = Math.max(20, Math.min(width - 4, 100));
    if (this.wrapWidth === w || !this.page) return;
    this.wrapWidth = w;
    this.lines = wrap(this.page.text, w);
    if (this.findTerm) this.matches = Page.findInLines(this.lines, this.findTerm);
  }

  // ------------------------------------------------------------------ rendu

  render(width, height) {
    const rows = [];
    let cursor = null;
    // Barre d'adresse
    const nav = `${this.context.canGoBack() ? '◀' : '◁'} ${this.context.canGoForward() ? '▶' : '▷'} `;
    if (this.mode === 'address') {
      const { text, cursorCol } = this.address.view(width - 6);
      rows.push([[' ', S.none], [nav, S.dim], [text, S.bold]]);
      cursor = { row: 0, col: 1 + nav.length + cursorCol };
    } else {
      const url = this.loading ?? this.page?.url ?? 'tapez « o » pour saisir une adresse';
      const state = this.loading ? ` ${SPINNER[this.frame % SPINNER.length]} chargement` : '';
      const badge = (this.loading ?? this.page?.url) && isOnionUrl(this.loading ?? this.page?.url) ? ' [Tor]' : '';
      rows.push([[' ', S.none], [nav, S.dim], [clip(url, width - nav.length - 16), this.page || this.loading ? S.url : S.dim],
        [badge, S.onion], [state, S.warn]]);
    }
    const title = this.page ? clip(this.page.title, width - 4) : '';
    rows.push([[' ', S.none], [title, S.title], [' ', S.none], ['─'.repeat(Math.max(0, width - textWidth(title) - 3)), S.dim]]);
    const bodyH = height - 2 - (this.mode === 'find' ? 1 : 0);

    if (this.error) {
      rows.push([], [['  Impossible de charger la page', S.err]], [[`  ${this.error.url}`, S.url]], []);
      for (const l of wrap(this.error.message, width - 6)) rows.push([[`  ${l}`, S.none]]);
      rows.push([], [['  r : réessayer  ·  p : version indexée (si disponible)  ·  o : autre adresse', S.dim]]);
    } else if (!this.page) {
      rows.push([], [['  Navigateur texte', S.accent]], [],
        [['  o ou Ctrl-L', S.bold], ['  saisir une adresse (les .onion passent par Tor)', S.dim]],
        [['  Entrée', S.bold], ['       sur un résultat de recherche pour l’ouvrir ici', S.dim]],
        [['  12 Entrée', S.bold], ['   suivre le lien numéro 12 d’une page', S.dim]]);
    } else if (this.mode === 'links') {
      rows.push(...this.renderLinks(width, bodyH));
    } else {
      this.layout(width);
      const maxTop = Math.max(0, this.lines.length - bodyH);
      this.top = Math.max(0, Math.min(this.top, maxTop));
      const rules = [{ re: LINK_REF, style: S.link }];
      const tre = this.termsRe();
      if (tre) rules.push({ re: tre, style: S.hl });
      if (this.findTerm) rules.push({ re: termsRegex([this.findTerm]) ?? /$^/g, style: S.sel });
      for (let i = this.top; i < Math.min(this.lines.length, this.top + bodyH); i++) {
        rows.push([['  ', S.none], ...highlight(this.lines[i], rules)]);
      }
      if (this.lines.length > bodyH) {
        const pct = Math.round((100 * Math.min(this.lines.length, this.top + bodyH)) / this.lines.length);
        rows[1].push([` ${pct}% `, S.dim]);
        rows[1][3] = ['─'.repeat(Math.max(0, width - textWidth(title) - 9)), S.dim];
      }
    }
    while (rows.length < height - 1) rows.push([]);
    if (this.mode === 'find') {
      const { text, cursorCol } = this.findInput.view(width - 14);
      rows[height - 1] = [[' Chercher : ', S.accent], [text, S.bold]];
      cursor = { row: height - 1, col: 12 + cursorCol };
    }
    return { rows, cursor };
  }

  renderLinks(width, bodyH) {
    const rows = [];
    const links = this.page.links;
    if (!links.length) return [[['  Aucun lien sur cette page.', S.dim]]];
    if (this.linkSelected < this.linkTop) this.linkTop = this.linkSelected;
    if (this.linkSelected >= this.linkTop + bodyH) this.linkTop = this.linkSelected - bodyH + 1;
    for (let i = this.linkTop; i < Math.min(links.length, this.linkTop + bodyH); i++) {
      const l = links[i];
      const sel = i === this.linkSelected;
      const num = `[${l.number}]`.padStart(6);
      const label = l.text ? `${clip(l.text, Math.floor(width / 2.5))}  ` : '';
      rows.push([[sel ? '▌' : ' ', S.accent], [num, S.link], [' ', S.none], [label, sel ? S.sel : S.bold], [l.url, S.url]]);
    }
    return rows;
  }

  // ------------------------------------------------------------------ clavier

  onKey(key) {
    if (this.mode === 'address') return this.onAddressKey(key);
    if (this.mode === 'find') return this.onFindKey(key);
    if (this.mode === 'links') return this.onLinksKey(key);
    return this.onViewKey(key);
  }

  openAddressBar(prefill = this.page?.url ?? '') {
    this.mode = 'address';
    this.address.set(prefill);
  }

  onAddressKey(key) {
    if (key.name === 'escape') {
      this.mode = 'view';
      return true;
    }
    if (key.name === 'enter') {
      const value = this.address.value.trim();
      this.mode = 'view';
      if (!value) return true;
      if (looksLikeUrl(value)) this.load(value);
      else this.app.search(value);
      return true;
    }
    return Boolean(this.address.handle(key));
  }

  onFindKey(key) {
    if (key.name === 'escape') {
      this.mode = 'view';
      return true;
    }
    if (key.name === 'enter') {
      this.mode = 'view';
      this.findTerm = this.findInput.value.trim();
      this.matches = this.findTerm ? Page.findInLines(this.lines, this.findTerm) : [];
      if (!this.findTerm) return true;
      if (!this.matches.length) this.app.flash(`« ${this.findTerm} » introuvable dans la page.`, 'warn');
      else this.jumpMatch(1, this.top - 1);
      return true;
    }
    return Boolean(this.findInput.handle(key));
  }

  jumpMatch(direction, from = this.top) {
    if (!this.matches.length) {
      this.app.flash(this.findTerm ? 'Aucune occurrence.' : 'Utilisez / pour chercher dans la page.', 'warn');
      return;
    }
    const next = direction > 0 ? this.matches.find((m) => m > from) : [...this.matches].reverse().find((m) => m < from);
    const target = next ?? (direction > 0 ? this.matches[0] : this.matches[this.matches.length - 1]);
    if (next === undefined) this.app.flash('Retour au début des occurrences.');
    this.top = target;
    const idx = this.matches.indexOf(target) + 1;
    this.app.flash(`Occurrence ${idx}/${this.matches.length}`);
  }

  onLinksKey(key) {
    const links = this.page?.links ?? [];
    const name = key.name === 'char' ? key.char : key.name;
    const page = Math.max(1, this.app.bodyHeight - 3);
    switch (name) {
      case 'down': case 'j': this.linkSelected = Math.min(links.length - 1, this.linkSelected + 1); return true;
      case 'up': case 'k': this.linkSelected = Math.max(0, this.linkSelected - 1); return true;
      case 'pagedown': case ' ': this.linkSelected = Math.min(links.length - 1, this.linkSelected + page); return true;
      case 'pageup': this.linkSelected = Math.max(0, this.linkSelected - page); return true;
      case 'enter': case 'right':
        if (links[this.linkSelected]) this.load(links[this.linkSelected].url);
        return true;
      case 'd':
        if (links[this.linkSelected]) this.app.download(links[this.linkSelected].url);
        return true;
      case 'escape': case 'L': case 'q': case 'left': this.mode = 'view'; return true;
      default: return false;
    }
  }

  onViewKey(key) {
    const name = key.name === 'char' ? key.char : key.name;
    const bodyH = Math.max(1, this.app.bodyHeight - 2);
    // Message d'erreur affiché : seules les actions qui s'y rapportent le gardent visible
    if (this.error && !['r', 'p', 'o', 'O', 'ctrl-l', 'q', 'e'].includes(name)) {
      this.error = null;
      if (name === 'escape') return true;
    }
    if (/^\d$/.test(name)) {
      this.linkBuffer = (this.linkBuffer + name).slice(0, 6);
      return true;
    }
    if (this.linkBuffer) {
      const link = this.page?.link(this.linkBuffer);
      if (name === 'enter' || name === 'd') {
        const n = this.linkBuffer;
        this.linkBuffer = '';
        if (!link) this.app.flash(`Pas de lien n°${n} sur cette page.`, 'warn');
        else if (name === 'd') this.app.download(link.url);
        else this.load(link.url);
        return true;
      }
      if (name === 'escape' || name === 'backspace') {
        this.linkBuffer = name === 'backspace' ? this.linkBuffer.slice(0, -1) : '';
        return true;
      }
    }
    switch (name) {
      case 'down': case 'j': this.top++; return true;
      case 'up': case 'k': this.top = Math.max(0, this.top - 1); return true;
      case 'pagedown': case ' ': this.top += bodyH - 1; return true;
      case 'pageup': case 'b': this.top = Math.max(0, this.top - bodyH + 1); return true;
      case 'home': case 'g': this.top = 0; return true;
      case 'end': case 'G': this.top = Number.MAX_SAFE_INTEGER; return true;
      case 'o': case 'ctrl-l': this.openAddressBar(); return true;
      case 'O': this.openAddressBar(''); return true;
      case 'left': case 'h': case 'backspace': {
        if (!this.context.canGoBack()) {
          this.app.flash('Pas de page précédente.');
          return true;
        }
        this.load(null, { action: () => this.app.services.browser.back(this.context) });
        return true;
      }
      case 'right': {
        if (!this.context.canGoForward()) {
          this.app.flash('Pas de page suivante.');
          return true;
        }
        this.load(null, { action: () => this.app.services.browser.forward(this.context) });
        return true;
      }
      case 'r':
        if (this.error) this.load(this.error.url, { push: false });
        else if (this.page) this.load(this.page.url, { push: false });
        return true;
      case 'p': {
        const url = this.error?.url ?? this.page?.url;
        if (url) this.showCached(url);
        return true;
      }
      case '/': this.mode = 'find'; this.findInput.set(this.findTerm); return true;
      case 'n': this.jumpMatch(1); return true;
      case 'N': this.jumpMatch(-1); return true;
      case 'L': if (this.page) this.mode = 'links'; return true;
      case 'i':
        if (this.page?.kind === 'html') {
          this.app.services.browser.index(this.page);
          this.app.flash('Page ajoutée à l’index.', 'ok');
        } else this.app.flash('Seules les pages HTML chargées peuvent être indexées.', 'warn');
        return true;
      case 'c': if (this.page) this.app.startCrawl(this.page.url); return true;
      case 'd': if (this.page) this.app.download(this.page.url); return true;
      case 'e': if (this.page) this.app.openExternal(this.page.url); return true;
      case 'x': this.highlightTerms = null; this.findTerm = ''; this.matches = []; return true;
      case 'q': case 'escape': this.app.switchTo(0); return true;
      default: return false;
    }
  }
}
