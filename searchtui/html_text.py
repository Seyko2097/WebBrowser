"""Extraction du titre, du texte, de la description et des liens d'une page HTML (stdlib uniquement)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urldefrag, urljoin

SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "head"}
BLOCK_TAGS = {
    "p", "div", "br", "li", "ul", "ol", "tr", "table", "section", "article",
    "header", "footer", "nav", "aside", "main", "h1", "h2", "h3", "h4", "h5",
    "h6", "pre", "blockquote", "hr", "dt", "dd", "figcaption", "form",
}


@dataclass
class ParsedPage:
    title: str = ""
    description: str = ""
    text: str = ""
    links: list[str] = field(default_factory=list)


class _Extractor(HTMLParser):
    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.links: list[str] = []
        self.description = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self._in_title = True
        elif tag == "base" and attrs.get("href"):
            self.base_url = urljoin(self.base_url, attrs["href"])
        elif tag == "meta" and (attrs.get("name") or "").lower() == "description":
            self.description = (attrs.get("content") or "").strip()
        if tag in SKIP_TAGS and tag != "head":
            self._skip += 1
        if tag == "a" and attrs.get("href"):
            href = attrs["href"].strip()
            if not href.lower().startswith(("javascript:", "mailto:", "tel:", "data:")):
                url, _ = urldefrag(urljoin(self.base_url, href))
                if url.startswith(("http://", "https://")):
                    self.links.append(url)
        if tag in BLOCK_TAGS:
            self.text_parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        # <br/>, <meta .../> etc. : on ne veut pas incrémenter _skip pour un tag auto-fermant
        if tag in SKIP_TAGS:
            return
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in SKIP_TAGS and tag != "head" and self._skip:
            self._skip -= 1
        if tag in BLOCK_TAGS:
            self.text_parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title_parts.append(data)
        elif not self._skip:
            self.text_parts.append(data)


def _normalize(text: str) -> str:
    lines = (re.sub(r"[ \t\r\f\v\xa0]+", " ", line).strip() for line in text.split("\n"))
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()


def parse_html(html: str, base_url: str = "") -> ParsedPage:
    parser = _Extractor(base_url)
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # HTML très cassé : on garde ce qu'on a pu lire
        pass
    seen: set[str] = set()
    links = [u for u in parser.links if not (u in seen or seen.add(u))]
    return ParsedPage(
        title=_normalize(" ".join(parser.title_parts)).replace("\n", " "),
        description=parser.description,
        text=_normalize("".join(parser.text_parts)),
        links=links,
    )
