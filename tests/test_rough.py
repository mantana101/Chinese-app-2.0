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
            self.assertLess(abs(float(value)), 0.6,
                            "наклон больше 0,6° — текст начнёт «плыть»")

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


if __name__ == "__main__":
    unittest.main()
