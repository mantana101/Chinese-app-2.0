#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Скорость первого экрана: словарь и шрифты не должны его тормозить.

620 КБ в одном файле — это несколько секунд на мобильной сети. Здесь
проверяется, что тяжёлый словарь помощника больше не лежит в странице,
что он доступен отдельным файлом и что шрифты отдаются правильно.
"""

import gzip
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


class StaticBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["DB_PATH"] = tempfile.mktemp(suffix=".db")
        import importlib
        import server
        importlib.reload(server)
        server.init_db()
        conn = server.db()
        server.migrate(conn)
        conn.close()
        cls.srv = server.ThreadedServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.thread.join(timeout=5)

    def get(self, path, gzip_ok=True):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            headers={"Accept-Encoding": "gzip"} if gzip_ok else {})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()


class LazyLexicon(StaticBase):
    def test_page_does_not_contain_full_dictionary(self):
        """Иначе первый экран снова ждёт 30 КБ, нужных только помощнику."""
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
            html = f.read()
        # В коде ссылки на словарь остаются, а вот самих данных быть не должно.
        self.assertNotIn("const LEXICON_ROWS = [[", html,
                         "словарь должен грузиться отдельным файлом")
        self.assertIn("function loadLexicon", html)
        self.assertIn("lexicon.js", html)

    def test_lexicon_file_is_served_and_cached(self):
        status, headers, body = self.get("/lexicon.js", gzip_ok=False)
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers.get("Content-Type"))
        self.assertIn("LEXICON_ROWS", body.decode("utf-8", "ignore"))
        self.assertIn("max-age", headers.get("Cache-Control", ""))

    def test_page_is_smaller(self):
        """Сжатая страница должна быть заметно легче прежних 186 КБ."""
        _, _, raw = self.get("/")
        with open(os.path.join(ROOT, "index.html"), "rb") as f:
            packed = len(gzip.compress(f.read(), 9))
        self.assertLess(packed, 175_000, f"страница всё ещё тяжёлая: {packed} Б")


class Fonts(StaticBase):
    def test_font_css_has_fallback(self):
        with open(os.path.join(ROOT, "src", "fonts.css"), encoding="utf-8") as f:
            css = f.read()
        self.assertIn("unicode-range", css, "куски шрифта должны быть с диапазонами")
        self.assertIn("@font-face", css)

    def test_hanzi_family_lists_system_fonts_first(self):
        """Системный шрифт должен идти раньше нашего: тогда файл не качается."""
        with open(os.path.join(ROOT, "src", "styles.css"), encoding="utf-8") as f:
            css = f.read()
        start = css.index(".zh, .vcard .vc-h")
        fam = css[start:css.index("}", start)]
        self.assertLess(fam.index("PingFang SC"), fam.index("Noto Sans SC"),
                        "вшитый шрифт должен быть последним запасным вариантом")

    def test_font_file_is_served(self):
        names = [n for n in os.listdir(os.path.join(ROOT, "fonts")) if n.endswith(".woff2")]
        self.assertTrue(names, "нет ни одного файла шрифта")
        status, headers, body = self.get("/fonts/" + names[0], gzip_ok=False)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "font/woff2")
        self.assertTrue(body.startswith(b"wOF2"), "это не woff2")
        self.assertIn("immutable", headers.get("Cache-Control", ""))

    def test_font_folder_cannot_escape(self):
        """Через /fonts/ нельзя вытащить чужой файл с сервера."""
        for path in ("/fonts/../server.py", "/fonts/..%2Fserver.py"):
            status, headers, body = self.get(path, gzip_ok=False)
            self.assertNotIn(b"def serve_app", body, f"утечка через {path}")


if __name__ == "__main__":
    unittest.main()
