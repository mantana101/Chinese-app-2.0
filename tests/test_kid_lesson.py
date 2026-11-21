#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Детский первый урок: пиньинь крупно и первым, тоны и чтение по слогам.

Ученики курса читают только с пиньинем, а первый урок рассчитан на
восьмилетнего ребёнка. Значит:

* пиньинь — главный текст карточки: крупный, первым, с разбором по слогам;
* чтение пиньинь объяснено по-русски (таблица «как читать»);
* пять тонов показаны контуром голоса и озвучены, а не только названы;
* диалог можно прочитать целиком с пиньиня и послушать;
* без набора текста руками (дети ещё не печатают).

Проверяем данные (src/data.js через node) и настоящий DOM (собранный
index.html через jsdom).
"""

import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "src", "data.js")
APP = os.path.join(ROOT, "src", "app.js")
CSS = os.path.join(ROOT, "src", "styles.css")
INDEX = os.path.join(ROOT, "index.html")

READ_SCRIPT = r"""
const fs = require('fs');
const code = fs.readFileSync(process.argv[1], 'utf8');
const { LESSONS, HOMEWORK } =
  new Function(code + '\nreturn { LESSONS, HOMEWORK };')();
process.stdout.write(JSON.stringify({ LESSONS, HOMEWORK }));
"""

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
  w.eval("window.__kidRoot = document.createElement('div'); window.__kidRoot.id = 'kidRoot'; document.body.appendChild(window.__kidRoot); renderLesson(window.__kidRoot, ['l1'])");
  const r = w.document.getElementById('kidRoot');
  const q = (s) => Array.from(r.querySelectorAll(s));
  const fs_ = (n) => parseFloat(w.getComputedStyle(n).fontSize);
  const out = {
    kidIntro: q('.kid-intro').length,
    vocabPanels: q('.vocab').length,
    kidCards: q('.kid-card').length,
    kidP: q('.kid-p').length,
    kidPpx: q('.kid-p').length ? fs_(q('.kid-p')[0]) : 0,
    kidHpx: q('.kid-h').length ? fs_(q('.kid-h')[0]) : 0,
    sylChips: q('.syl').length,
    toneCards: q('.tone-card').length,
    toneCurves: q('.tone-curve').length,
    toneButtons: q('[data-tone]').length,
    speakButtons: q('[data-speak]').length,
    slowButtons: q('[data-speak-slow]').length,
    dlgRows: q('.dlg-row').length,
    dlgPinyin: q('.dlg-p').length,
    kidIntroBeforeVocab: (() => {
      const all = Array.from(r.querySelectorAll('.panel'));
      const i1 = all.findIndex(n => n.classList.contains('kid-intro'));
      const i2 = all.findIndex(n => n.querySelector('.vocab'));
      return i1 >= 0 && i2 >= 0 ? i1 < i2 : false;
    })(),
    orderQuiz: q('.order-pool').length,
    quizOptions: q('.opt').length,
    title: w.eval("LESSONS.l1.title")
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 900);
"""


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def load_data():
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("нет node — нечем разобрать data.js")
    res = subprocess.run([node, "-e", READ_SCRIPT, DATA],
                         capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        raise AssertionError("data.js не разбирается: " + res.stderr[-500:])
    return json.loads(res.stdout)


TONE_MARKS = re.compile(r"[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]")


class KidLessonData(unittest.TestCase):
    """Данные первого урока написаны для ребёнка, читающего с пиньиня."""

    @classmethod
    def setUpClass(cls):
        cls.d = load_data()
        cls.l1 = cls.d["LESSONS"]["l1"]

    def test_lesson_is_kid_first(self):
        self.assertTrue(self.l1.get("kid"), "первый урок должен быть детским (kid: true)")
        self.assertIn("зовут", self.l1["title"], "в названии — простая житейская цель")

    def test_vocab_is_small_and_fully_annotated(self):
        v = self.l1["vocab"]
        self.assertLessEqual(len(v), 10, "ребёнку нельзя 16 слов сразу")
        self.assertGreaterEqual(len(v), 6, "но и меньше шести — урок пустой")
        for w in v:
            for key in ("h", "p", "r", "ru", "syl", "tone"):
                self.assertIn(key, w, f"у слова {w.get('h')} нет поля {key}")
            self.assertGreater(len(w["syl"]), 0, f"{w['h']}: нет слогов")
            self.assertEqual(len(w["syl"]), len(w["tone"]),
                             f"{w['h']}: слоги и тоны не совпадают по длине")
            self.assertTrue(TONE_MARKS.search(w["p"]) or 0 in w["tone"],
                            f"{w['h']}: в пиньине нет ни одного значка тона")
            self.assertTrue(w["note"], f"{w['h']}: нужно пояснение «как произнести»")

    def test_pinyin_guide_exists(self):
        g = self.l1["pinyinGuide"]
        self.assertGreaterEqual(len(g), 6, "чтение пиньинь должно быть разобрано")
        for row in g:
            self.assertTrue(row["g"] and row["ru"] and row["note"])
        joined = " ".join(row["g"] for row in g)
        for group in ("zh", "j", "ü"):
            self.assertIn(group, joined, f"в гидe чтения нет «{group}»")

    def test_five_tones_with_voice_contour(self):
        tones = self.l1["tones"]
        self.assertEqual([t["n"] for t in tones], [1, 2, 3, 4, 0],
                         "нужны все четыре тона и нейтральный")
        for t in tones:
            for key in ("mark", "name", "voice", "h", "p", "r"):
                self.assertTrue(t.get(key), f"тон {t['n']}: нет {key}")
            self.assertTrue(len(t["voice"]) > 15, f"тон {t['n']}: объяснение слишком короткое")

    def test_dialogue_is_readable_from_pinyin(self):
        d = self.l1["dialogue"]
        self.assertGreaterEqual(len(d), 4, "диалога мало — не с чем читать по ролям")
        for line in d:
            self.assertTrue(line["p"] and line["ru"] and line["r"],
                            f"реплика {line['h']}: нет пиньиня, русского чтения или перевода")
            self.assertIn(line["who"], ("А", "Б"), "роли должны быть А и Б")

    def test_practice_has_listening_and_tone_questions(self):
        quiz = self.l1["quiz"]
        self.assertGreaterEqual(len(quiz), 8, "практика стала мельче — так нельзя")
        kinds = {q["k"] for q in quiz}
        self.assertNotIn("gap", kinds, "дети не печатают — задания с вводом запрещены")
        self.assertIn("listen", kinds, "нужны задания «услышь и выбери»")
        self.assertIn("order", kinds, "нужна сборка фразы из слов-фишек")
        self.assertGreaterEqual(sum("тон" in q["q"] for q in quiz), 2,
                                "нужно минимум два вопроса про тоны")
        for q in quiz:
            if q["k"] == "listen":
                self.assertTrue(q.get("speak"), "задание на слух без звука")

    def test_homework_is_kid_friendly(self):
        hw = self.d["HOMEWORK"]["l1"]
        self.assertGreaterEqual(len(hw), 5)
        self.assertFalse([q for q in hw if q["k"] == "gap"], "домашка с набором иероглифов недоступна ребёнку")
        self.assertTrue(any("тон" in q["q"] for q in hw), "в домашке должна остаться работа с тонами")


class KidLessonRender(unittest.TestCase):
    """Урок рисуется: пиньинь идёт первым, тоны озвучены,DOM-порядок верный."""

    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("нет node — нечего проверять в браузере")
        if not os.path.isdir(os.path.join(ROOT, "node_modules", "jsdom")):
            raise unittest.SkipTest("нет jsdom — браузерные проверки пропущены")
        if not os.path.exists(INDEX):
            raise unittest.SkipTest("нет index.html — сначала сборка")
        res = subprocess.run([node, "-e", DOM_SCRIPT, INDEX,
                              os.path.join(ROOT, "node_modules")],
                             capture_output=True, text=True, timeout=180)
        if res.returncode != 0:
            raise AssertionError("jsdom упал: " + res.stderr[-800:])
        cls.out = json.loads(res.stdout)

    def test_kid_intro_comes_before_vocab(self):
        self.assertGreaterEqual(self.out["kidIntro"], 1, "блока «как читать пиньинь» нет")
        self.assertTrue(self.out["kidIntroBeforeVocab"],
                        "обучение чтению должно идти ДО словаря")

    def test_pinyin_is_the_biggest_text_on_card(self):
        self.assertEqual(self.out["kidP"], self.out["kidCards"],
                         "в каждой детской карточке должен быть крупный пиньинь")
        self.assertGreaterEqual(self.out["kidPpx"], 20,
                                f"пиньинь слишком мелкий: {self.out['kidPpx']}px")
        self.assertGreater(self.out["kidPpx"], self.out["kidHpx"],
                           "пиньинь должен быть крупнее иероглифа")

    def test_syllables_are_chipped(self):
        self.assertGreaterEqual(self.out["sylChips"], 10,
                                "слоги должны быть выделены отдельными фишками")

    def test_tones_are_drawn_and_playable(self):
        self.assertEqual(self.out["toneCards"], 5, "карточек тонов должно быть пять")
        self.assertEqual(self.out["toneCurves"], self.out["toneCards"],
                         "у каждого тона должен быть контур голоса (SVG)")
        self.assertEqual(self.out["toneButtons"], self.out["toneCards"],
                         "у каждого тона должна быть кнопка «послушать контур»")

    def test_every_chinese_string_is_speakable(self):
        self.assertGreaterEqual(self.out["speakButtons"], 15,
                                "оригинальных кнопок озвучки должно быть много: слова и диалог")
        self.assertGreaterEqual(self.out["slowButtons"], 10,
                                "нужны кнопки медленного прослушивания 🐢")

    def test_dialogue_rendered(self):
        self.assertGreaterEqual(self.out["dlgRows"], 4)
        self.assertEqual(self.out["dlgRows"], self.out["dlgPinyin"],
                         "в каждой реплике крупный пиньинь")

    def test_practice_renders_first_question(self):
        self.assertGreaterEqual(self.out["quizOptions"], 2,
                                "практика не отрисовалась: нет вариантов ответа")


class KidLessonWiring(unittest.TestCase):
    """Рендер и стили подключены: без этого данные мёртвые."""

    def test_app_has_kid_helpers(self):
        app = read("src", "app.js")
        for name in ("renderKidIntro", "kidVocabCard", "renderDialogue",
                     "toneCurveSVG", "toneNumber", "kid-vocab", "kid-card"):
            self.assertIn(name, app, f"в app.js нет {name}")

    def test_slow_speak_exists(self):
        app = read("src", "app.js")
        self.assertIn("data-speak-slow", app, "нет медленной озвучки")
        self.assertIn("0.5", app, "медленная озвучка должна снижать скорость")

    def test_css_styles_kid_blocks(self):
        css = read("src", "styles.css")
        m = re.search(r"\.kid-p\s*{[^}]*font-size:\s*(\d+(?:\.\d+)?)px", css)
        self.assertIsNotNone(m, "в styles.css нет крупного пиньиня .kid-p")
        self.assertGreaterEqual(float(m.group(1)), 20, ".kid-p слишком мелкий")
        self.assertGreater(float(m.group(1)), 22, ".kid-p должен быть крупнее иероглифа 22px")
        for cls in (".pg-grid", ".tone-cards", ".tone-curve", ".kid-vocab", ".dlg-row"):
            self.assertIn(cls, css, f"в styles.css нет {cls}")
        # Тёмная тема не должна остаться непрокрашенной.
        dark = re.findall(r':root\[data-theme="dark"\][^{]*\.?(kid|dlg|tone)[^{]*{', css)
        self.assertTrue(dark or "var(--" in css.split(".kid-p")[1][:400],
                        "детские блоки обязаны работать в тёмной теме")

    def test_dark_theme_uses_variables(self):
        css = read("src", "styles.css")
        start = css.index(".kid-p {")
        block = css[start:css.index("}", start)]
        self.assertNotIn("#", block, "в .kid-p должны быть переменные темы, не захардкоженный цвет")


if __name__ == "__main__":
    unittest.main()
