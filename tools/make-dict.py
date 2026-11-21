#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собирает серверный словарь помощника: data/cedict.txt.gz.

Зачем отдельный шаг: CC-CEDICT — англоязычный, а ученик курса читает
по-русски. Поэтому берём уже готовый срез CC-CEDICT/HSK 3.0 и подставляем
русский перевод из карманного словаря (src/lexicon.js), где он есть.
Английский остаётся вторым значением — он помогает, если русского нет.

Формат строки: иероглифы <TAB> пиньинь-цифрами <TAB> пиньинь <TAB> значение <TAB> язык

Запуск:  python3 tools/make-dict.py [путь к cedict.txt.gz]
Без аргумента пересобирает существующий файл на месте.
"""
import gzip
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEXICON = ROOT / "src" / "lexicon.js"
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "cedict.txt.gz"


def lexicon_ru() -> dict:
    text = LEXICON.read_text(encoding="utf-8")
    body = text[text.index("const LEXICON_ROWS = ") + len("const LEXICON_ROWS = "):].strip().rstrip(";")
    rows = json.loads(body)
    return {r[0]: (r[1], r[2], r[3]) for r in rows if r[3] and re.search("[а-яА-ЯёЁ]", r[3])}


def main():
    ru = lexicon_ru()
    with gzip.open(str(OUT), "rt", encoding="utf-8") as f:
        lines = f.read().split("\n")

    kept, upgraded, seen = [], 0, set()
    for line in lines:
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        hanzi, pnum, pinyin, meaning = parts[0], parts[1], parts[2], parts[3]
        if hanzi in seen:
            continue
        seen.add(hanzi)
        lang = "en"
        # Русский из карманного словаря важнее: он совпадает с курсом.
        if hanzi in ru:
            _, ru_py, meaning = ru[hanzi]
            pinyin = ru_py or pinyin
            lang = "ru"
            upgraded += 1
        kept.append(f"{hanzi}\t{pnum}\t{pinyin}\t{meaning}\t{lang}")

    # Слова, которых нет в срезе, но они есть в курсе, — тоже добавляем.
    extra = 0
    for hanzi, (pnum, pinyin, meaning) in ru.items():
        if hanzi in seen:
            continue
        kept.append(f"{hanzi}\t{pnum}\t{pinyin}\t{meaning}\tru")
        extra += 1

    kept.sort()
    with gzip.open(str(OUT), "wt", encoding="utf-8", compresslevel=9) as f:
        f.write("\n".join(kept) + "\n")
    print(f"OK {OUT} — {len(kept)} слов ({upgraded} с русским, +{extra} из курса), "
          f"{OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
