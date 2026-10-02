"""Interface terminal (curses) : recherche instantanée, liste de résultats et lecteur de page."""

from __future__ import annotations

import curses
import os
import re
import textwrap
import threading
import unicodedata
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path

from .crawler import Crawler, CrawlEvent
from .index import HL_END, HL_START, Index, Page, Result

RESULT_HEIGHT = 4  # titre, url, extrait, ligne vide
HEADER_ROWS = 3
URL_RE = re.compile(r"^(https?://)?[\w-]+(\.[\w-]+)+(/\S*)?$")

HELP_SEARCH = "Entrée: résultats / explorer une URL  ↓: résultats  ^U: effacer  ^X: stop crawl  ^C: quitter"
HELP_RESULTS = "↑↓/jk: naviguer  Entrée: lire  o: navigateur  /: chercher  q: quitter"
HELP_READER = "↑↓/jk PgUp/PgDn: défiler  n/N: occurrence suiv./préc.  o: navigateur  q/Échap/←: retour"


def char_width(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def text_width(s: str) -> int:
    return sum(char_width(c) for c in s)


def clip(s: str, width: int) -> str:
    """Tronque s pour qu'il tienne en `width` colonnes (avec … si coupé)."""
    if width <= 0:
        return ""
    if text_width(s) <= width:
        return s
    out, used = [], 0
    for ch in s:
        w = char_width(ch)
        if used + w > width - 1:
            break
        out.append(ch)
        used += w
    return "".join(out) + "…"


def wrap_text(text: str, width: int) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        if not para.strip():
            lines.append("")
        else:
            lines.extend(textwrap.wrap(para, max(width, 10)) or [""])
    return lines


def query_terms(query: str) -> list[str]:
    return [t for t in re.findall(r"\w+", re.sub(r"(^|\s)-\w+", " ", query)) if len(t) > 1]


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).lower()


def term_spans(line: str, terms: list[str]) -> list[tuple[int, int]]:
    """Positions des mots de la ligne qui commencent par un terme (insensible casse/accents)."""
    if not terms:
        return []
    folded_terms = [_fold(t) for t in terms]
    spans = []
    for m in re.finditer(r"\w+", line):
        word = _fold(m.group())
        if any(word.startswith(t) for t in folded_terms):
            spans.append(m.span())
    return spans


@dataclass
class State:
    query: str = ""
    cursor: int = 0
    focus: str = "search"  # search | results | reader
    results: list[Result] = field(default_factory=list)
    total: int = 0
    selected: int = 0
    top: int = 0
    page: Page | None = None
    reader_lines: list[str] = field(default_factory=list)
    reader_top: int = 0
    reader_width: int = 0
    status: str = ""
    crawl_status: str = ""


