"""Index plein texte basé sur SQLite FTS5 (classement BM25)."""

from __future__ import annotations

import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DB = Path.home() / ".searchtui" / "index.db"

# Marqueurs de surlignage utilisés dans les extraits (caractères de contrôle, invisibles dans du HTML normal)
HL_START = "\x01"
HL_END = "\x02"


@dataclass
class Result:
    url: str
    title: str
    snippet: str
    score: float


@dataclass
class Page:
    url: str
    title: str
    description: str
    body: str
    fetched_at: float


def build_fts_query(query: str) -> str:
    """Transforme une saisie libre en requête FTS5 sûre.

    - les "phrases entre guillemets" sont conservées telles quelles ;
    - un mot précédé de '-' est exclu (NOT) ;
    - le dernier mot est cherché en préfixe pour la recherche instantanée.
    """
    phrases = re.findall(r'"([^"]+)"', query)
    rest = re.sub(r'"[^"]*"?', " ", query)
    positive: list[str] = []
    negative: list[str] = []
    for phrase in phrases:
        words = re.findall(r"\w+", phrase)
        if words:
            positive.append('"' + " ".join(words) + '"')
    tokens = re.findall(r"-?\w+", rest)
    for i, tok in enumerate(tokens):
        if tok.startswith("-"):
            if tok[1:]:
                negative.append(f'"{tok[1:]}"')
            continue
        is_last = i == len(tokens) - 1 and not query.endswith((" ", '"'))
        positive.append(f'"{tok}"' + ("*" if is_last else ""))
    if not positive:
        return ""
    expr = " AND ".join(positive)
    for neg in negative:
        expr += f" NOT {neg}"
    return expr


class Index:
    def __init__(self, path: str | Path = DEFAULT_DB):
        self.path = Path(path)
        on_disk = str(path) != ":memory:"
        if on_disk:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        if on_disk:
            self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS pages (
                id INTEGER PRIMARY KEY,
                url TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                fetched_at REAL NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
                title, description, body, url,
                content='pages', content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            );
            CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
                INSERT INTO pages_fts(rowid, title, description, body, url)
                VALUES (new.id, new.title, new.description, new.body, new.url);
            END;
            CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
                INSERT INTO pages_fts(pages_fts, rowid, title, description, body, url)
                VALUES ('delete', old.id, old.title, old.description, old.body, old.url);
            END;
            CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
                INSERT INTO pages_fts(pages_fts, rowid, title, description, body, url)
                VALUES ('delete', old.id, old.title, old.description, old.body, old.url);
                INSERT INTO pages_fts(rowid, title, description, body, url)
                VALUES (new.id, new.title, new.description, new.body, new.url);
            END;
            """
        )
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def add_page(self, url: str, title: str, description: str, body: str) -> None:
        self.db.execute(
            """
            INSERT INTO pages(url, title, description, body, fetched_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
                title=excluded.title, description=excluded.description,
                body=excluded.body, fetched_at=excluded.fetched_at
            """,
            (url, title, description, body, time.time()),
        )
        self.db.commit()

    def has(self, url: str) -> bool:
        return self.db.execute("SELECT 1 FROM pages WHERE url=?", (url,)).fetchone() is not None

    def count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM pages").fetchone()[0]

    def get(self, url: str) -> Page | None:
        row = self.db.execute(
            "SELECT url, title, description, body, fetched_at FROM pages WHERE url=?", (url,)
        ).fetchone()
        return Page(*row) if row else None

    def search(self, query: str, limit: int = 50, offset: int = 0) -> tuple[list[Result], int]:
        """Renvoie (résultats, nombre total de correspondances)."""
        expr = build_fts_query(query)
        if not expr:
            return [], 0
        try:
            total = self.db.execute(
                "SELECT COUNT(*) FROM pages_fts WHERE pages_fts MATCH ?", (expr,)
            ).fetchone()[0]
            rows = self.db.execute(
                f"""
                SELECT p.url, p.title,
                       snippet(pages_fts, 2, '{HL_START}', '{HL_END}', ' … ', 24) AS snip,
                       bm25(pages_fts, 10.0, 4.0, 1.0, 2.0) AS score
                FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
                WHERE pages_fts MATCH ?
                ORDER BY score
                LIMIT ? OFFSET ?
                """,
                (expr, limit, offset),
            ).fetchall()
        except sqlite3.OperationalError:
            return [], 0
        results = [
            Result(url=u, title=t or u, snippet=" ".join(s.split()), score=-sc)
            for u, t, s, sc in rows
        ]
        return results, total
