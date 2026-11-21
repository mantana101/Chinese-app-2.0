#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собирает иероглифический шрифт для сайта из пакета @fontsource/noto-sans-sc.

Зачем: на части устройств (дешёвые Android, «пустая» Windows, Linux без
CJK-шрифтов) иероглифы рисуются квадратиками — курс становится нечитаемым.
Свой шрифт решает это, но полный Noto Sans SC весит десятки мегабайт.

Поэтому берём из него только 29 кусков (по unicode-range), где встречаются
символы, реально используемые в курсе. В браузере эти файлы скачиваются
ТОЛЬКО если системного китайского шрифта нет: в font-family он стоит
последним, а браузер до запасного шрифта не доходит.

Запуск (нужна сеть к npm):
    npm pack @fontsource/noto-sans-sc --pack-destination /tmp
    tar xzf /tmp/fontsource-noto-sans-sc-*.tgz -C /tmp
    python3 tools/make-fonts.py /tmp/package

Лицензия шрифта — SIL Open Font License 1.1.
"""

import json
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT_FONTS = SRC / "fonts"
CSS_OUT = SRC / "fonts.css"


def course_chars() -> set:
    """Все знаки, которые курс вообще может показать."""
    text = ""
    for pattern in ("*.js", "*.html", "*.css"):
        for f in SRC.glob(pattern):
            if f.name == "fonts.css":
                continue
            text += f.read_text(encoding="utf-8", errors="ignore")
    # Латиница и кириллица есть в системных шрифтах всегда — их не берём.
    return {c for c in text if ord(c) > 0x2000}


def parse_ranges(spec: str):
    out = []
    for part in spec.split(","):
        part = part.strip().replace("U+", "")
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            out.append((int(a, 16), int(b, 16)))
        else:
            out.append((int(part, 16), int(part, 16)))
    return out


def main(pkg: str) -> None:
    pkg_dir = pathlib.Path(pkg)
    css_path = pkg_dir / "400.css"
    files_dir = pkg_dir / "files"
    if not css_path.exists():
        sys.exit(f"Нет {css_path}. См. инструкцию в начале файла.")

    need = course_chars()
    print(f"Символов в курсе (без латиницы/кириллицы): {len(need)}")

    OUT_FONTS.mkdir(exist_ok=True)
    css = css_path.read_text(encoding="utf-8")
    faces = re.findall(r"@font-face\s*\{(.*?)\}", css, re.S)

    rules, used = [], 0
    for face in faces:
        m = re.search(r"url\(\./files/([^)]+\.woff2)\)", face)
        ur = re.search(r"unicode-range:\s*([^;]+);", face)
        if not m or not ur:
            continue
        ranges = parse_ranges(ur.group(1))
        if not any(any(a <= ord(c) <= b for a, b in ranges) for c in need):
            continue
        name = m.group(1)
        shutil.copyfile(files_dir / name, OUT_FONTS / name)
        used += pathlib.Path(files_dir / name).stat().st_size
        rules.append(
            "@font-face {\n"
            "  font-family: 'Noto Sans SC';\n"
            "  font-style: normal;\n"
            "  font-weight: 400;\n"
            "  font-display: swap;\n"
            f"  src: url('./fonts/{name}') format('woff2');\n"
            f"  unicode-range: {ur.group(1)};\n"
            "}"
        )

    header = (
        "/* Иероглифический шрифт для устройств, где своего нет.\n"
        "   На телефонах и в Windows китайский шрифт обычно уже есть, и тогда\n"
        "   ни один файл отсюда не скачивается: браузер берёт более ранний шрифт\n"
        "   из списка. А на «пустой» системе вместо квадратиков подгружается\n"
        "   Noto Sans SC — только те куски, где есть нужные иероглифы.\n\n"
        f"   Кусков: {len(rules)}, вес: {used / 1024:.0f} КБ.\n"
        "   Набор символов собран из самого курса.\n"
        "   Лицензия SIL OFL 1.1. */\n"
    )
    CSS_OUT.write_text(header + "\n".join(rules) + "\n", encoding="utf-8")
    print(f"OK  {CSS_OUT.name}: {len(rules)} кусков, {used / 1024:.0f} КБ")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/package")
