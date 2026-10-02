"""Point d'entrée : python -m searchtui [tui|crawl|search|stats]"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from .crawler import Crawler, CrawlEvent
from .index import DEFAULT_DB, HL_END, HL_START, Index


def cmd_crawl(args) -> int:
    index = Index(args.db)
    crawler = Crawler(
        index,
        max_pages=args.max_pages,
        same_domain=not args.any_domain,
        delay=args.delay,
        respect_robots=not args.ignore_robots,
        recrawl=args.recrawl,
    )

    def on_event(ev: CrawlEvent) -> None:
        mark = "+" if ev.ok else "!"
        print(f"[{ev.indexed:>4}] {mark} {ev.url}  {ev.message}", file=sys.stderr if not ev.ok else sys.stdout)

    try:
        n = crawler.crawl(args.urls, on_event)
    except KeyboardInterrupt:
        n = None
        print("\nInterrompu.")
    print(f"Terminé. {'' if n is None else f'{n} page(s) ajoutée(s), '}{index.count()} au total dans {args.db}")
    index.close()
    return 0


def cmd_search(args) -> int:
    index = Index(args.db)
    results, total = index.search(" ".join(args.query), limit=args.limit)
    bold = "\033[1m" if sys.stdout.isatty() else ""
    reset = "\033[0m" if sys.stdout.isatty() else ""
    print(f"{total} résultat(s)")
    for i, r in enumerate(results, 1):
        snippet = re.sub(f"{HL_START}(.*?){HL_END}", lambda m: bold + m.group(1) + reset, r.snippet)
        print(f"\n{i}. {bold}{r.title}{reset}\n   {r.url}\n   {snippet}")
    index.close()
    return 0 if results else 1


def cmd_stats(args) -> int:
    index = Index(args.db)
    print(f"Index : {args.db}\nPages : {index.count()}")
    index.close()
    return 0


def cmd_tui(args) -> int:
    from .tui import run

    run(Path(args.db), max_pages=args.max_pages, same_domain=not args.any_domain, query=" ".join(args.query))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="searchtui", description="Moteur de recherche en terminal.")
    parser.add_argument("--db", default=str(DEFAULT_DB), help=f"fichier d'index SQLite (défaut : {DEFAULT_DB})")
    sub = parser.add_subparsers(dest="cmd")

    p = sub.add_parser("tui", help="interface interactive (par défaut)")
    p.add_argument("query", nargs="*", help="recherche initiale")
    p.add_argument("--max-pages", type=int, default=50, help="pages max par exploration lancée depuis l'interface")
    p.add_argument("--any-domain", action="store_true", help="suivre les liens vers d'autres domaines")
    p.set_defaults(func=cmd_tui)

    p = sub.add_parser("crawl", help="explorer et indexer des sites")
    p.add_argument("urls", nargs="+")
    p.add_argument("--max-pages", type=int, default=100)
    p.add_argument("--delay", type=float, default=0.5, help="secondes entre deux requêtes")
    p.add_argument("--any-domain", action="store_true", help="suivre les liens vers d'autres domaines")
    p.add_argument("--ignore-robots", action="store_true", help="ne pas lire robots.txt")
    p.add_argument("--recrawl", action="store_true", help="re-télécharger les pages déjà indexées")
    p.set_defaults(func=cmd_crawl)

    p = sub.add_parser("search", help="recherche non interactive")
    p.add_argument("query", nargs="+")
    p.add_argument("-n", "--limit", type=int, default=10)
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("stats", help="statistiques de l'index")
    p.set_defaults(func=cmd_stats)

    args = parser.parse_args(argv)
    if not args.cmd:
        args = parser.parse_args(["--db", args.db, "tui"])
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
