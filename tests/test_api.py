#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Регрессионные тесты сервера.

Запуск:
    python3 -m unittest discover -s tests -v

Каждый тест поднимает настоящий HTTP-сервер на свободном порту
с отдельной временной базой, поэтому тесты не зависят от порядка
и не трогают данные разработчика.
"""

import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402

# Журнал запросов в тестах не нужен — иначе CI-лог тонет в строках.
server.Handler.log_message = lambda self, fmt, *args: None


class ApiTestCase(unittest.TestCase):
    """База: временная БД + сервер на случайном порту."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        server.DB_PATH = os.path.join(self.tmpdir.name, "app.db")
        # Ограничители — модульные, поэтому сбрасываем их между тестами.
        for limiter in (server.login_limiter, server.register_limiter,
                        server.ai_limiter, server.client_error_limiter):
            with limiter._lock:
                limiter._hits.clear()

        server.init_db()
        conn = server.db()
        server.migrate(conn)
        conn.close()

        self.srv = server.ThreadedServer(("127.0.0.1", 0), server.Handler)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.thread.join(timeout=5)
        self.tmpdir.cleanup()

    # ---------- HTTP ----------

    def request(self, method, path, body=None, token=None, headers=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = None
        hdrs = dict(headers or {})
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        if token:
            hdrs["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read()
                return resp.status, raw, dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers)

    def json(self, method, path, body=None, token=None, headers=None):
        status, raw, hdrs = self.request(method, path, body, token, headers)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            payload = None
        return status, payload, hdrs

    # ---------- помощники ----------

    def db_count(self, sql, params=()):
        conn = sqlite3.connect(server.DB_PATH)
        try:
            return conn.execute(sql, params).fetchone()[0]
        finally:
            conn.close()

    def register_owner(self, name="Учитель", password="pass1234"):
        status, data, hdrs = self.json(
            "POST", "/api/auth/register",
            {"display_name": name, "password": password},
        )
        self.assertEqual(status, 200, data)
        return data["token"], data["user"]

    def make_invite(self, owner_token):
        status, data, _ = self.json("POST", "/api/class/invite", {}, owner_token)
        self.assertEqual(status, 200, data)
        return data["code"]

    def register_student(self, owner_token, name="Ученик", password="pass1234"):
        code = self.make_invite(owner_token)
        status, data, _ = self.json(
            "POST", "/api/auth/register",
            {"display_name": name, "password": password, "code": code},
        )
        self.assertEqual(status, 200, data)
        return data["token"], data["user"]

    def promote(self, owner_token, user_id, role="teacher"):
        status, data, _ = self.json(
            "POST", "/api/class/role",
            {"user_id": user_id, "role": role}, owner_token,
        )
        self.assertEqual(status, 200, data)


class TestRegistration(ApiTestCase):
    def test_first_user_becomes_owner(self):
        _, user = self.register_owner()
        self.assertEqual(user["role"], "owner")

    def test_second_user_without_invite_is_rejected(self):
        self.register_owner()
        status, data, _ = self.json(
            "POST", "/api/auth/register",
            {"display_name": "Второй", "password": "pass1234"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(data["error"], "bad_invite")

    def test_concurrent_registration_creates_exactly_one_owner(self):
        """Раньше гонка давала несколько владельцев одновременно."""

        def register(i):
            return self.request(
                "POST", "/api/auth/register",
                {"display_name": f"Racer{i}", "password": "pass1234"},
            )[0]

        with ThreadPoolExecutor(max_workers=12) as pool:
            statuses = list(pool.map(register, range(12)))

        self.assertEqual(
            self.db_count("SELECT COUNT(*) FROM users WHERE role = 'owner'"), 1,
            f"владельцев должно быть ровно один, ответы: {statuses}",
        )

    def test_invite_code_cannot_be_used_twice_concurrently(self):
        owner_token, _ = self.register_owner()
        code = self.make_invite(owner_token)

        def register(i):
            return self.request(
                "POST", "/api/auth/register",
                {"display_name": f"S{i}", "password": "pass1234", "code": code},
            )[0]

        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(register, range(8)))

        self.assertEqual(statuses.count(200), 1, statuses)
        self.assertEqual(
            self.db_count("SELECT COUNT(*) FROM users WHERE role = 'student'"), 1
        )

    def test_registration_is_rate_limited(self):
        """Раньше /api/auth/register не ограничивался — коды перебирались."""
        codes = []
        for _ in range(25):
            codes.append(self.request(
                "POST", "/api/auth/register",
                {"display_name": "Бот", "password": "pass1234", "code": "AAAA-2222"},
            )[0])
        self.assertIn(429, codes, "после лимита должен приходить 429")


class TestInputValidation(ApiTestCase):
    def test_malformed_student_id_returns_400(self):
        owner_token, _ = self.register_owner()
        for value in ("abc", None, [], {}, -5, 0):
            status, data, _ = self.json(
                "POST", "/api/class/grade",
                {"student_id": value, "grade": "5"}, owner_token,
            )
            self.assertEqual(status, 400, f"student_id={value!r} → {status} {data}")
            self.assertEqual(data["error"], "bad_id")

    def test_grade_for_missing_user_returns_404(self):
        owner_token, _ = self.register_owner()
        status, data, _ = self.json(
            "POST", "/api/class/grade", {"student_id": 999999, "grade": "5"}, owner_token
        )
        self.assertEqual(status, 404)
        self.assertEqual(data["error"], "not_found")

    def test_progress_payload_must_be_object(self):
        owner_token, _ = self.register_owner()
        for payload in ([1, 2, 3], "строка", 42):
            status, data, _ = self.json(
                "POST", "/api/progress", {"payload": payload}, owner_token
            )
            self.assertEqual(status, 400, f"payload={payload!r} → {status}")
            self.assertEqual(data["error"], "bad_payload")

    def test_oversized_body_is_rejected(self):
        owner_token, _ = self.register_owner()
        big = {"payload": {"x": "a" * (server.MAX_BODY_BYTES + 1000)}}
        status, data, _ = self.json("POST", "/api/progress", big, owner_token)
        self.assertEqual(status, 413, data)

    def test_broken_json_returns_400(self):
        owner_token, _ = self.register_owner()
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/progress",
            data=b"{not json",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {owner_token}"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=10)
            self.fail("ожидали ошибку")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)


class TestClassIntegrity(ApiTestCase):
    def test_hostile_progress_does_not_break_class_page(self):
        """Строка вместо числа в прогрессе валила всю страницу класса."""
        owner_token, _ = self.register_owner()
        student_token, _ = self.register_student(owner_token)
        status, _, _ = self.json(
            "POST", "/api/progress",
            {"payload": {"totalRight": "abc", "totalWrong": None,
                         "streak": {"evil": 1}, "days": "нет",
                         "lessons": {"l1": {"score": "oops", "done": True}}}},
            student_token,
        )
        self.assertEqual(status, 200)

        status, data, _ = self.json("GET", "/api/class/students", token=owner_token)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["count"], 1)
        self.assertIsInstance(data["students"][0]["avg_score"], int)

    def test_summarize_ignores_garbage(self):
        summary = server.summarize({
            "totalRight": "x", "totalWrong": [1], "streak": "y",
            "lessons": [1, 2], "days": {"a": 1}, "cards": "nope",
            "quizLog": 5,
        })
        self.assertEqual(summary["answers"], 0)
        self.assertEqual(summary["lessons_done"], 0)
        self.assertEqual(summary["cards"], 0)
        self.assertEqual(summary["lessons_total"], server.LESSONS_TOTAL)


