import functools
import http.server
import threading
import unittest
from pathlib import Path

from searchtui.crawler import Crawler
from searchtui.html_text import parse_html
from searchtui.index import HL_START, Index, build_fts_query
from searchtui.tui import clip, query_terms, term_spans, text_width

SITE = Path(__file__).parent / "site"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class HtmlTextTest(unittest.TestCase):
    def test_extracts_title_text_links(self):
        page = parse_html((SITE / "index.html").read_text(), "http://h/")
        self.assertEqual(page.title, "Accueil du site de test")
        self.assertEqual(page.description, "Un petit site pour tester le crawler.")
        self.assertIn("moteurs de recherche", page.text)
        self.assertNotIn("motcache", page.text)
        self.assertNotIn("color:red", page.text)
        self.assertIn("http://h/python.html", page.links)
        self.assertIn("http://h/rust.html", page.links)  # fragment retiré
        self.assertFalse(any(link.startswith("mailto") for link in page.links))


class QueryTest(unittest.TestCase):
    def test_build_fts_query(self):
        self.assertEqual(build_fts_query("pyth"), '"pyth"*')
        self.assertEqual(build_fts_query("python "), '"python"')
        self.assertEqual(build_fts_query('"moteur de recherche" -google'), '"moteur de recherche" NOT "google"')
        self.assertEqual(build_fts_query('a" OR ('), '"a"*')
        self.assertEqual(build_fts_query("  "), "")


class IndexTest(unittest.TestCase):
    def setUp(self):
        self.index = Index(":memory:")
        self.index.add_page("http://a/1", "Éléphants d'Afrique", "", "Les éléphants vivent en troupeaux.")
        self.index.add_page("http://a/2", "Python", "", "Un langage. On parle aussi d'éléphants ici.")
        self.index.add_page("http://a/3", "Rust", "", "Un autre langage.")

    def test_ranking_and_snippet(self):
        results, total = self.index.search("elephant")  # sans accent, en préfixe
        self.assertEqual(total, 2)
        self.assertEqual(results[0].url, "http://a/1")  # titre pondéré plus fort
        self.assertIn(HL_START, results[0].snippet)

    def test_not_and_upsert(self):
        self.assertEqual(self.index.search("langage -rust")[1], 1)
        self.index.add_page("http://a/3", "Rust", "", "Plus rien sur ce sujet.")
        self.assertEqual(self.index.search("langage ")[1], 1)
        self.assertEqual(self.index.count(), 3)

    def test_weird_input_does_not_crash(self):
        for q in ['"', "(", "*", "NOT", "a AND", "-", '"unterminated']:
            self.index.search(q)


class CrawlerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(QuietHandler, directory=str(SITE))
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}/"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_crawl_same_domain_respects_robots(self):
        index = Index(":memory:")
        events = []
        n = Crawler(index, max_pages=20, delay=0).crawl([self.base + "index.html"], events.append)
        self.assertEqual(n, 3)
        self.assertIsNone(index.get(self.base + "prive/secret.html"))
        self.assertTrue(any("robots" in e.message for e in events))
        results, _ = index.search("interprété")
        self.assertEqual(results[0].url, self.base + "python.html")
        # seconde passe : rien de neuf
        self.assertEqual(Crawler(index, max_pages=20, delay=0).crawl([self.base + "index.html"]), 0)


class TuiHelpersTest(unittest.TestCase):
    def test_clip_and_width(self):
        self.assertEqual(clip("bonjour", 10), "bonjour")
        self.assertEqual(clip("bonjour", 4), "bon…")
        self.assertEqual(text_width("日本"), 4)
        self.assertLessEqual(text_width(clip("日本語テキスト", 5)), 5)

    def test_term_highlighting(self):
        terms = query_terms("elephant -rust")
        self.assertEqual(terms, ["elephant"])
        line = "Les Éléphants et les rusts"
        self.assertEqual([line[a:b] for a, b in term_spans(line, terms)], ["Éléphants"])


if __name__ == "__main__":
    unittest.main()
