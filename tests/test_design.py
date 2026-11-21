#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Оформление: страница должна выглядеть как книга, а не как панель.

Красота — вопрос вкуса, но у неё есть проверяемые признаки: заголовки
антиквой, фон с текстурой, карточки с воздухом и единая палитра
«тушь — киноварь — золото». Эти тесты ловят откат к плоскому виду.
"""

import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, "src", "styles.css")


def css() -> str:
    with open(CSS, encoding="utf-8") as f:
        return f.read()


class Typography(unittest.TestCase):
    def test_titles_use_serif(self):
        """Антиква отделяет заголовок от интерфейсного текста."""
        src = css()
        start = src.index("\n.page-title {")
        rule = src[start:src.index("}", start)]
        self.assertIn('"Noto Serif SC"', rule)
        self.assertIn("serif", rule)

    def test_hero_title_is_serif(self):
        src = css()
        start = src.index("\n.hero h1 {")
        rule = src[start:src.index("}", start)]
        self.assertIn("serif", rule)


class PaperBackground(unittest.TestCase):
    def test_background_has_texture(self):
        """Текстура бумаги: тонкие повторяющиеся линии поверх градиента."""
        src = css()
        body = src[src.index("\nbody {"):]
        body = body[: body.index("}")]
        self.assertIn("repeating-linear-gradient", body,
                      "фону нужна текстура, иначе он выглядит плоским")

    def test_panel_has_gold_frame(self):
        """Внутренняя золотая кромка делает панель похожей на лист."""
        src = css()
        start = src.index("\n.panel::before")
        rule = src[start:src.index("}", start)]
        self.assertIn("border", rule)
        self.assertIn("rgba(154,112,22", rule)

    def test_dark_theme_keeps_its_own_background(self):
        src = css()
        self.assertIn(':root[data-theme="dark"] body', src)


class Palette(unittest.TestCase):
    def test_ink_and_cinnabar(self):
        """Чернильный текст и киноварь вместо «просто красного»."""
        src = css()
        root = src[src.index(":root {"):]
        root = root[: root.index("}")]
        self.assertIn("--txt: #231f2c", root)
        self.assertIn("--red: #b23a2e", root)
        self.assertIn("--gold: #8a6412", root)

    def test_primary_button_is_seal_red(self):
        src = css()
        start = src.index("\n.btn-primary {")
        rule = src[start:src.index("}", start)]
        self.assertIn("var(--red)", rule)

    def test_panels_are_white(self):
        """Главный экран белый и однотонным — решение пользователя."""
        src = css()
        root = src[src.index(":root {"):]
        root = root[: root.index("}")]
        self.assertIn("--panel: #ffffff;", root)
        self.assertIn("--bg: #ffffff;", root)


class Markup(unittest.TestCase):
    def test_hero_has_seal_and_watermark(self):
        with open(os.path.join(ROOT, "src", "app.js"), encoding="utf-8") as f:
            app = f.read()
        self.assertIn('class="hero-seal"', app)
        self.assertIn('class="hero-bg"', app)

    def test_page_builds_with_new_theme_color(self):
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertIn('content="#ffffff"', html)
        self.assertIn("repeating-linear-gradient", html)


if __name__ == "__main__":
    unittest.main()
