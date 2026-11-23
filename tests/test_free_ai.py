#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Бесплатный настоящий ИИ без ключей: Pollinations.ai подключён сам.

Без каких-либо токенов сервер обращается к открытому публичному ИИ
(text.pollinations.ai/openai, проект с GitHub, без регистрации) и
возвращает ответ как mode:'ai' с моделью pollinations/openai — то есть
Мэймэй становится настоящим ИИ сразу после деплоя, без настроек.
FREE_AI=0 выключает (тогда — встроенный движок); ошибка сервиса
честно откатывает на встроенный движок/словари.
"""

import http.client
import json
import os
import unittest
from unittest import mock

from tests.test_github_models import FakeResp, FAKE_REPLY, PresetCase


class FreeAIDefault(PresetCase):
    """Без единого токена Мэймэй уже отвечает настоящим ИИ."""

    def test_no_tokens_free_ai_answers(self):
        self.boot()
        captured = {}
        data = self.post_chat(captured)
        self.assertEqual(captured.get("url"), "https://text.pollinations.ai/openai",
                         "бесплатный ИИ должен вызываться без ключей")
        self.assertEqual(data["mode"], "ai", data)
        self.assertEqual(data["model"], "pollinations/openai", data)
        self.assertTrue(data["reply"], "ответ пуст")

    def test_free_ai_messages_keep_meimei_prompt(self):
        self.boot()
        captured = {}
        self.post_chat(captured)
        msgs = captured["payload"]["messages"]
        self.assertTrue(any("Мэймэй" in m["content"] for m in msgs if m["role"] == "system"),
                         "в запросе к бесплатному ИИ нет личности Мэймэй")
        self.assertEqual(msgs[-1]["role"], "user")


class FreeAIOffAndFail(PresetCase):
    """Выключатель и честный откат при ошибке сервиса."""

    def test_free_ai_0_stays_local(self):
        os.environ["FREE_AI"] = "0"
        self.addCleanup(os.environ.pop, "FREE_AI", None)
        self.boot()
        captured = {}
        data = self.post_chat(captured)
        self.assertNotIn("url", captured, "при FREE_AI=0 внешних вызовов быть не должно")
        self.assertEqual(data["mode"], "local", data)

    def test_service_failure_falls_back_honestly(self):
        def boom(req, *a, **kw):
            raise OSError("free AI down")
        self.boot()
        captured = {}
        # мок падает — должно вернуться локальное/источниковое, а не 500
        with mock.patch.object(self.server.urllib.request, "urlopen", boom):
            port = int(self.base.rsplit(":", 1)[1])
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            conn.request("POST", "/api/tutor/chat",
                         body=json.dumps({"message": "привет"}),
                         headers={"Content-Type": "application/json",
                                  "Cookie": f"sid={self.token}"})
            r = conn.getresponse()
            data = json.loads(r.read().decode("utf-8"))
            conn.close()
        self.assertEqual(r.status, 200, data)
        self.assertEqual(data["mode"], "local", "падение бесплатного ИИ должно откатываться честно")


if __name__ == "__main__":
    unittest.main()