class TestTeacherBoundaries(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.owner_token, self.owner = self.register_owner()
        self.t1_token, self.t1 = self.register_student(self.owner_token, "Teacher1")
        self.t2_token, self.t2 = self.register_student(self.owner_token, "Teacher2")
        self.promote(self.owner_token, self.t1["id"])
        self.promote(self.owner_token, self.t2["id"])

    def test_teacher_cannot_delete_another_teacher(self):
        status, data, _ = self.json(
            "POST", "/api/class/delete", {"student_id": self.t2["id"]}, self.t1_token
        )
        self.assertEqual(status, 403, data)
        self.assertEqual(
            self.db_count("SELECT COUNT(*) FROM users WHERE id = ?", (self.t2["id"],)), 1
        )

    def test_owner_can_delete_teacher(self):
        status, data, _ = self.json(
            "POST", "/api/class/delete", {"student_id": self.t2["id"]}, self.owner_token
        )
        self.assertEqual(status, 200, data)

    def test_teacher_cannot_grade_owner(self):
        status, data, _ = self.json(
            "POST", "/api/class/grade",
            {"student_id": self.owner["id"], "grade": "2"}, self.t1_token,
        )
        self.assertEqual(status, 403, data)
        self.assertEqual(self.db_count("SELECT COUNT(*) FROM grades"), 0)

    def test_teacher_cannot_reset_owner(self):
        status, data, _ = self.json(
            "POST", "/api/class/reset", {"student_id": self.owner["id"]}, self.t1_token
        )
        self.assertEqual(status, 403, data)

    def test_teacher_can_grade_student(self):
        student_token, student = self.register_student(self.owner_token, "Ученик1")
        status, data, _ = self.json(
            "POST", "/api/class/grade",
            {"student_id": student["id"], "grade": "5", "comment": "молодец"},
            self.t1_token,
        )
        self.assertEqual(status, 200, data)
        status, data, _ = self.json(
            "GET", f"/api/class/students/{student['id']}", token=self.t1_token
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["grade"]["grade"], "5")

    def test_owner_cannot_be_deleted(self):
        status, data, _ = self.json(
            "POST", "/api/class/delete", {"student_id": self.owner["id"]}, self.owner_token
        )
        self.assertEqual(status, 403)
        self.assertEqual(data["error"], "cannot_delete_owner")

    def test_student_cannot_reach_class_api(self):
        student_token, _ = self.register_student(self.owner_token, "Ученик2")
        for path, body in (("/api/class/students", None),
                           ("/api/class/grade", {"student_id": 1, "grade": "5"}),
                           ("/api/class/delete", {"student_id": 1})):
            method = "GET" if body is None else "POST"
            status, _, _ = self.json(method, path, body, student_token)
            self.assertEqual(status, 403, path)


class TestExport(ApiTestCase):
    def test_csv_formula_injection_is_escaped(self):
        owner_token, _ = self.register_owner()
        self.register_student(owner_token, "=cmd|' /C calc'!A0")

        status, raw, hdrs = self.request(
            "GET", "/api/class/export.csv", token=owner_token
        )
        self.assertEqual(status, 200)
        text = raw.decode("utf-8-sig")
        self.assertNotIn("\n=cmd", text)
        self.assertIn("'=cmd", text)
        self.assertIn("text/csv", hdrs.get("Content-Type", ""))


class TestRateLimiting(ApiTestCase):
    def test_login_is_blocked_after_repeated_failures(self):
        self.register_owner()
        statuses = []
        for _ in range(10):
            statuses.append(self.json(
                "POST", "/api/auth/login",
                {"username": "учитель", "password": "wrong"},
            )[0])
        self.assertIn(429, statuses, statuses)

    def test_spoofed_forwarded_for_does_not_bypass_limit(self):
        """Прокси дописывает адрес клиента справа; левые значения — подделка."""
        self.register_owner()
        statuses = []
        for i in range(12):
            statuses.append(self.json(
                "POST", "/api/auth/login",
                {"username": "учитель", "password": "wrong"},
                headers={"X-Forwarded-For": f"10.0.0.{i}, 127.0.0.1"},
            )[0])
        self.assertIn(429, statuses, f"подмена X-Forwarded-For обошла лимит: {statuses}")

    def test_successful_login_is_not_limited(self):
        self.register_owner()
        for _ in range(3):
            status, _, _ = self.json(
                "POST", "/api/auth/login",
                {"username": "учитель", "password": "pass1234"},
            )
            self.assertEqual(status, 200)


class TestTutor(ApiTestCase):
    def test_tutor_requires_session(self):
        """Раньше эндпоинт был анонимным и тратил серверный ключ ИИ."""
        status, data, _ = self.json("POST", "/api/tutor/chat", {"message": "привет"})
        self.assertEqual(status, 401, data)

    def test_tutor_works_without_api_key(self):
        # Без сети: в CI интернет есть, и иначе ответ мог прийти «из источников».
        old = server.SOURCES_ONLINE
        server.SOURCES_ONLINE = False
        self.addCleanup(setattr, server, "SOURCES_ONLINE", old)
        owner_token, _ = self.register_owner()
        status, data, _ = self.json(
            "POST", "/api/tutor/chat", {"message": "привет"}, owner_token
        )
        self.assertEqual(status, 200, data)
        self.assertEqual(data["mode"], "local")


class TestReliability(ApiTestCase):
    def test_errors_do_not_leak_connections(self):
        """Раньше исключения оставляли открытые соединения и сервер вставал."""
        owner_token, _ = self.register_owner()
        fd_dir = "/proc/self/fd"
        if not os.path.isdir(fd_dir):
            self.skipTest("нет /proc — пропускаем замер дескрипторов")

        before = len(os.listdir(fd_dir))
        for _ in range(25):
            self.json("POST", "/api/class/grade", {"student_id": "abc"}, owner_token)
            self.json("POST", "/api/class/grade", {"student_id": 999999}, owner_token)
        after = len(os.listdir(fd_dir))

        self.assertLessEqual(after - before, 5, f"утечка дескрипторов: {before}→{after}")

        # Сервер должен продолжать нормально обслуживать запросы.
        status, data, _ = self.json("POST", "/api/auth/login",
                                    {"username": "учитель", "password": "pass1234"})
        self.assertEqual(status, 200, data)

    def test_server_survives_unknown_routes(self):
        status, _, _ = self.request("GET", "/api/nope")
        self.assertEqual(status, 404)
        status, _, _ = self.request("GET", "/")
        self.assertEqual(status, 200)

    def test_security_headers_present(self):
        status, _, hdrs = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(hdrs.get("X-Content-Type-Options"), "nosniff")
        self.assertIn("default-src", hdrs.get("Content-Security-Policy", ""))
        self.assertEqual(hdrs.get("Referrer-Policy"), "no-referrer")


class TestSession(ApiTestCase):
    def test_logout_invalidates_token(self):
        owner_token, _ = self.register_owner()
        status, _, _ = self.json("POST", "/api/auth/logout", {}, owner_token)
        self.assertEqual(status, 200)
        status, _, _ = self.json("GET", "/api/auth/me", token=owner_token)
        self.assertEqual(status, 401)

    def test_expired_sessions_are_cleaned_on_login(self):
        owner_token, _ = self.register_owner()
        conn = sqlite3.connect(server.DB_PATH)
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
            ("expired-token", 1, 0, 1),
        )
        conn.commit()
        conn.close()

        self.json("POST", "/api/auth/login",
                  {"username": "учитель", "password": "pass1234"})
        self.assertEqual(
            self.db_count("SELECT COUNT(*) FROM sessions WHERE token = 'expired-token'"), 0
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestPasswords(ApiTestCase):
    def test_password_policy_is_eight_chars(self):
        self.assertEqual(server.MIN_PASSWORD_LEN, 8)

    def test_registration_rejects_short_password(self):
        status, data, _ = self.json(
            "POST", "/api/auth/register",
            {"display_name": "Короткий", "password": "1234567"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(data["error"], "weak_password")

    def test_change_own_password(self):
        token, _ = self.register_owner()
        status, data, _ = self.json(
            "POST", "/api/auth/password",
            {"current": "pass1234", "new": "newpass99"}, token,
        )
        self.assertEqual(status, 200, data)

        status, _, _ = self.json(
            "POST", "/api/auth/login", {"username": "учитель", "password": "pass1234"}
        )
        self.assertEqual(status, 401, "старый пароль должен перестать работать")

        status, _, _ = self.json(
            "POST", "/api/auth/login", {"username": "учитель", "password": "newpass99"}
        )
        self.assertEqual(status, 200, "новый пароль должен работать")

    def test_change_password_requires_correct_current(self):
        token, _ = self.register_owner()
        status, data, _ = self.json(
            "POST", "/api/auth/password",
            {"current": "неверный", "new": "newpass99"}, token,
        )
        self.assertEqual(status, 403)
        self.assertEqual(data["error"], "bad_password")

    def test_change_password_rejects_short_new(self):
        token, _ = self.register_owner()
        status, data, _ = self.json(
            "POST", "/api/auth/password",
            {"current": "pass1234", "new": "short"}, token,
        )
        self.assertEqual(status, 400)
        self.assertEqual(data["error"], "weak_password")

    def test_change_password_revokes_other_sessions(self):
        token, _ = self.register_owner()
        # Второе устройство входит тем же паролем и получает свой токен.
        status, other, _ = self.json(
            "POST", "/api/auth/login", {"username": "учитель", "password": "pass1234"}
        )
        self.assertEqual(status, 200)
        other_token = other["token"]

        status, _, _ = self.json(
            "POST", "/api/auth/password",
            {"current": "pass1234", "new": "newpass99"}, token,
        )
        self.assertEqual(status, 200)

        status, _, _ = self.json("GET", "/api/auth/me", token=other_token)
        self.assertEqual(status, 401, "посторонняя сессия должна быть отозвана")
        status, _, _ = self.json("GET", "/api/auth/me", token=token)
        self.assertEqual(status, 200, "текущая сессия должна остаться рабочей")

    def test_teacher_resets_student_password(self):
        owner_token, owner = self.register_owner()
        teacher_token, teacher = self.register_student(owner_token, "Учитель")
        self.promote(owner_token, teacher["id"])
        student_token, student = self.register_student(owner_token, "Ученик")

        status, data, _ = self.json(
            "POST", "/api/class/password",
            {"student_id": student["id"], "new_password": "temp12345"},
            teacher_token,
        )
        self.assertEqual(status, 200, data)

        status, _, _ = self.json("GET", "/api/auth/me", token=student_token)
        self.assertEqual(status, 401, "старая сессия ученика должна быть отозвана")

        status, _, _ = self.json(
            "POST", "/api/auth/login", {"username": "ученик", "password": "temp12345"}
        )
        self.assertEqual(status, 200)

    def test_teacher_cannot_reset_owner_password(self):
        owner_token, owner = self.register_owner()
        teacher_token, teacher = self.register_student(owner_token, "Учитель")
        self.promote(owner_token, teacher["id"])

        status, data, _ = self.json(
            "POST", "/api/class/password",
            {"student_id": owner["id"], "new_password": "hacked123"}, teacher_token,
        )
        self.assertEqual(status, 403, data)

    def test_staff_reset_rejects_short_password(self):
        owner_token, _ = self.register_owner()
        _, student = self.register_student(owner_token, "Ученик")
        status, data, _ = self.json(
            "POST", "/api/class/password",
            {"student_id": student["id"], "new_password": "123"}, owner_token,
        )
        self.assertEqual(status, 400)
        self.assertEqual(data["error"], "weak_password")


class TestProgressConflict(ApiTestCase):
    def test_stale_write_returns_server_state(self):
        token, _ = self.register_owner()
        status, first, _ = self.json(
            "POST", "/api/progress", {"payload": {"lessons": {"l1": {"done": True}}}}, token
        )
        self.assertEqual(status, 200)
        stamp = first["updated_at"]

        # Клиент отталкивается от старой версии — сервер обязан отказать.
        status, data, _ = self.json(
            "POST", "/api/progress",
            {"payload": {"lessons": {"l2": {"done": True}}}, "base_updated": stamp - 100},
            token,
        )
        self.assertEqual(status, 409, data)
        self.assertEqual(data["error"], "conflict")
        self.assertIn("l1", data["payload"]["lessons"],
                      "в ответе должно быть серверное состояние для объединения")

    def test_write_with_current_base_is_accepted(self):
        token, _ = self.register_owner()
        _, first, _ = self.json("POST", "/api/progress", {"payload": {"a": 1}}, token)
        status, data, _ = self.json(
            "POST", "/api/progress",
            {"payload": {"a": 2}, "base_updated": first["updated_at"]}, token,
        )
        self.assertEqual(status, 200, data)

    def test_write_without_base_is_accepted(self):
        token, _ = self.register_owner()
        self.json("POST", "/api/progress", {"payload": {"a": 1}}, token)
        status, data, _ = self.json("POST", "/api/progress", {"payload": {"a": 2}}, token)
        self.assertEqual(status, 200, data)

    def test_get_progress_returns_version(self):
        token, _ = self.register_owner()
        self.json("POST", "/api/progress", {"payload": {"a": 1}}, token)
        status, data, _ = self.json("GET", "/api/progress", token=token)
        self.assertEqual(status, 200)
        self.assertGreater(data["updated_at"], 0)
        self.assertIn("a", data["payload"])


class BuildVersionTestCase(ApiTestCase):
    """Версия сборки должна быть видна клиенту — иначе он не отличит
    старую страницу из кэша от новой."""

    def test_status_reports_build(self):
        status, data, _ = self.json("GET", "/api/auth/status")
        self.assertEqual(status, 200)
        self.assertIn("build", data)

    def test_index_is_not_cached(self):
        import urllib.request
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/")
        with urllib.request.urlopen(req) as res:
            self.assertEqual(res.status, 200)
            cache = res.headers.get("Cache-Control", "")
            self.assertIn("no-store", cache,
                          "страница не должна кэшироваться: иначе обновления не доезжают")
            self.assertTrue(res.headers.get("ETag"), "нужен ETag для проверки версии")
