#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""«Ручные» детали: каракули, карандашные линии, лёгкая неидеальность.

Сайты от нейросетей выходят слишком гладкими: всё выровнено по пикселю,
линии математически ровные, интерфейс похож на витрину. Живые детали —
нарисованные от руки пометки, штрихи «карандашом», едва заметные
неровности — возвращают ощущение, что страницу делал человек.

Здесь проверяется, что неровности есть и что они не мешают:
фильтры объявлены, пометки подписаны для скринридера, линии не статичны.
"""

import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


class RoughFilters(unittest.TestCase):
    """Неровности делаются SVG-фильтром с шумом, а не «на глазок»."""

    def test_filter_defs_exist(self):
        tpl = read("src", "index.template.html")
        self.assertIn('id="rough-line"', tpl)
        self.assertIn('id="rough-ink"', tpl)
        self.assertIn("feTurbulence", tpl, "шум — источник неровности линии")
        self.assertIn("feDisplacementMap", tpl, "шум должен смещать линию, а не красить её")

    def test_defs_are_hidden_from_screen_readers(self):
        tpl = read("src", "index.template.html")
        start = tpl.index('<svg class="rough-defs"')
        tag = tpl[start:tpl.index(">", start)]
        self.assertIn('aria-hidden="true"', tag)
        self.assertIn('width="0"', tag, "контейнер фильтров не должен занимать место")

    def test_lines_really_wobble(self):
        """scale=0 у фильтра означал бы идеально ровную линию."""
        tpl = read("src", "index.template.html")
        for fid in ("rough-line", "rough-ink"):
            start = tpl.index(f'id="{fid}"')
            block = tpl[start:tpl.index("</filter>", start)]
            scale = float(re.search(r'scale="([\d.]+)"', block).group(1))
            self.assertGreater(scale, 1.0, f"{fid} даёт слишком ровную линию")


class Scrawls(unittest.TestCase):
    def test_hand_drawn_variants(self):
        app = read("src", "app.js")
        for kind in ("spark", "arrow", "check", "bang", "wave", "curl"):
            self.assertIn(f"{kind}:", app, f"нет каракули «{kind}»")
        self.assertIn("SCRAWL_CN", app, "нужны и китайские надписи «кистью»")

    def test_scrawl_is_labelled_and_decorative(self):
        app = read("src", "app.js")
        start = app.index("function scrawl(")
        block = app[start:start + 1600]
        self.assertIn('aria-label="${esc(label)}"', block,
                      "каракуля — картинка, её нужно подписать словами")
        self.assertIn('aria-hidden="true"', block, "а сам рисунок — декоративный")

    def test_scrawls_are_used_in_ui(self):
        app = read("src", "app.js")
        self.assertGreaterEqual(app.count("scrawl("), 4,
                                "каракули должны стоять в интерфейсе, а не только в коде")
        self.assertIn("start-hint", app, "стрелка должна указывать на первый шаг")
        self.assertIn("hero-hand", app, "надпись от руки на первом экране")

    def test_each_scrawl_tilts_differently(self):
        """Одинаковый наклон у всех выдаёт штамп."""
        app = read("src", "app.js")
        start = app.index("function scrawl(")
        block = app[start:start + 1200]
        self.assertIn("scrawlSeq % 2", block, "наклон должен чередоваться")


class Imperfection(unittest.TestCase):
    def test_panels_are_slightly_tilted(self):
        css = read("src", "styles.css")
        self.assertIn("--tilt", css)
        tilts = re.findall(r"--tilt:\s*(-?[\d.]+)deg", css)
        self.assertGreaterEqual(len(tilts), 2)
        for value in tilts:
            self.assertGreaterEqual(abs(float(value)), 0.3,
                                    "наклон меньше 0,3° — его просто не видно")
            self.assertLess(abs(float(value)), 1.2,
                            "наклон больше 1,2° — текст начнёт «плыть»")

    def test_pencil_underline_on_titles(self):
        css = read("src", "styles.css")
        start = css.index(".page-title::after")
        block = css[start:css.index("}", start)]
        self.assertIn("url(#rough-line)", block, "подчёркивание должно дрожать")
        self.assertIn("clip-path", block, "и иметь рваный край, как от карандаша")

    def test_author_signature_is_handwritten(self):
        """Росчерк под именем автора — тоже «от руки»."""
        css = read("src", "styles.css")
        self.assertIn(".site-foot b::after", css)
        self.assertIn("border-radius: 50%", css)

    def test_decorations_do_not_block_clicks(self):
        css = read("src", "styles.css")
        self.assertIn(".scrawl { pointer-events: none; }", css)

    def test_respects_reduced_motion(self):
        css = read("src", "styles.css")
        self.assertIn("prefers-reduced-motion", css)

    def test_built_page_contains_scrawls(self):
        html = read("index.html")
        self.assertIn("rough-ink", html)
        self.assertIn('class="scrawl', html)

class VisibleAtFirstGlance(unittest.TestCase):
    """Детали должны быть заметны, а не «существовать в коде».

    Прошлый заход был слишком деликатным: наклон в 0,18° и штрихи
    толщиной в пиксель не читались. Теперь у каждой детали есть
    проверяемый признак заметности.
    """

    def test_hand_written_note_on_home(self):
        app = read("src", "app.js")
        self.assertIn("hand-note", app, "на главной нужна записка «от руки»")

    def test_note_looks_like_tape_and_paper(self):
        css = read("src", "styles.css")
        start = css.index(".hand-note {")
        block = css[start:css.index("}", start)]
        self.assertIn("rotate(-1.6deg)", block, "записка должна быть под углом")
        self.assertIn("cursive", block, "и рукописным шрифтом")
        self.assertIn(".hand-note::before", css, "скотч сверху")

    def test_card_corners_are_uneven(self):
        """Разные радиусы у одного элемента — след «ножниц», а не шаблона."""
        css = read("src", "styles.css")
        start = css.index(".tile { border-radius:")
        block = css[start:css.index("}", start)]
        radii = re.findall(r"(\d+)px", block)
        self.assertGreaterEqual(len(radii), 4)
        self.assertGreater(len(set(radii)), 1, "все углы одинаковы — снова «ровно»")

    def test_panel_has_folded_corner(self):
        css = read("src", "styles.css")
        self.assertIn(".panel::after", css, "загнутый угол — как у листа, который листали")

    def test_pencil_dashes_in_service_blocks(self):
        css = read("src", "styles.css")
        start = css.index(".empty, .hw-note, .qd-unlock {")
        block = css[start:css.index("}", start)]
        self.assertIn("dashed", block, "служебные блоки отделены пунктиром «карандашом»")


class InBrowser(unittest.TestCase):
    """Проверяем не исходники, а то, что реально попадает в DOM."""

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
  w.__guest = true; w.location.hash = '#/home'; w.route();
  const v = w.document.querySelector('#view');
  const note = v.querySelector('.hand-note');
  const star = v.querySelector('.hero .scrawl');
  const hand = v.querySelector('.hero-hand');
  const tile = v.querySelector('.tile');
  const out = {
    note: note ? note.textContent.trim().slice(0, 40) : '',
    noteTransform: note ? w.getComputedStyle(note).transform : '',
    starWidth: star ? w.getComputedStyle(star).width : '',
    starPaths: star ? star.querySelectorAll('path').length : 0,
    hand: hand ? hand.textContent.trim() : '',
    tileRadius: tile ? w.getComputedStyle(tile).borderRadius : '',
    filters: !!w.document.querySelector('#rough-ink'),
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 900);
"""

    def test_home_actually_renders_details(self):
        import json
        import shutil
        import subprocess
        node = shutil.which("node")
        if not node:
            self.skipTest("нет node")
        jsdom = os.path.join(ROOT, "node_modules")
        if not os.path.isdir(os.path.join(jsdom, "jsdom")):
            self.skipTest("нет jsdom")
        res = subprocess.run([node, "-e", self.SCRIPT, os.path.join(ROOT, "index.html"), jsdom],
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr[-400:])
        out = json.loads(res.stdout)
        self.assertTrue(out["filters"], "фильтры не попали в страницу")
        self.assertTrue(out["note"], "записки на скотче нет на главной")
        self.assertIn("rotate", out["noteTransform"])
        self.assertEqual(out["starWidth"], "44px", "звёздочка должна быть заметного размера")
        self.assertGreaterEqual(out["starPaths"], 3, "звёздочка пустая")
        self.assertTrue(out["hand"], "рукописной надписи нет")
        self.assertGreater(len(set(re.findall(r"\d+", out["tileRadius"]))), 1,
                           "у плитки снова одинаковые углы")


if __name__ == "__main__":
    unittest.main()
