#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Витрина «кто сейчас на сайте» для учителя.

Учителю мало оценок: ему нужно видеть, кто реально заходит, а кто пропал.
Здесь проверяется, что сервер честно отмечает активность и отдаёт её
в /api/class/overview — без ложного «онлайн» и без утечки чужих данных.
"""

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


def fresh_server():
    os.environ["DB_PATH"] = tempfile.mktemp(suffix=".db")
    os.environ["SOURCES_ONLINE"] = "0"
    os.environ.pop("AI_API_KEY", None)
    os.environ.pop("OPENAI_API_KEY", None)
    import importlib
    import server
    importlib.reload(server)
    server.init_db()
    conn = server.db()
    server.migrate(conn)
    conn.close()
    return server


class LiveBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = fresh_server()
        cls.srv = cls.server.ThreadedServer(("127.0.0.1", 0), cls.server.Handler)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.thread.join(timeout=5)

    def call(self, path, data=None, token=None):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Content-Type": "application/json",
                     **({"Authorization": f"Bearer {token}"} if token else {})},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    @classmethod
    def owner(cls):
        """Владелец создаётся один раз: в базе он может быть только один."""
        if getattr(cls, "_owner_tok", None):
            return cls._owner_tok
        req = urllib.request.Request(
            f"http://127.0.0.1:{cls.port}/api/auth/register",
            data=json.dumps({"username": "owner_live", "password": "qwerty12345",
                             "display_name": "Учитель"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.loads(r.read() or b"{}")
        cls._owner_tok = d["token"]
        return cls._owner_tok

    def add_student(self, token, name):
        st, inv = self.call("/api/class/invite", {}, token)
        self.assertEqual(st, 200, inv)
        st, d = self.call("/api/auth/register", {
            "code": inv["code"], "username": name.lower(),
            "password": "qwerty12345", "display_name": name})
        self.assertEqual(st, 200, d)
        return d["token"]


class LiveOverview(LiveBase):
    def test_owner_sees_their_students_online(self):
        tok = self.owner()
        self.add_student(tok, "Али")
        st, ov = self.call("/api/class/overview", None, tok)
        self.assertEqual(st, 200, ov)
        self.assertIn("online", ov)
        names = [p["display_name"] for p in ov["online"]]
        self.assertIn("Али", names, "только что зашедший ученик должен быть онлайн")
        ali = [s for s in ov["students"] if s["display_name"] == "Али"][0]
        self.assertTrue(ali["online"])
        self.assertIsNotNone(ali["last_seen"])
        # «онлайн» в списке и в строке ученика — одно и то же
        self.assertEqual(set(names), {p["display_name"] for p in ov["online"]})

    def test_online_list_has_roles(self):
        tok = self.owner()
        st, ov = self.call("/api/class/overview", None, tok)
        roles = {p["role"] for p in ov["online"]}
        self.assertIn("owner", roles)

    def test_fourteen_days_of_activity(self):
        tok = self.owner()
        st, ov = self.call("/api/class/overview", None, tok)
        self.assertEqual(len(ov["days"]), 14, "нужна динамика за две недели")
        for d in ov["days"]:
            self.assertIn("day", d)
            self.assertIn("users", d)
        self.assertGreaterEqual(ov["days"][-1]["users"], 1)

    def test_old_session_is_not_online(self):
        """Сессия недельной давности не должна светиться как «сейчас на сайте»."""
        tok = self.owner()
        self.add_student(tok, "Соня")
        conn = self.server.db()
        conn.execute("UPDATE sessions SET last_seen = last_seen - ?",
                     (self.server.ONLINE_WINDOW + 3600,))
        conn.commit()
        conn.close()
        st, ov = self.call("/api/class/overview", None, tok)
        names = [p["display_name"] for p in ov["online"]]
        self.assertNotIn("Соня", names)
        sonya = [s for s in ov["students"] if s["display_name"] == "Соня"][0]
        self.assertFalse(sonya["online"])
        self.assertIsNotNone(sonya["last_seen"], "время последнего захода должно остаться")

    def test_student_cannot_see_class(self):
        tok = self.owner()
        stud = self.add_student(tok, "Петя")
        st, _ = self.call("/api/class/overview", None, stud)
        self.assertEqual(st, 403)

    def test_anonymous_cannot_see_class(self):
        st, _ = self.call("/api/class/overview")
        self.assertEqual(st, 403)


class LastSeenColumn(LiveBase):
    def test_migration_adds_last_seen(self):
        conn = self.server.db()
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
        conn.close()
        self.assertIn("last_seen", cols)

    def test_login_stamps_activity(self):
        tok = self.owner()
        conn = self.server.db()
        seen = conn.execute(
            "SELECT MAX(last_seen) m FROM sessions WHERE token = ?", (tok,)).fetchone()["m"]
        conn.close()
        self.assertIsNotNone(seen, "при создании сессии время активности пишется сразу")
        self.assertLess(abs(seen - __import__("time").time()), 120)


if __name__ == "__main__":
    unittest.main()
