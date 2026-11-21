#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Голосовой учитель-панда в каждом уроке.

Мэймэй — панда-учитель: в каждом уроке есть панель с её объяснением
материала. Кнопка «Объяснить урок» (или клик по панде) читает текст
русским голосом (ru-RU, отдельная дорожка — speak() всегда говорит
по-китайски). Во время речи у панды анимируется рот.

Ученики читают только с пиньинем, поэтому объяснение показывается
текстом рядом с аватаром: ребёнок слушает и следит глазами.
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
const { LESSONS } =
  new Function(fs.readFileSync(process.argv[1], 'utf8') + '\nreturn { LESSONS };')();
process.stdout.write(JSON.stringify(Object.entries(LESSONS).map(([id, l]) => ({
  id, title: l.title, teacher: l.teacher || ''
}))));
"""

DOM_SCRIPT = r"""
const fs = require('fs');
const {JSDOM} = require(process.argv[2] + '/jsdom/lib/api.js');
const spoken = [];
const dom = new JSDOM(fs.readFileSync(process.argv[1], 'utf8'), {
  runScripts: 'dangerously', url: 'http://127.0.0.1/', pretendToBeVisual: true,
  beforeParse(w) {
    w.matchMedia = () => ({matches: false, addEventListener(){}, removeEventListener(){}});
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    w.speechSynthesis = {
      speak(u){ spoken.push({lang: u.lang, text: u.text}); },
      cancel(){}, getVoices: () => []
    };
    // В настоящем браузере этот класс есть; jsdom его не знает.
    w.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text; this.lang = ''; this.onend = null; this.onerror = null; }
    };
    w.scrollTo = () => {};
    w.fetch = () => Promise.reject(new Error('offline'));
  }
});
const w = dom.window;
setTimeout(() => {
  w.eval("window.__r = document.createElement('div'); window.__r.id='r'; document.body.appendChild(window.__r); renderLesson(window.__r, ['l1'])");
  const r = w.document.getElementById('r');
  const pan = r.querySelector('.panda-teacher');
  const out = { spoken };
  out.teacherPanel = !!pan;
  out.pandaSvg = !!r.querySelector('.pa-svg');
  out.mouthOpen = !!r.querySelector('.pa-mouth-open');
  out.mouthClosed = !!r.querySelector('.pa-mouth-closed');
  out.eyes = r.querySelectorAll('.pa-eye').length;
  out.aria = pan ? (pan.querySelector('.pa-wrap').getAttribute('aria-label') || '') : '';
  out.sayBtn = pan ? !!pan.querySelector('.pa-say') : false;
  out.slowBtn = pan ? !!pan.querySelector('.pa-slow') : false;
  out.name = pan ? (pan.querySelector('.pa-name').textContent.includes('Мэймэй')) : false;
  out.shown = pan ? pan.querySelector('.pa-text').textContent.length : 0;
  if (pan) {
    pan.querySelector('.pa-say').click();
  }
  out.spokenLang = spoken.length ? spoken[0].lang : '';
  out.spokenIsTeacher = spoken.length ? spoken[0].text === w.eval("LESSONS.l1.teacher") : false;
  out.talking = pan ? pan.classList.contains('talking') : false;
  // Клик по самой панде тоже запускает объяснение.
  pan.querySelector('.pa-wrap').click();
  out.spokenAfterAvatarClick = spoken.length;
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 900);
"""


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def load_teachers():
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("нет node — нечем разобрать data.js")
    res = subprocess.run([node, "-e", READ_SCRIPT, DATA],
                         capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        raise AssertionError("data.js не разбирается: " + res.stderr[-500:])
    return json.loads(res.stdout)


class TeacherScripts(unittest.TestCase):
    """У каждого урока есть живое объяснение от Мэймэй."""

    @classmethod
    def setUpClass(cls):
        cls.lessons = load_teachers()

    def test_every_lesson_has_teacher(self):
        self.assertEqual(len(self.lessons), 15, "в курсе 15 уроков")
        for l in self.lessons:
            self.assertGreaterEqual(len(l["teacher"]), 120,
                                    f"{l['id']}: объяснение слишком короткое")

    def test_scripts_talk_to_the_child(self):
        """Объяснения — на «ты», с примерами слов урока."""
        for l in self.lessons:
            t = l["teacher"]
            self.assertRegex(t.lower(),
                             r"(ты|теб|тво|слушай|посчитай|нарисуй|подумай|расскажи"
                             r"|тренируйся|попробуй|скажи|опиши|представь|спроси|болей|нажми|закажи)",
                             f"{l['id']}: обращение к ребёнку («ты» или просьба-императив)")
            self.assertRegex(t, r"[一-鿿]", f"{l['id']}: в объяснении есть китайские слова урока")
            self.assertIn("!", t, f"{l['id']}: объяснение живое, не сухая справка")

    def test_first_lesson_explains_tones_and_pinyin(self):
        t1 = next(l for l in self.lessons if l["id"] == "l1")["teacher"]
        self.assertIn("тон", t1.lower(), "в l1 Мэймэй объясняет тоны")
        self.assertIn("пиньин", t1.lower(), "в l1 Мэймэй объясняет пиньинь")
        self.assertIn("ни-хао", t1, "и показывает русское чтение")


class TeacherWiring(unittest.TestCase):
    """Рендер, озвучка и анимация рта подключены."""

    def test_app_has_teacher_helpers(self):
        app = read("src", "app.js")
        for name in ("speakRu", "pandaSVG", "renderTeacher", "ru-RU",
                     "panda-teacher", "talking", "pa-mouth-open"):
            self.assertIn(name, app, f"в app.js нет {name}")

    def test_russian_voice_is_separate_from_chinese(self):
        app = read("src", "app.js")
        self.assertIn("u.lang = 'ru-RU'", app,
                      "объяснение учителя должно идти русским голосом")
        self.assertIn("u.lang = 'zh-CN'", app,
                      "китайские слова озвучиваются отдельной дорожкой")

    def test_speech_stops_on_navigation(self):
        app = read("src", "app.js")
        self.assertIn("speechSynthesis.cancel()", app.split("hashchange")[1],
                      "уходя со страницы, Мэймэй должна замолчать")

    def test_css_animates_mouth_and_respects_reduced_motion(self):
        css = read("src", "styles.css")
        for cls in (".panda-teacher", ".pa-svg", ".pa-mouth-open", "@keyframes paTalk"):
            self.assertIn(cls, css, f"в styles.css нет {cls}")
        self.assertIn("@keyframes paBlink", css, "панда должна моргать в покое")
        self.assertIn("prefers-reduced-motion", css,
                      "анимации отключаются для тех, кому движение мешает")

    def test_lesson_places_teacher_panel(self):
        app = read("src", "app.js")
        m = app[app.index("function renderLesson"):]
        head = m.index("lesson-head")
        teacher = m.index("renderTeacher(l)")
        goals = m.index("Цели урока")
        self.assertTrue(head < teacher < goals,
                        "учитель должен стоять после заголовка и до целей")


class TeacherInBrowser(unittest.TestCase):
    """Панда рисуется и говорит по-русски — проверяем настоящий DOM."""

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

    def test_panel_renders_with_panda(self):
        self.assertTrue(self.out["teacherPanel"], "панели учителя нет в уроке")
        self.assertTrue(self.out["pandaSvg"], "SVG-панды нет")
        self.assertTrue(self.out["mouthOpen"] and self.out["mouthClosed"],
                        "нужны оба состояния рта: закрытый и открытый")
        self.assertEqual(self.out["eyes"], 2, "у панды два глаза")

    def test_avatar_is_labelled(self):
        self.assertIn("Мэймэй", self.out["aria"], "аватар подписан для скринридера")
        self.assertTrue(self.out["name"], "имя учителя показано в панели")

    def test_buttons_and_text(self):
        self.assertTrue(self.out["sayBtn"], "нет кнопки «Объяснить урок»")
        self.assertTrue(self.out["slowBtn"], "нет медленного объяснения")
        self.assertGreater(self.out["shown"], 120,
                           "текст объяснения должен быть показан ребёнку целиком")

    def test_click_speaks_russian_teacher_text(self):
        self.assertEqual(self.out["spokenLang"], "ru-RU",
                         "объяснение должно озвучиваться русским голосом")
        self.assertTrue(self.out["spokenIsTeacher"],
                        "озвучивается именно текст урока, а не что-то другое")
        self.assertTrue(self.out["talking"], "во время речи панда получает .talking")
        self.assertEqual(self.out["spokenAfterAvatarClick"], 2,
                         "клик по самой панде тоже запускает объяснение")


if __name__ == "__main__":
    unittest.main()
