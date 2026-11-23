#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Апгрейд «всеми способами»: GitHub-словарь + голосовая похвала +
автопроизношение карточек + подсветка ступенек.

1. Словарь Мэймэй офлайн — полный CC-CEDICT из открытого репозитория
   edvardsr/cc-cedict (MIT): 120 029 записей вместо 11 474; русские
   переводы HSK сохранены и идут первыми; пиньинь со значками тонов.
2. Правильный ответ в квизе Мэймэй и отличный итог практики (≥80%)
   хвалятся голосом («太棒了! Молодец!») тем же голосом, что и уроки.
3. Карточки: слово звучит само при показе (PREFS.autoSpeak, по
   умолчанию включено; выключатель в Профиле).
4. Ступеньки урока: текущая подсвечена (последняя нажатая; по
   умолчанию первая), видно, где ребёнок в уроке.
"""

import json
import gzip
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
    w.__spoken = 0;
    w.__all = [];
    w.speechSynthesis = {
      speak(u) { w.__spoken++; w.__all.push((u && u.text) || ''); },
      cancel(){}, getVoices: () => []
    };
    w.SpeechSynthesisUtterance = function (text) { this.text = text; };
    w.scrollTo = () => {};
    w.fetch = () => Promise.reject(new Error('offline'));
  }
});
const w = dom.window;
setTimeout(() => {
  const out = {};
  try {
    /* 1. Карточки: автопроизношение первого слова (с задержкой 350 мс) */
    w.eval("window.__h = document.createElement('div'); window.__host = window.__h; document.body.appendChild(window.__h); renderCards(window.__h)");
    /* 2. Ступеньки: подсветка текущей и её смена по клику */
    w.eval("window.__s = renderSteps(LESSONS.l1)");
    const now1 = w.__s.querySelector('.step-now');
    out.stepDefault = now1 ? now1.dataset.step : '';
    w.__s.querySelector('[data-step=vocab]').click();
    const now2 = w.__s.querySelector('.step-now');
    out.stepAfterClick = now2 ? now2.dataset.step : '';
    /* 3. Похвала голосом за правильный ответ в квизе Мэймэй */
    w.eval("window.__host = window.__h; window.__h.innerHTML = ''; renderTutor(window.__h)");
    const chip = Array.from(w.__host.querySelectorAll('.t-chips button'))
      .find(b => b.textContent.includes('Проверь меня'));
    chip.click();
    setTimeout(() => {
      const opts = w.eval('(tutorHistory[tutorHistory.length-1].quiz || {}).opts || []');
      const target = w.eval('(tutorHistory[tutorHistory.length-1].quiz || {}).target || {}');
      const idx = opts.findIndex(o2 => o2.h === target.h);
      const btns = w.__host.querySelectorAll('.tutor-feed .t-quiz button');
      if (idx >= 0 && btns[idx]) btns[idx].click();
      setTimeout(() => {
        out.cardsSpoken = w.__spoken > 0 && w.__all.some(s => !/Молодец|Отлично|Правильно|Круто/.test(s));
        const praiseSay = w.__all.find(s => /Молодец|Отлично|Правильно|Круто/.test(s)) || '';
        out.praise = { spokenTotal: w.__spoken, text: praiseSay.slice(0, 60) };
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      }, 250);
    }, 400);
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }));
    process.exit(0);
  }
}, 900);
"""


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


class DictionaryUpgrade(unittest.TestCase):
    """Полный CC-CEDICT: 120k записей, тон-значки, русские переводы первыми."""

    def test_dictionary_size(self):
        with gzip.open(os.path.join(ROOT, "data", "cedict.txt.gz"),
                       "rt", encoding="utf-8") as f:
            n = sum(1 for _ in f)
        self.assertGreater(n, 100_000,
                           f"словарь должен стать полным (120k), сейчас {n}")
        self.assertLess(n, 200_000, "слишком много — фильтр сломался?")

    def test_toned_pinyin_is_correct(self):
        """Пиньинь пересобран со значками: huǒ guō, nǐ hǎo — не 'hǔo gūo'."""
        import importlib.util
        spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
        srv = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(srv)
        for w_, want in (("火锅", "huǒ guō"), ("你好", "nǐ hǎo")):
            hit = srv.cedict_lookup(w_)
            self.assertTrue(hit, f"{w_} не найдено")
            self.assertEqual(hit[0]["p"], want,
                             f"тоны: {w_} = {hit[0]['p']}, ожидалось {want}")

    def test_russian_translations_kept(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
        srv = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(srv)
        hit = srv.cedict_lookup("身份证")
        self.assertEqual(hit[0]["r"], "удостоверение личности",
                         "русский перевод HSK должен остаться первым")

    def test_readme_numbers_updated(self):
        readme = read("README.md")
        self.assertIn("120 029", readme, "в README старое число слов")
        self.assertIn("edvardsr/cc-cedict", readme, "нет ссылки на источник с GitHub")


class UpgradeWiring(unittest.TestCase):
    """Похвала, автопроизношение и подсветка подключены в коде."""

    def test_praise_code_present(self):
        app = read("src", "app.js")
        self.assertIn("PRAISE", app, "нет списка фраз похвалы")
        self.assertIn("speakRu(PRAISE", app, "правильный ответ не хвалится голосом")
        self.assertIn("Молодец! Отличная работа — урок засчитан!", app,
                      "итог практики ≥80% не хвалится голосом")

    def test_auto_speak_code_present(self):
        app = read("src", "app.js")
        self.assertIn("get autoSpeak()", app, "нет настройки PREFS.autoSpeak")
        self.assertIn("if (PREFS.autoSpeak) setTimeout", app, "карточка не озвучивается сама")
        self.assertIn("Автопроизношение: вкл", app, "нет выключателя в Профиле")

    def test_step_now_code_present(self):
        app = read("src", "app.js")
        self.assertIn("'step-now'", app, "нет подсветки текущей ступеньки")
        self.assertIn("'zh_step:'", app, "текущая ступенька не запоминается")
        css = read("src", "styles.css")
        self.assertIn(".step-chip.step-now", css, "нет стиля подсветки")


class UpgradeDom(unittest.TestCase):
    """jsdom: карточка звучит, ступенька подсвечивается, похвала звучит."""

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

    def test_no_errors(self):
        self.assertNotIn("error", self.out, "jsdom-сценарий упал: " + str(self.out))

    def test_card_speaks_automatically(self):
        self.assertTrue(self.out["cardsSpoken"],
                        "карточка не прозвучала сама при показе")

    def test_step_highlighted_and_moves_on_click(self):
        self.assertEqual(self.out["stepDefault"], "teacher",
                         "по умолчанию подсвечена первая ступенька")
        self.assertEqual(self.out["stepAfterClick"], "vocab",
                         "клик по ступеньке не переносит подсветку")

    def test_correct_answer_gets_voice_praise(self):
        pr = self.out.get("praise", {})
        self.assertGreater(pr.get("spokenTotal", 0), self.out["cardsSpoken"],
                           "похвала не прозвучала")
        self.assertTrue(any(w_ in pr.get("text", "") for w_ in ("Молодец", "Отлично", "Правильно", "Круто")),
                        "похвала не по-русски: " + pr.get("text", ""))


if __name__ == "__main__":
    unittest.main()
