"""Crawler en largeur (BFS) qui respecte robots.txt et alimente l'index."""

from __future__ import annotations

import time
import urllib.error
import urllib.request
import urllib.robotparser
from collections import deque
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlparse

from .html_text import parse_html
from .index import Index

USER_AGENT = "searchtui/0.1 (+https://github.com/seyko2097/webbrowser)"
MAX_BYTES = 3 * 1024 * 1024
MAX_BODY_CHARS = 200_000


@dataclass
class CrawlEvent:
    url: str
    ok: bool
    message: str
    indexed: int
    queued: int


def fetch(url: str, timeout: float = 10.0) -> tuple[str, str]:
    """Télécharge une page HTML. Renvoie (url finale, html). Lève ValueError si ce n'est pas du HTML."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.5"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        ctype = resp.headers.get("Content-Type", "")
        if "html" not in ctype.lower():
            raise ValueError(f"type ignoré : {ctype or 'inconnu'}")
        raw = resp.read(MAX_BYTES)
        charset = resp.headers.get_content_charset() or "utf-8"
        try:
            html = raw.decode(charset, errors="replace")
        except LookupError:
            html = raw.decode("utf-8", errors="replace")
        return resp.geturl(), html


class Crawler:
    def __init__(
        self,
        index: Index,
        max_pages: int = 100,
        same_domain: bool = True,
        delay: float = 0.5,
        timeout: float = 10.0,
        respect_robots: bool = True,
        recrawl: bool = False,
    ):
        self.index = index
        self.max_pages = max_pages
        self.same_domain = same_domain
        self.delay = delay
        self.timeout = timeout
        self.respect_robots = respect_robots
        self.recrawl = recrawl
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._stop = False

    def stop(self) -> None:
        self._stop = True

    def _allowed(self, url: str) -> bool:
        if not self.respect_robots:
            return True
        parts = urlparse(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                req = urllib.request.Request(origin + "/robots.txt", headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    rp.parse(resp.read().decode("utf-8", errors="replace").splitlines())
            except urllib.error.HTTPError as e:
                # 4xx : pas de robots.txt → tout est permis ; 5xx : prudence, on s'abstient
                rp = None if e.code < 500 else False
            except Exception:
                rp = None
            self._robots[origin] = rp
        rp = self._robots[origin]
        if rp is False:
            return False
        return rp is None or rp.can_fetch(USER_AGENT, url)

    def crawl(self, seeds: list[str], on_event: Callable[[CrawlEvent], None] | None = None) -> int:
        domains = {urlparse(s).netloc for s in seeds}
        queue: deque[str] = deque(seeds)
        seen: set[str] = set(seeds)
        indexed = 0
        last_fetch = 0.0

        def emit(url: str, ok: bool, msg: str) -> None:
            if on_event:
                on_event(CrawlEvent(url, ok, msg, indexed, len(queue)))

        while queue and indexed < self.max_pages and not self._stop:
            url = queue.popleft()
            if not self.recrawl and self.index.has(url):
                emit(url, True, "déjà indexée")
                continue
            if not self._allowed(url):
                emit(url, False, "interdit par robots.txt")
                continue
            wait = self.delay - (time.monotonic() - last_fetch)
            if wait > 0:
                time.sleep(wait)
            last_fetch = time.monotonic()
            try:
                final_url, html = fetch(url, self.timeout)
            except Exception as e:  # réseau, HTTP, type de contenu…
                emit(url, False, str(e) or e.__class__.__name__)
                continue
            page = parse_html(html, final_url)
            self.index.add_page(final_url, page.title, page.description, page.text[:MAX_BODY_CHARS])
            indexed += 1
            for link in page.links:
                if link in seen:
                    continue
                if self.same_domain and urlparse(link).netloc not in domains:
                    continue
                seen.add(link)
                queue.append(link)
            emit(final_url, True, page.title or "(sans titre)")
        return indexed
