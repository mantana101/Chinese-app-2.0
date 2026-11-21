#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Белая тема — основная.

Раньше сайт открывался тёмным «закатом», и на солнце, на дешёвом экране
телефона или при слабом зрении читать его было тяжело. Теперь страница
светлая по умолчанию, а тёмная остаётся выбором в настройках.

Проверяем именно то, что видит ученик: реально применённый цвет фона,
контраст текста и сохранение выбора после перезагрузки.
"""

import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, "src", "styles.css")
INDEX = os.path.join(ROOT, "index.html")


def css() -> str:
    with open(CSS, encoding="utf-8") as f:
        return f.read()


class BasePalette(unittest.TestCase):
    def test_light_is_the_default_palette(self):
        """Светлые значения должны стоять в :root, а не под атрибутом."""
        src = css()
        root = src[src.index(":root {"):]
        root = root[: root.index("}")]
        self.assertIn("--bg: #f6efe3", root, "фон по умолчанию — тёплая «рисовая бумага»")
        self.assertIn("--txt: #231f2c", root, "текст по умолчанию — тёмный, «чернильный»")
        self.assertIn("--panel: #fdf8ee", root, "карточки не должны быть чисто белыми")

    def test_dark_palette_is_opt_in(self):
        src = css()
        self.assertIn(':root[data-theme="dark"]', src)
        dark = src[src.index(':root[data-theme="dark"] {'):]
        dark = dark[: dark.index("}")]
        self.assertIn("--bg: #171327", dark)
        self.assertIn("--txt: #f7f1fb", dark)

    def test_no_leftover_light_overrides(self):
        """Правил «как в светлой теме» больше не нужно — она и есть базовая."""
        self.assertNotIn('[data-theme="light"]', css())

    def test_text_is_readable_on_background(self):
        """Контраст текста и фона — не меньше 7:1, это уровень AAA."""

        def lum(hex_color):
            hex_color = hex_color.lstrip("#")
            parts = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
            parts = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
                     for c in parts]
            return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]

        bg, txt = "#f6efe3", "#231f2c"
        a, b = lum(bg), lum(txt)
        ratio = (max(a, b) + 0.05) / (min(a, b) + 0.05)
        self.assertGreater(ratio, 7.0, f"контраст {ratio:.1f}:1 слишком низкий")

    def test_page_header_matches_light_theme(self):
        with open(INDEX, encoding="utf-8") as f:
            html = f.read()
        self.assertIn('content="#f6efe3"', html, "адресная строка телефона должна быть светлой")


class NoHarshWhite(unittest.TestCase):
    """Чистый белый на большой площади бьёт по глазам — его в палитре нет."""

    def test_panels_are_cream_not_white(self):
        src = css()
        root = src[src.index(":root {"):]
        root = root[: root.index("}")]
        for name in ("--bg", "--bg2", "--panel", "--panel2"):
            line = [l for l in root.splitlines() if l.strip().startswith(name + ":")][0]
            value = line.split(":")[1].strip().rstrip(";").lower()
            self.assertNotIn(value, ("#fff", "#ffffff"), f"{name} не должен быть чисто белым")

    def test_background_has_colour(self):
        """Фон должен быть не «просто песочным», а с цветными пятнами."""
        src = css()
        body = src[src.index("\nbody {"):]
        body = body[: body.index("}")]
        self.assertGreaterEqual(body.count("radial-gradient"), 3,
                                "фону нужны цветные пятна, иначе он выглядит плоским")


class InBrowser(unittest.TestCase):
    """Тема переключается и запоминается — проверяем настоящим DOM."""

    SCRIPT = r"""
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
  const root = w.document.documentElement;
  const bg = () => w.getComputedStyle(root).getPropertyValue('--bg').trim();
  const out = { defaultBg: bg(), defaultAttr: root.getAttribute('data-theme') };
  w.eval("PREFS.theme = 'dark'");
  out.darkBg = bg();
  out.darkAttr = root.getAttribute('data-theme');
  w.eval("PREFS.theme = 'light'");
  out.backBg = bg();
  out.backAttr = root.getAttribute('data-theme');
  out.saved = w.eval("Store.get('zh_theme')");
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 900);
"""

    def test_theme_switch(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("нет node — нечего проверять в браузере")
        jsdom = os.path.join(ROOT, "node_modules")
        if not os.path.isdir(os.path.join(jsdom, "jsdom")):
            self.skipTest("нет jsdom — браузерные проверки пропущены")
        res = subprocess.run([node, "-e", self.SCRIPT, INDEX, jsdom],
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr[-500:])
        out = __import__("json").loads(res.stdout)
        self.assertEqual(out["defaultBg"], "#f6efe3")
        self.assertIsNone(out["defaultAttr"], "по умолчанию атрибута темы быть не должно")
        self.assertEqual(out["darkBg"], "#171327")
        self.assertEqual(out["darkAttr"], "dark")
        self.assertEqual(out["backBg"], "#f6efe3")
        self.assertIsNone(out["backAttr"], "светлая тема не должна вешать пустой атрибут")
        self.assertEqual(out["saved"], "light")


if __name__ == "__main__":
    unittest.main()
