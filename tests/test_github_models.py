#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Настоящий ИИ Мэймэй через GitHub Models.

GitHub даёт бесплатный доступ к настоящим языковым моделям
(models.github.ai/inference, OpenAI-совместимый, ~15 запросов/мин и до
150/день на моделях низкого тарифа) по персональному токену GitHub —
без банковской карты. Сервер распознаёт GITHUB_MODELS_TOKEN сам и
подставляет правильные адрес и модель; в ответе передаёт имя модели,
чтобы в чате было видно, кто ответил.
"""

import http.client
import importlib
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAKE_REPLY = {"choices": [{"message": {"content": "你好 (nǐ hǎo) — привет!"}}]}


class FakeResp:
    """Ответ urllib в формате OpenAI-совместимого API."""

    def __init__(self, payload):
        self._b = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def reload_server(gh=None, ai=None, openai_key=None, base=None):
    os.environ["DB_PATH"] = tempfile.mktemp(suffix=".db")
    os.environ["SOURCES_ONLINE"] = "0"
    for k in ("AI_API_KEY", "OPENAI_API_KEY", "GITHUB_MODELS_TOKEN", "AI_BASE_URL"):
        os.environ.pop(k, None)
    if gh:
        os.environ["GITHUB_MODELS_TOKEN"] = gh
    if ai:
        os.environ["AI_API_KEY"] = ai
    if openai_key:
        os.environ["OPENAI_API_KEY"] = openai_key
    if base:
        os.environ["AI_BASE_URL"] = base
    import server
    importlib.reload(server)
    server.init_db()
    return server


class PresetCase(unittest.TestCase):
    """Живой сервер на случайном порту + перехват вызова к модели."""

    def setUp(self):
        # Базовый класс без собственных тестов.
        pass

    def boot(self, **env):
        server = reload_server(**env)
        for limiter in (server.login_limiter, server.register_limiter,
                        server.ai_limiter, server.client_error_limiter):
            with limiter._lock:
                limiter._hits.clear()
        srv = server.ThreadedServer(("127.0.0.1", 0), server.Handler)
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close(), th.join(timeout=5)))
        port = srv.server_address[1]
        self.base = f"http://127.0.0.1:{port}"
        self.server = server
        # Первый зарегистрированный пользователь становится владельцем
        req = urllib.request.Request(
            self.base + "/api/auth/register",
            data=json.dumps({"display_name": "Учитель", "password": "pass1234"}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read().decode())
        self.token = d["token"]

    def post_chat(self, captured):
        """POST /api/tutor/chat через http.client: внешний запрос не
        попадает в мок urlopen (он ловит только вызов к модели)."""

        def fake_urlopen(req, *a, **kw):
            captured["url"] = req.full_url
            captured["payload"] = json.loads(req.data.decode("utf-8"))
            return FakeResp(FAKE_REPLY)

        port = int(self.base.rsplit(":", 1)[1])
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            with mock.patch.object(self.server.urllib.request, "urlopen", fake_urlopen):
                conn.request("POST", "/api/tutor/chat",
                             body=json.dumps({"message": "привет"}),
                             headers={"Content-Type": "application/json",
                                      "Cookie": f"sid={self.token}"})
                r = conn.getresponse()
                return json.loads(r.read().decode("utf-8"))
        finally:
            conn.close()


class GitHubModelsPreset(PresetCase):
    """Токен GitHub сам включает правильные адрес и модель."""

    def test_github_token_selects_github_models(self):
        self.boot(gh="gh_test_token")
        captured = {}
        data = self.post_chat(captured)
        self.assertEqual(captured["url"], "https://models.github.ai/inference/chat/completions",
                         "токен GitHub должен вести в models.github.ai")
        self.assertEqual(captured["payload"]["model"], "openai/gpt-4o-mini",
                         "модель GitHub Models должна быть с префиксом издателя")
        self.assertEqual(data["mode"], "ai", data)
        self.assertEqual(data["model"], "openai/gpt-4o-mini",
                         "клиент должен видеть, какая модель ответила")

    def test_plain_ai_key_keeps_openai_defaults(self):
        self.boot(ai="sk_test")
        captured = {}
        data = self.post_chat(captured)
        self.assertEqual(captured["url"], "https://api.openai.com/v1/chat/completions")
        self.assertEqual(captured["payload"]["model"], "gpt-4o-mini")
        self.assertEqual(data["mode"], "ai", data)

    def test_without_tokens_stays_local(self):
        self.boot()
        captured = {}
        data = self.post_chat(captured)
        self.assertEqual(data["mode"], "local",
                         "без токенов должен работать встроенный движок")
        self.assertNotIn("url", captured, "внешний вызов к модели не должен случаться")

    def test_explicit_base_url_wins_over_preset(self):
        self.boot(gh="gh_test_token", base="https://api.deepseek.com/v1")
        captured = {}
        self.post_chat(captured)
        self.assertEqual(captured["url"], "https://api.deepseek.com/v1/chat/completions",
                         "явный AI_BASE_URL имеет приоритет над пресетом")


if __name__ == "__main__":
    unittest.main()
