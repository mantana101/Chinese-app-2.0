#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Честность Мэймэй: видно, какой «мозг» ответил.

С AI_API_KEY чат отвечает облачной моделью — у ответа бейдж «🧠 умный ИИ»,
в шапке статус «умный ИИ включён». Без ключа — встроенные правила
(«📚 правила») и словари приложения («📖 словари»). Ученики и учитель
всегда видят, умный ИИ работает или нет, — и могут проверить это
вопросом «не по теме».
"""

import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DOM_SCRIPT = r"""
const fs = require('fs');
const {JSDOM} = require(process.argv[2] + '/jsdom/lib/api.js');
const dom = new JSDOM(fs.readFileSync(process.argv[1], 'utf8'), {
  runScripts: 'dangerously', url: 'http://127.0.0.1/', pretendToBeVisual: true,
  beforeParse(w) {
    w.matchMedia = () => ({matches: false, addEventListener(){}, removeEventListener(){}});
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    w.speechSynthesis = {speak(){}, cancel(){}, getVoices: () => []};
    w.scrollTo = () => {};
    w.fetch = () => Promise.reject(new Error('offline'));
  }
});
const w = dom.window;
setTimeout(() => {
  /* Мок сервера: w.__resp задаёт следующий ответ /api/tutor/chat. */
  w.fetch = () => w.__resp
    ? Promise.resolve({ json: () => Promise.resolve(w.__resp) })
    : Promise.reject(new Error('offline'));

  const host = w.document.createElement('div');
  host.id = 'tutor-host';
  w.document.body.appendChild(host);
  w.eval("window.__host = document.getElementById('tutor-host'); renderTutor(window.__host)");
  const q = (s) => host.querySelector(s);
  const out = { steps: [] };

  out.brainExists = !!w.document.getElementById('t-brain-state');
  out.brainInitial = out.brainExists ? w.document.getElementById('t-brain-state').textContent : '';

  /* 1. Онлайн + ключ: сервер отвечает mode 'ai' — бейдж «умный ИИ». */
  try { Object.defineProperty(w.Auth, 'online', { get: () => true, configurable: true }); }
  catch (e) { w.Auth = { online: true }; }
  w.__resp = { ok: true, mode: 'ai', reply: 'Тест умного ИИ: 你好 (nǐ hǎo) — привет!' };
  q('.t-chips button').click();
  setTimeout(() => {
    out.steps.push({
      aiBadge: !!q('.t-mode-ai'),
      aiBadgeText: q('.t-mode-ai') ? q('.t-mode-ai').textContent : '',
      brainAfterAi: w.document.getElementById('t-brain-state').textContent
    });

    /* 2. Офлайн: сервер недоступен — встроенные правила, честный бейдж. */
    Object.defineProperty(w.Auth, 'online', { get: () => false, configurable: true });
    w.__resp = null;
    q('.t-chips button:nth-child(3)').click();
    setTimeout(() => {
      out.steps.push({
        localBadge: !!q('.t-mode-local'),
        localBadgeText: q('.t-mode-local') ? q('.t-mode-local').textContent : '',
        brainAfterLocal: w.document.getElementById('t-brain-state').textContent
      });
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    }, 300);
  }, 500);
}, 900);
"""


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


class TutorBrainWiring(unittest.TestCase):
    """Статус-строка и бейджи подключены; README объясняет, как включить ИИ."""

    def test_client_shows_which_brain_answered(self):
        app = read("src", "app.js")
        self.assertIn('id="t-brain-state"', app, "в шапке чата нет строки «Мозг Мэймэй»")
        self.assertIn("function setBrain(", app, "нет обновления статуса мозга")
        self.assertIn("'zh_tutor_brain'", app, "статус не сохраняется за сессию")
        self.assertIn("'🧠 умный ИИ'", app, "нет бейджа облачного ИИ")
        self.assertIn("'📚 правила'", app, "нет бейджа встроенных правил")
        self.assertIn("mode: 'ai'", app, "ответ облачной модели не помечен")
        self.assertIn("{ mode: lastMode }", app, "офлайн-ответ не помечен")

    def test_readme_excludes_old_name_and_has_setup(self):
        readme = read("README.md")
        self.assertNotIn("Сяо Мин", readme, "в README остался старый помощник")
        self.assertIn("Как включить умный ИИ Мэймэй", readme)
        for var in ("AI_API_KEY", "AI_BASE_URL", "AI_MODEL"):
            self.assertIn(var, readme, f"в README нет переменной {var}")
        self.assertIn("gpt-4o-mini", readme, "в README нет модели по умолчанию")

    def test_css_styles_brain(self):
        css = read("src", "styles.css")
        for cls in (".t-brain", ".t-brain-state.on", ".t-mode-ai", ".t-mode-sources"):
            self.assertIn(cls, css, f"в styles.css нет {cls}")


class TutorBrainDom(unittest.TestCase):
    """jsdom: бейдж «🧠 умный ИИ» при ответе модели, «📚 правила» офлайн."""

    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("нет node — нечего проверять в браузере")
        if not os.path.isdir(os.path.join(ROOT, "node_modules", "jsdom")):
            raise unittest.SkipTest("нет jsdom — браузерные проверки пропущены")
        index = os.path.join(ROOT, "index.html")
        if not os.path.exists(index):
            raise unittest.SkipTest("нет index.html — сначала сборка")
        res = subprocess.run([node, "-e", DOM_SCRIPT, index,
                              os.path.join(ROOT, "node_modules")],
                             capture_output=True, text=True, timeout=180)
        if res.returncode != 0:
            raise AssertionError("jsdom упал: " + res.stderr[-800:])
        cls.out = json.loads(res.stdout)

    def test_brain_status_exists(self):
        self.assertTrue(self.out["brainExists"], "строка «Мозг Мэймэй» не отрисовалась")
        self.assertIn("задайте вопрос", self.out["brainInitial"])

    def test_ai_reply_is_badged_and_honest(self):
        st = self.out["steps"][0]
        self.assertTrue(st["aiBadge"], "ответ облачной модели без бейджа")
        self.assertIn("🧠", st["aiBadgeText"])
        self.assertIn("умный ИИ включён", st["brainAfterAi"])

    def test_offline_reply_honestly_local(self):
        st = self.out["steps"][1]
        self.assertTrue(st["localBadge"], "офлайн-ответ без честного бейджа")
        self.assertIn("📚", st["localBadgeText"])
        self.assertIn("встроенные правила", st["brainAfterLocal"])


if __name__ == "__main__":
    unittest.main()
