#!/usr/bin/env python3
"""Собирает src/pinyin.js — чтение каждого иероглифа курса.

Зачем: ученики читают с пиньинем, поэтому пиньинь должен быть виден
везде, а не только в словаре. Брать чтение из встроенной таблицы
надёжнее, чем заставлять браузер угадывать.

Запуск:  python3 tools/make-pinyin.py
Требует: pip install pypinyin
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "src" / "data.js"
OUT = ROOT / "src" / "pinyin.js"

try:
    from pypinyin import pinyin, Style
except ImportError:
    sys.exit("Нужен pypinyin: pip install pypinyin")

# Служебные иероглифы читаются по-разному в зависимости от контекста —
# фиксируем самый частый в курсе вариант.
OVERRIDES = {
    "了": "le", "么": "me", "的": "de", "地": "de", "得": "de", "着": "zhe",
    "还": "hái", "行": "xíng", "长": "cháng", "重": "zhòng", "觉": "jué",
    "会": "huì", "便": "pián", "几": "jǐ", "少": "shǎo", "乐": "lè",
}


def one_syllable(text: str) -> str:
    parts = [p for p in text.split() if p]
    return parts[0] if parts else text


def main() -> None:
    source = DATA.read_text(encoding="utf-8")
    chars = sorted(set(re.findall(r"[\u3400-\u9fff]", source)))

    table = {}
    for ch in chars:
        if ch in OVERRIDES:
            table[ch] = OVERRIDES[ch]
        else:
            table[ch] = one_syllable("".join(pinyin(ch, style=Style.TONE, errors=lambda x: list(x))[0]))

    items = ",".join(
        f'"{ch}":"{reading}"' for ch, reading in sorted(table.items(), key=lambda kv: ord(kv[0]))
    )
    OUT.write_text(
        "/* Чтение иероглифов курса. Сгенерировано tools/make-pinyin.py — не править вручную. */\n"
        f"const PY_CHAR = {{{items}}};\n",
        encoding="utf-8",
    )
    print(f"OK  {OUT}  ({len(table)} иероглифов)")


if __name__ == "__main__":
    main()
