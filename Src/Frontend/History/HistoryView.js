// Historique des pages visitées et des recherches : rouvrir, filtrer, supprimer.
import { S, LineInput, clip, textWidth } from '../Terminal.js';

const KINDS = [null, 'visit', 'search'];
const KIND_LABEL = { null: 'tout', visit: 'pages visitées', search: 'recherches' };

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `aujourd’hui ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `hier ${time}`;
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' })} ${time}`;
}

export class HistoryView {
  constructor(app) {
    this.app = app;
    this.title = 'Historique';
    this.entries = [];
    this.selected = 0;
    this.top = 0;
    this.kind = null;
    this.filter = new LineInput();
    this.filtering = false;
    this.confirmClear = false;
  }

  get help() {
    if (this.confirmClear) return 'Effacer tout l’historique affiché ? o: oui  autre touche: non';
    if (this.filtering) return 'Tapez pour filtrer  Entrée/Échap: terminer';
    return '↑↓: naviguer  Entrée: rouvrir  x: supprimer  C: tout effacer  t: type  /: filtrer  q: quitter';
  }

  onShow() {
    this.reload();
  }

  reload() {
    this.entries = this.app.services.history.list({ kind: this.kind, filter: this.filter.value.trim(), limit: 1000 });
    this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
  }

  render(width, height) {
    const rows = [];
    const label = ` ${KIND_LABEL[this.kind]} · ${this.entries.length} entrée${this.entries.length > 1 ? 's' : ''} `;
    let cursor = null;
    if (this.filtering || this.filter.value) {
      const { text, cursorCol } = this.filter.view(width - 14);
      rows.push([[' Filtre : ', S.accent], [text, this.filtering ? S.bold : S.none]]);
      if (this.filtering) cursor = { row: 0, col: 10 + cursorCol };
    } else {
      rows.push([[' Historique', S.accent], [label, S.dim]]);
    }
    rows.push([['─'.repeat(width), S.dim]]);
    const bodyH = height - 2;
    if (!this.entries.length) {
      rows.push([], [['  Rien dans l’historique' + (this.filter.value ? ' pour ce filtre.' : '.'), S.dim]]);
      return { rows, cursor };
    }
    if (this.selected < this.top) this.top = this.selected;
    if (this.selected >= this.top + bodyH) this.top = this.selected - bodyH + 1;
    const dateW = 17;
    for (let i = this.top; i < Math.min(this.entries.length, this.top + bodyH); i++) {
      const e = this.entries[i];
      const sel = i === this.selected;
      const icon = e.kind === 'search' ? ' ⌕ ' : ' ↗ ';
      const date = formatDate(e.createdAt).padEnd(dateW);
      const main = e.kind === 'search' ? e.value : e.title || e.value;
      const rest = width - dateW - 5;
      const mainText = clip(main, Math.max(10, Math.floor(rest * 0.55)));
      const row = [[sel ? '▌' : ' ', S.accent], [date, S.dim], [icon, e.kind === 'search' ? S.warn : S.link],
        [mainText, sel ? S.sel : e.kind === 'search' ? S.bold : S.title]];
      if (e.kind === 'visit') row.push(['  ', S.none], [clip(e.value, rest - textWidth(mainText) - 2), S.url]);
      rows.push(row);
    }
    return { rows, cursor };
  }

  onKey(key) {
    if (this.confirmClear) {
      this.confirmClear = false;
      if (key.name === 'char' && /^[oOyY]$/.test(key.char)) {
        const n = this.app.services.history.clear(this.kind);
        this.reload();
        this.app.flash(`${n} entrée(s) supprimée(s).`, 'ok');
      }
      return true;
    }
    if (this.filtering) {
      if (key.name === 'enter' || key.name === 'escape' || key.name === 'down') {
        this.filtering = false;
        return true;
      }
      if (this.filter.handle(key) === 'changed') {
        this.selected = 0;
        this.reload();
      }
      return true;
    }
    const name = key.name === 'char' ? key.char : key.name;
    const n = this.entries.length;
    const current = this.entries[this.selected];
    const page = Math.max(1, this.app.bodyHeight - 3);
    switch (name) {
      case 'down': case 'j': this.selected = Math.min(n - 1, this.selected + 1); return true;
      case 'up': case 'k': this.selected = Math.max(0, this.selected - 1); return true;
      case 'pagedown': case ' ': this.selected = Math.min(n - 1, this.selected + page); return true;
      case 'pageup': this.selected = Math.max(0, this.selected - page); return true;
      case 'home': case 'g': this.selected = 0; return true;
      case 'end': case 'G': this.selected = Math.max(0, n - 1); return true;
      case 'enter': case 'right': case 'l':
        if (!current) return true;
        if (current.kind === 'search') this.app.search(current.value);
        else this.app.openUrl(current.value);
        return true;
      case 'x': case 'delete':
        if (current) {
          this.app.services.history.remove(current.id);
          this.reload();
        }
        return true;
      case 'C': if (n) this.confirmClear = true; return true;
      case 't':
        this.kind = KINDS[(KINDS.indexOf(this.kind) + 1) % KINDS.length];
        this.selected = 0;
        this.reload();
        return true;
      case '/': this.filtering = true; return true;
      case 'escape':
        if (this.filter.value) {
          this.filter.set('');
          this.reload();
        }
        return true;
      case 'q': this.app.quit(); return true;
      default: return false;
    }
  }
}
