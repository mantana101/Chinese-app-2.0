#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Азбука пиньинь: полная, с русскими подсказками и озвучкой.

Ученики читают только с пиньиня, поэтому каждая буква должна быть
объяснена по-русски. Страница «Азбука» содержит все 23 начала слога,
все 24 конца, хитрые правила и пример-слово с озвучкой у каждой.
Данные — в src/data.js (PINYIN_ABC), страница — renderPinyin в src/app.js.
"""

import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "src", "data.js")
INDEX = os.path.join(ROOT, "index.html")

READ_SCRIPT = r"""
const fs = require('fs');
const { PINYIN_ABC } =
  new Function(fs.readFileSync(process.argv[1], 'utf8') + '\nreturn { PINYIN_ABC };')();
process.stdout.write(JSON.stringify(PINYIN_ABC));
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
  w.eval("window.__p = document.createElement('div'); window.__p.id='py'; document.body.appendChild(window.__p); renderPinyin(window.__p)");
  const r = w.document.getElementById('py');
  const q = (s) => Array.from(r.querySelectorAll(s));
  const out = {};
  out.title = r.querySelector('h1').textContent;
  out.about = q('.pabc-about .kid-lead').length;
  out.initialCards = q('.pabc-grid')[0] ? q('.pabc-grid')[0].querySelectorAll('.pabc-card').length : 0;
  out.finalCards = q('.pabc-grid')[1] ? q('.pabc-grid')[1].querySelectorAll('.pabc-card').length : 0;
  out.speakButtons = q('[data-speak]').length;
  out.tricky = q('.pabc-tricky').length;
  out.demo = q('.pd-part').length;
  out.demoSyls = q('.pd-syl b').map(b => b.textContent).join('|');
  out.links = q('a[href="#/lesson/l1"], a[href="#/tones"]').length;
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 900);
"""


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


class PinyinAbcData(unittest.TestCase):
    """Полный состав азбуки: 23 начала, 24 конца, у каждой — русская подсказка."""

    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("нет node — нечем разобрать data.js")
        res = subprocess.run([node, "-e", READ_SCRIPT, DATA],
                             capture_output=True, text=True, timeout=120)
        if res.returncode != 0:
            raise AssertionError("data.js не разбирается: " + res.stderr[-500:])
        cls.abc = json.loads(res.stdout)

    def test_counts_are_complete(self):
        self.assertEqual(len(self.abc["initials"]), 23,
                         "в пиньине ровно 23 начала слога")
        self.assertEqual(len(self.abc["finals"]), 24,
                         "в пиньине ровно 24 конца слога")

    def test_every_letter_fully_annotated(self):
        for kind in ("initials", "finals"):
            for e in self.abc[kind]:
                for key in ("k", "ru", "ex", "note"):
                    self.assertIn(key, e, f"{kind}: у «{e.get('k')}» нет {key}")
                self.assertTrue(e["ru"].strip(), f"{e['k']}: пустая русская подсказка")
                self.assertTrue(len(e["note"]) > 8, f"{e['k']}: пояснение слишком короткое")
                self.assertTrue(e["ex"]["h"] and e["ex"]["syl"] and e["ex"]["r"],
                                f"{e['k']}: пример должен иметь иероглифы, пиньинь и перевод")
                self.assertRegex(e["ex"]["syl"], r"[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]",
                                 f"{e['k']}: в пиньине примера нужен значок тона")

    def test_initials_are_exactly_the_standard_set(self):
        got = [e["k"] for e in self.abc["initials"]]
        want = ["b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h",
                "j", "q", "x", "zh", "ch", "sh", "r", "z", "c", "s", "y", "w"]
        self.assertEqual(sorted(got), sorted(want), "набор начал слога должен быть стандартным")

    def test_key_finals_present(self):
        got = {e["k"] for e in self.abc["finals"]}
        for k in ("a", "o", "e", "i", "u", "ü", "ai", "ei", "ui", "ao", "ou", "iu",
                  "ie", "üe", "er", "an", "en", "in", "un", "ün", "ang", "eng", "ing", "ong"):
            self.assertIn(k, got, f"в азбуке нет конца слога «{k}»")

    def test_about_explains_what_pinyin_is(self):
        text = " ".join(self.abc["about"]).lower()
        self.assertIn("алфавит", text, "объяснение должно называть пиньинь алфавитом звуков")
        self.assertIn("иероглиф", text, "и нужно отличие от иероглифа")
        self.assertGreaterEqual(len(self.abc["about"]), 3)


class PinyinPageWiring(unittest.TestCase):
    """Страница подключена: маршрут, меню, вход из урока 1."""

    def test_route_and_nav(self):
        app = read("src", "app.js")
        self.assertIn("pinyin: renderPinyin", app, "маршрут #/pinyin зарегистрирован")
        self.assertIn("['pinyin', '🔤', 'Азбука']", app, "есть пункт меню «Азбука»")
        self.assertIn("#/pinyin", app, "ссылки на азбуку есть")

    def test_kid_intro_links_to_abc(self):
        app = read("src", "app.js")
        kid = app[app.index("function renderKidIntro"):app.index("function kidVocabCard")]
        self.assertIn("Вся азбука пиньинь", kid,
                      "в детском старте урока должна быть кнопка на азбуку")

    def test_css_styles_abc(self):
        css = read("src", "styles.css")
        for cls in (".pabc-grid", ".pabc-card", ".pabc-k", ".pabc-demo", ".pabc-tricky"):
            self.assertIn(cls, css, f"в styles.css нет {cls}")


class PinyinPageRender(unittest.TestCase):
    """Страница рисуется: все карточки, озвучка, объяснение, пример-кубики."""

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

    def test_title_and_about(self):
        self.assertIn("Азбука пиньинь", self.out["title"])
        self.assertGreaterEqual(self.out["about"], 3,
                                "объяснение «что такое пиньинь» должно быть подробным")

    def test_all_cards_render(self):
        self.assertEqual(self.out["initialCards"], 23, "все 23 начала должны отрисоваться")
        self.assertEqual(self.out["finalCards"], 24, "все 24 конца должны отрисоваться")

    def test_every_card_is_speakable(self):
        self.assertGreaterEqual(self.out["speakButtons"], 47,
                                "у каждой буквы должна быть кнопка озвучки примера")

    def test_demo_syllable_building(self):
        self.assertGreaterEqual(self.out["demo"], 6, "нужен пример сборки слога из кубиков")
        self.assertIn("mā", self.out["demoSyls"], "первый пример: m + a = 妈 mā")

    def test_tricky_rules_shown(self):
        self.assertGreaterEqual(self.out["tricky"], 4, "хитрые правила должны быть на странице")


if __name__ == "__main__":
    unittest.main()
