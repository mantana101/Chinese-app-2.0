#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Скорость и установка на телефон: gzip, манифест, офлайн-оболочка.

Две вещи, которые замечает каждый ученик:
  • страница весит 620 КБ — по мобильной сети это долго;
  • без интернета сайт не открывался вовсе, хотя весь курс внутри.
Здесь проверяется, что сервер сжимает ответ и отдаёт всё для PWA.
"""

import gzip
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


class PwaBase(unittest.TestCase):
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
        cls.server = server
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
            headers={"Accept-Encoding": "gzip"} if gzip_ok else {},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                status, hdrs, body = r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            status, hdrs, body = e.code, e.headers, e.read()
        # Распаковываем: сервер сжимает всё текстовое, и это правильно.
        if hdrs.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return status, hdrs, body


class Compression(PwaBase):
    def test_page_is_gzipped(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/", headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=20) as r:
            self.assertEqual(r.headers.get("Content-Encoding"), "gzip")
            packed = r.read()
        plain = gzip.decompress(packed)
        self.assertIn(b"<!DOCTYPE html>", plain)
        self.assertLess(len(packed), len(plain) * 0.5,
                        "сжатие должно уменьшать страницу хотя бы вдвое")

    def test_plain_request_still_works(self):
        """Клиент без gzip должен получить обычный HTML, а не мусор."""
        st, hdrs, body = self.get("/", gzip_ok=False)
        self.assertEqual(st, 200)
        self.assertIsNone(hdrs.get("Content-Encoding"))
        self.assertTrue(body.startswith(b"<!DOCTYPE html>"))

    def test_etag_differs_for_gzip(self):
        """Иначе браузер получит 304 и прочитает gzip как обычный HTML."""
        _, h1, _ = self.get("/", gzip_ok=False)
        _, h2, _ = self.get("/", gzip_ok=True)
        self.assertNotEqual(h1.get("ETag"), h2.get("ETag"))

    def test_vary_header_present(self):
        _, hdrs, _ = self.get("/")
        self.assertIn("Accept-Encoding", hdrs.get("Vary", ""))


class ManifestAndShell(PwaBase):
    def test_manifest_is_valid_json(self):
        st, hdrs, body = self.get("/manifest.json", gzip_ok=False)
        self.assertEqual(st, 200)
        self.assertIn("manifest", hdrs.get("Content-Type"))
        data = json.loads(body)
        self.assertIn("name", data)
        self.assertEqual(data["start_url"], "./")
        self.assertIn("192", " ".join(i["src"] for i in data["icons"]))

    def test_service_worker_is_served(self):
        st, hdrs, body = self.get("/sw.js", gzip_ok=False)
        self.assertEqual(st, 200)
        self.assertIn("javascript", hdrs.get("Content-Type"))
        src = body.decode("utf-8")
        self.assertIn("install", src)
        self.assertIn("fetch", src)
        self.assertNotIn("zh-app-v1", src, "версия кэша должна зависеть от сборки")

    def test_icons_are_real_png(self):
        for path in ("/icon-192.png", "/icon-512.png"):
            st, hdrs, body = self.get(path, gzip_ok=False)
            self.assertEqual(st, 200, path)
            self.assertEqual(hdrs.get("Content-Type"), "image/png")
            self.assertTrue(body.startswith(b"\x89PNG"), f"{path} — не PNG")
            self.assertGreater(len(body), 500, f"{path} подозрительно маленький")

    def test_unknown_file_is_still_the_app(self):
        """Любой другой путь отдаёт приложение, а не 404 из ниоткуда."""
        st, _, body = self.get("/some-unknown-page")
        self.assertEqual(st, 200)
        self.assertIn(b"<!DOCTYPE html>", body)

    def test_icons_are_in_repo(self):
        for name in ("icon-192.png", "icon-512.png", "manifest.json", "sw.js"):
            self.assertTrue(os.path.exists(os.path.join(ROOT, name)), f"нет {name}")


if __name__ == "__main__":
    unittest.main()