class App:
    def __init__(self, stdscr, db_path: Path, max_pages: int = 50, same_domain: bool = True):
        self.scr = stdscr
        self.db_path = db_path
        self.index = Index(db_path)
        self.max_pages = max_pages
        self.same_domain = same_domain
        self.s = State()
        self.crawler: Crawler | None = None
        self.crawl_thread: threading.Thread | None = None
        self.crawl_done = threading.Event()
        self._lock = threading.Lock()
        self.page_count = self.index.count()
        self._init_colors()

    # ------------------------------------------------------------------ couleurs
    def _init_colors(self) -> None:
        self.c_title = curses.A_BOLD
        self.c_url = curses.A_DIM
        self.c_hl = curses.A_BOLD | curses.A_UNDERLINE
        self.c_bar = curses.A_REVERSE
        self.c_accent = curses.A_BOLD
        if curses.has_colors():
            curses.start_color()
            try:
                curses.use_default_colors()
                bg = -1
            except curses.error:
                bg = curses.COLOR_BLACK
            curses.init_pair(1, curses.COLOR_BLUE, bg)
            curses.init_pair(2, curses.COLOR_GREEN, bg)
            curses.init_pair(3, curses.COLOR_YELLOW, bg)
            curses.init_pair(4, curses.COLOR_BLACK, curses.COLOR_CYAN)
            curses.init_pair(5, curses.COLOR_CYAN, bg)
            self.c_title = curses.color_pair(1) | curses.A_BOLD
            self.c_url = curses.color_pair(2)
            self.c_hl = curses.color_pair(3) | curses.A_BOLD
            self.c_bar = curses.color_pair(4)
            self.c_accent = curses.color_pair(5) | curses.A_BOLD

    # ------------------------------------------------------------------ dessin
    def put(self, y: int, x: int, text: str, attr: int = 0, width: int | None = None) -> int:
        """Écrit du texte tronqué ; renvoie la colonne suivante."""
        h, w = self.scr.getmaxyx()
        if y < 0 or y >= h or x >= w:
            return x
        avail = (w - x) if width is None else min(width, w - x)
        text = clip(text, avail)
        try:
            self.scr.addstr(y, x, text, attr)
        except curses.error:
            pass  # écrire dans le coin inférieur droit lève une erreur, sans conséquence
        return x + text_width(text)

    def put_segments(self, y: int, x: int, segments: list[tuple[str, int]], width: int) -> None:
        end = x + width
        for text, attr in segments:
            if x >= end:
                break
            x = self.put(y, x, text, attr, end - x)

    def draw(self) -> None:
        self.scr.erase()
        h, w = self.scr.getmaxyx()
        if self.s.focus == "reader" and self.s.page:
            self.draw_reader(h, w)
        else:
            self.draw_search(h, w)
        self.draw_status(h, w)
        if self.s.focus == "search":
            curses.curs_set(1)
            before = text_width(self.s.query[: self.s.cursor])
            try:
                self.scr.move(1, min(4 + before, w - 1))
            except curses.error:
                pass
        else:
            curses.curs_set(0)
        self.scr.refresh()

    def draw_search(self, h: int, w: int) -> None:
        s = self.s
        x = self.put(0, 1, "searchtui", self.c_accent)
        self.put(0, x, f"  ·  {self.page_count} pages indexées", curses.A_DIM)
        box_attr = curses.A_BOLD if s.focus == "search" else curses.A_DIM
        self.put(1, 1, "›", self.c_accent)
        self.put(1, 2, "│", box_attr)
        self.put(1, 4, s.query or ("" if s.focus == "search" else "tapez / pour chercher"), 0 if s.query else curses.A_DIM)
        try:
            self.scr.hline(2, 0, curses.ACS_HLINE, w)
        except curses.error:
            pass

        body_h = h - HEADER_ROWS - 1
        if not s.query.strip():
            self.draw_welcome(HEADER_ROWS + 1, w)
            return
        if not s.results:
            self.put(HEADER_ROWS + 1, 2, "Aucun résultat.", curses.A_DIM)
            if URL_RE.match(s.query.strip()):
                self.put(HEADER_ROWS + 2, 2, "Appuyez sur Entrée pour explorer et indexer cette URL.", curses.A_DIM)
            return

        visible = max(1, body_h // RESULT_HEIGHT)
        if s.selected < s.top:
            s.top = s.selected
        elif s.selected >= s.top + visible:
            s.top = s.selected - visible + 1
        y = HEADER_ROWS
        for i in range(s.top, min(len(s.results), s.top + visible)):
            r = s.results[i]
            sel = i == s.selected and s.focus == "results"
            marker = "▌" if sel else " "
            self.put(y, 0, marker, self.c_accent)
            title_attr = self.c_title | (curses.A_REVERSE if sel else 0)
            self.put(y, 2, f"{i + 1}. {r.title}", title_attr, w - 3)
            self.put(y + 1, 0, marker, self.c_accent)
            self.put(y + 1, 2, r.url, self.c_url, w - 3)
            self.put(y + 2, 0, marker, self.c_accent)
            self.put_segments(y + 2, 2, self.snippet_segments(r.snippet), w - 3)
            y += RESULT_HEIGHT
        if s.total > len(s.results) or len(s.results) > visible:
            info = f" {s.selected + 1}/{s.total} "
            self.put(2, max(0, w - text_width(info) - 2), info, curses.A_DIM)

    def draw_welcome(self, y: int, w: int) -> None:
        lines = [
            ("Tapez votre recherche : les résultats s'affichent au fur et à mesure.", 0),
            ("", 0),
            ('  mots clés         tous les mots doivent apparaître', curses.A_DIM),
            ('  "une phrase"      expression exacte', curses.A_DIM),
            ("  -mot              exclure un mot", curses.A_DIM),
            ("", 0),
            ("Pour ajouter des pages à l'index, tapez une URL (ex. https://fr.wikipedia.org/wiki/Moteur_de_recherche)", 0),
            ("puis Entrée : le crawler l'explore en arrière-plan.", 0),
        ]
        if self.page_count == 0:
            lines.insert(0, ("L'index est vide.", self.c_hl))
            lines.insert(1, ("", 0))
        for i, (text, attr) in enumerate(lines):
            self.put(y + i, 2, text, attr, w - 4)

    def snippet_segments(self, snippet: str) -> list[tuple[str, int]]:
        segs: list[tuple[str, int]] = []
        for part in re.split(f"({HL_START}.*?{HL_END})", snippet):
            if part.startswith(HL_START):
                segs.append((part.strip(HL_START + HL_END), self.c_hl))
            elif part:
                segs.append((part, 0))
        return segs

    def draw_reader(self, h: int, w: int) -> None:
        s = self.s
        page = s.page
        assert page is not None
        width = max(20, min(w - 4, 100))
        if s.reader_width != width:
            self.layout_reader(width)
        self.put(0, 1, page.title or page.url, self.c_title, w - 2)
        self.put(1, 1, page.url, self.c_url, w - 2)
        try:
            self.scr.hline(2, 0, curses.ACS_HLINE, w)
        except curses.error:
            pass
        body_h = h - HEADER_ROWS - 1
        s.reader_top = max(0, min(s.reader_top, len(s.reader_lines) - body_h))
        terms = query_terms(s.query)
        for i, line in enumerate(s.reader_lines[s.reader_top : s.reader_top + body_h]):
            segs: list[tuple[str, int]] = []
            pos = 0
            for a, b in term_spans(line, terms):
                segs.append((line[pos:a], 0))
                segs.append((line[a:b], self.c_hl))
                pos = b
            segs.append((line[pos:], 0))
            self.put_segments(HEADER_ROWS + i, 2, segs, width)
        if s.reader_lines:
            pct = int(100 * min(1.0, (s.reader_top + body_h) / len(s.reader_lines)))
            info = f" {pct}% "
            self.put(2, max(0, w - len(info) - 2), info, curses.A_DIM)

    def draw_status(self, h: int, w: int) -> None:
        help_text = {"search": HELP_SEARCH, "results": HELP_RESULTS, "reader": HELP_READER}[self.s.focus]
        with self._lock:
            msg = self.s.crawl_status or self.s.status
        text = f" {msg} " if msg else f" {help_text} "
        self.put(h - 1, 0, text.ljust(w), self.c_bar, w)

    # ------------------------------------------------------------------ actions
    def run_search(self) -> None:
        s = self.s
        s.results, s.total = self.index.search(s.query, limit=100)
        s.selected = 0
        s.top = 0

    def layout_reader(self, width: int) -> None:
        page = self.s.page
        assert page is not None
        text = page.body
        if page.description and page.description not in text[:500]:
            text = page.description + "\n\n" + text
        self.s.reader_lines = wrap_text(text, width)
        self.s.reader_width = width

    def open_reader(self) -> None:
        s = self.s
        if not s.results:
            return
        page = self.index.get(s.results[s.selected].url)
        if not page:
            s.status = "Page introuvable dans l'index."
            return
        s.page = page
        s.reader_width = 0
        s.reader_top = 0
        s.focus = "reader"
        h, w = self.scr.getmaxyx()
        self.layout_reader(max(20, min(w - 4, 100)))
        self.jump_match(1, start=-1)

    def jump_match(self, direction: int, start: int | None = None) -> None:
        s = self.s
        terms = query_terms(s.query)
        if not terms:
            return
        i = (s.reader_top if start is None else start) + direction
        while 0 <= i < len(s.reader_lines):
            if term_spans(s.reader_lines[i], terms):
                s.reader_top = max(0, i - 2) if start is not None else i
                return
            i += direction
        if start is None:
            s.status = "Plus d'occurrence."

    def open_external(self, url: str) -> None:
        curses.def_prog_mode()
        curses.endwin()
        try:
            ok = webbrowser.open(url)
        except Exception:
            ok = False
        curses.reset_prog_mode()
        self.scr.refresh()
        self.s.status = f"Ouvert : {url}" if ok else f"Impossible d'ouvrir un navigateur. URL : {url}"

    def start_crawl(self, url: str) -> None:
        if self.crawl_thread and self.crawl_thread.is_alive():
            self.s.status = "Une exploration est déjà en cours (Ctrl-X pour l'arrêter)."
            return
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        self.crawl_done.clear()

        def on_event(ev: CrawlEvent) -> None:
            with self._lock:
                self.s.crawl_status = (
                    f"Exploration : {ev.indexed}/{self.max_pages} pages, {ev.queued} en file — {ev.url}"
                )

        def worker() -> None:
            index = Index(self.db_path)  # connexion propre au thread
            self.crawler = Crawler(index, max_pages=self.max_pages, same_domain=self.same_domain)
            try:
                n = self.crawler.crawl([url], on_event)
                msg = f"Exploration terminée : {n} page(s) indexée(s) depuis {url}"
            except Exception as e:
                msg = f"Erreur d'exploration : {e}"
            finally:
                index.close()
            with self._lock:
                self.s.crawl_status = ""
                self.s.status = msg
            self.crawl_done.set()

        with self._lock:
            self.s.crawl_status = f"Exploration de {url}…"
        self.crawl_thread = threading.Thread(target=worker, daemon=True)
        self.crawl_thread.start()

    # ------------------------------------------------------------------ clavier
    def handle_search_key(self, key) -> None:
        s = self.s
        if isinstance(key, str):
            code = ord(key) if len(key) == 1 else -1
            if key in ("\n", "\r"):
                q = s.query.strip()
                if q.startswith(("http://", "https://")) or (URL_RE.match(q) and not s.results):
                    self.start_crawl(q)
                elif s.results:
                    s.focus = "results"
                return
            if key == "\t":
                if s.results:
                    s.focus = "results"
                return
            if code == 21:  # Ctrl-U
                s.query, s.cursor = "", 0
            elif code == 23:  # Ctrl-W : effacer le mot précédent
                left = s.query[: s.cursor].rstrip()
                left = left[: len(left) - len(re.search(r"\S*$", left).group())]
                s.query, s.cursor = left + s.query[s.cursor :], len(left)
            elif code == 27:  # Échap
                if s.results:
                    s.focus = "results"
                return
            elif code in (8, 127):
                if s.cursor > 0:
                    s.query = s.query[: s.cursor - 1] + s.query[s.cursor :]
                    s.cursor -= 1
            elif code == 1:  # Ctrl-A
                s.cursor = 0
                return
            elif code == 5:  # Ctrl-E
                s.cursor = len(s.query)
                return
            elif key.isprintable():
                s.query = s.query[: s.cursor] + key + s.query[s.cursor :]
                s.cursor += len(key)
            else:
                return
            self.run_search()
            return
        if key == curses.KEY_BACKSPACE:
            self.handle_search_key("\x7f")
        elif key == curses.KEY_DC:
            if s.cursor < len(s.query):
                s.query = s.query[: s.cursor] + s.query[s.cursor + 1 :]
                self.run_search()
        elif key == curses.KEY_LEFT:
            s.cursor = max(0, s.cursor - 1)
        elif key == curses.KEY_RIGHT:
            s.cursor = min(len(s.query), s.cursor + 1)
        elif key == curses.KEY_HOME:
            s.cursor = 0
        elif key == curses.KEY_END:
            s.cursor = len(s.query)
        elif key in (curses.KEY_DOWN, curses.KEY_NPAGE) and s.results:
            s.focus = "results"

    def handle_results_key(self, key) -> bool:
        s = self.s
        h, _ = self.scr.getmaxyx()
        page = max(1, (h - HEADER_ROWS - 1) // RESULT_HEIGHT)
        n = len(s.results)
        if key in (curses.KEY_DOWN, "j"):
            s.selected = min(n - 1, s.selected + 1)
        elif key in (curses.KEY_UP, "k"):
            if s.selected == 0:
                s.focus = "search"
            s.selected = max(0, s.selected - 1)
        elif key == curses.KEY_NPAGE:
            s.selected = min(n - 1, s.selected + page)
        elif key == curses.KEY_PPAGE:
            s.selected = max(0, s.selected - page)
        elif key in (curses.KEY_HOME, "g"):
            s.selected = 0
        elif key in (curses.KEY_END, "G"):
            s.selected = max(0, n - 1)
        elif key in ("\n", "\r", curses.KEY_ENTER, curses.KEY_RIGHT, "l"):
            self.open_reader()
        elif key == "o" and s.results:
            self.open_external(s.results[s.selected].url)
        elif key == "q":
            return False
        elif key in ("/", "i", "\t", "\x1b"):
            s.focus = "search"
        elif isinstance(key, str) and key.isprintable():
            s.focus = "search"
            self.handle_search_key(key)
        return True

    def handle_reader_key(self, key) -> None:
        s = self.s
        h, _ = self.scr.getmaxyx()
        body_h = max(1, h - HEADER_ROWS - 1)
        if key in (curses.KEY_DOWN, "j"):
            s.reader_top += 1
        elif key in (curses.KEY_UP, "k"):
            s.reader_top = max(0, s.reader_top - 1)
        elif key in (curses.KEY_NPAGE, " ", "f"):
            s.reader_top += body_h - 1
        elif key in (curses.KEY_PPAGE, "b"):
            s.reader_top = max(0, s.reader_top - body_h + 1)
        elif key in (curses.KEY_HOME, "g"):
            s.reader_top = 0
        elif key in (curses.KEY_END, "G"):
            s.reader_top = len(s.reader_lines)
        elif key == "n":
            self.jump_match(1)
        elif key == "N":
            self.jump_match(-1)
        elif key == "o" and s.page:
            self.open_external(s.page.url)
        elif key in ("q", "\x1b", "h", curses.KEY_LEFT, curses.KEY_BACKSPACE, "\x7f"):
            s.focus = "results"
            s.page = None

    def handle_key(self, key) -> bool:
        if key == "\x03":  # Ctrl-C
            return False
        if key == "\x18":  # Ctrl-X
            if self.crawler and self.crawl_thread and self.crawl_thread.is_alive():
                self.crawler.stop()
                with self._lock:
                    self.s.crawl_status = "Arrêt de l'exploration…"
            return True
        if key == curses.KEY_RESIZE:
            self.s.reader_width = 0
            return True
        self.s.status = ""
        if self.s.focus == "search":
            self.handle_search_key(key)
        elif self.s.focus == "results":
            return self.handle_results_key(key)
        else:
            self.handle_reader_key(key)
        return True

    def loop(self) -> None:
        self.scr.keypad(True)
        self.scr.timeout(250)
        curses.raw()
        while True:
            if self.crawl_done.is_set():
                self.crawl_done.clear()
                self.page_count = self.index.count()
                if self.s.query and self.s.focus != "reader":
                    self.run_search()
            elif self.crawl_thread and self.crawl_thread.is_alive():
                self.page_count = self.index.count()
            self.draw()
            try:
                key = self.scr.get_wch()
            except curses.error:
                continue  # délai d'attente écoulé : on redessine
            except KeyboardInterrupt:
                break
            if not self.handle_key(key):
                break
        if self.crawler:
            self.crawler.stop()
        self.index.close()


def run(db_path: Path, max_pages: int = 50, same_domain: bool = True, query: str = "") -> None:
    os.environ.setdefault("ESCDELAY", "25")

    def main(stdscr):
        app = App(stdscr, db_path, max_pages=max_pages, same_domain=same_domain)
        if query:
            app.s.query = query
            app.s.cursor = len(query)
            app.run_search()
        app.loop()

    curses.wrapper(main)
