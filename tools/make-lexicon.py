#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собирает src/lexicon.js — карманный словарь для ИИ-помощника.

Помощник должен понимать слова, которых нет в 15 уроках курса, но которые
ученик встречает в жизни и в учебниках HSK. Раньше на «а как будет аптека?»
он отвечал «нет в курсе» — теперь знает слово, уровень HSK и перевод.

Плюс вручную выверенный бытовой набор LIFE_WORDS: 账单, 药店, 火车, 身份证 —
слова, без которых не прожить день, но которых нет в HSK 1–4.

Источники (оба с русским переводом):
  1. LiudmilaLV/json_hsk — 5000 слов HSK 1–6 (hsk.json). Русский перевод
     собран сообществом chineseplus.club.
  2. drkameleon/complete-hsk-vocabulary — HSK 2.0/3.0 + CC-CEDICT (MIT).
     Нужен для слов, которых нет в первом списке, и для новой линейки HSK 3.0.

Формат строки в src/lexicon.js:
  [иероглифы, пиньинь цифрами, пиньинь с тонами, перевод, уровень HSK,
   частота, есть_в_курсе]

Запуск:  python3 tools/make-lexicon.py <hsk.json> <complete.min.json>
Без аргументов файлы скачиваются с GitHub (нужен интернет).
"""

import json
import pathlib
import re
import sys
import urllib.request

RAW_RU = "https://raw.githubusercontent.com/LiudmilaLV/json_hsk/master/hsk.json"
RAW_HSK = ("https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/"
           "master/complete.min.json")

BASE = pathlib.Path(__file__).resolve().parent.parent
OUT = BASE / "src" / "lexicon.js"
DATA = BASE / "src" / "data.js"

# HSK 2.0 (n1–n6) как есть; HSK 3.0 (t1–t7) сжимаем в 1–6: для курса
# важнее «насколько слово раннее», чем точная линейка.
LEVEL = {
    **{f"n{i}": i for i in range(1, 7)},
    **{f"o{i}": i for i in range(1, 7)},
    **{f"t{i}": 1 + (i - 1) * 6 // 7 for i in range(1, 8)},
    **{f"n{i}": i for i in (7,)},
}
MAX_LEVEL = 4      # HSK 1–4 целиком
MAX_FREQ = 3000    # плюс самые частые слова вне HSK

# Слова, без которых ученик не проживёт день в Китае, но которых нет
# в HSK 1–4 (账单, 药店, 火车…). Переводы выверены вручную по CC-CEDICT
# и учебным спискам HSK 5; уровень — HSK, где слово официально появляется.
LIFE_WORDS = [
    # ресторан и счёт
    ("餐厅", "can1 ting1", "cān tīng", "ресторан, столовая", 5),
    ("饭店", "fan4 dian4", "fàn diàn", "ресторан; гостиница", 2),
    ("菜单", "cai4 dan1", "cài dān", "меню", 3),
    ("点菜", "dian3 cai4", "diǎn cài", "заказывать блюда", 5),
    ("账单", "zhang4 dan1", "zhàng dān", "счёт (в ресторане)", 5),
    ("买单", "mai3 dan1", "mǎi dān", "оплатить счёт", 5),
    ("结账", "jie2 zhang4", "jié zhàng", "рассчитаться, оплатить счёт", 5),
    ("服务员", "fu2 wu4 yuan2", "fú wù yuán", "официант", 2),
    ("打包", "da3 bao1", "dǎ bāo", "упаковать с собой", 5),
    ("小费", "xiao3 fei4", "xiǎo fèi", "чаевые", 6),
    # магазин и деньги
    ("超市", "chao1 shi4", "chāo shì", "супермаркет", 5),
    ("药店", "yao4 dian4", "yào diàn", "аптека", 5),
    ("收银台", "shou1 yin2 tai2", "shōu yín tái", "касса", 6),
    ("现金", "xian4 jin1", "xiàn jīn", "наличные", 4),
    ("零钱", "ling2 qian2", "líng qián", "мелочь", 5),
    ("打折", "da3 zhe2", "dǎ zhé", "делать скидку", 5),
    ("退货", "tui4 huo4", "tuì huò", "вернуть товар", 6),
    ("收据", "shou1 ju4", "shōu jù", "квитанция, чек", 6),
    # дорога
    ("火车", "huo3 che1", "huǒ chē", "поезд", 3),
    ("高铁", "gao1 tie3", "gāo tiě", "скоростной поезд", 6),
    ("地铁", "di4 tie3", "dì tiě", "метро", 3),
    ("公交车", "gong1 jiao1 che1", "gōng jiāo chē", "автобус", 3),
    ("出租车", "chu1 zu1 che1", "chū zū chē", "такси", 3),
    ("车票", "che1 piao4", "chē piào", "билет на транспорт", 3),
    ("航班", "hang2 ban1", "háng bān", "рейс (самолёта)", 5),
    ("机场", "ji1 chang3", "jī chǎng", "аэропорт", 3),
    ("护照", "hu4 zhao4", "hù zhào", "паспорт", 3),
    ("身份证", "shen1 fen4 zheng4", "shēn fèn zhèng", "удостоверение личности", 5),
    ("签证", "qian1 zheng4", "qiān zhèng", "виза", 5),
    # жильё и быт
    ("宾馆", "bin1 guan3", "bīn guǎn", "гостиница", 3),
    ("酒店", "jiu3 dian4", "jiǔ diàn", "отель", 3),
    ("钥匙", "yao4 shi", "yào shi", "ключ", 4),
    ("空调", "kong1 tiao2", "kōng tiáo", "кондиционер", 4),
    ("热水", "re4 shui3", "rè shuǐ", "горячая вода", 3),
    ("停电", "ting2 dian4", "tíng diàn", "отключение электричества", 6),
    # помощь
    ("警察", "jing3 cha2", "jǐng chá", "полиция, полицейский", 3),
    ("迷路", "mi2 lu4", "mí lù", "заблудиться", 5),
    ("丢", "diu1", "diū", "потерять", 4),
    ("帮忙", "bang1 mang2", "bāng máng", "помогать", 3),
    ("救护车", "jiu4 hu4 che1", "jiù hù chē", "скорая помощь", 6),
    ("病", "bing4", "bìng", "болезнь", 3),
    ("发烧", "fa1 shao1", "fā shāo", "температура (у больного)", 4),
    ("感冒", "gan3 mao4", "gǎn mào", "простуда", 4),
    ("药", "yao4", "yào", "лекарство", 3),
    ("挂号", "gua4 hao4", "guà hào", "записаться к врачу", 5),
]


def download(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Chinese-app build"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read().decode("utf-8")


def course_words() -> set:
    text = DATA.read_text(encoding="utf-8")
    return set(re.findall(r"\{ h: '([\u3400-\u9fff]+)'", text))


def clean_ru(text: str) -> str:
    """Убираем пояснения в скобках: «чай (счётное слово…)» → «чай».

    Скобки могут быть вложенными и незакрытыми (в исходнике встречается
    «счётное слово 所 suǒ, 家 jiā» без закрывающей) — поэтому режем по
    первой открывающей до конца строки, если пары нет.
    """
    text = " ".join(str(text).split())
    out, depth = [], 0
    for ch in text:
        if ch == "(":
            depth += 1
            continue
        if ch == ")":
            depth = max(0, depth - 1)
            out.append(" ")
            continue
        if depth == 0:
            out.append(ch)
    text = " ".join("".join(out).split())
    text = text.split(";")[0].split(",")[0].strip(" .")
    return text


def numeric_from_marks(pinyin: str) -> str:
    """chá → cha2. Нужно для поиска по пиньиню без тонов."""
    tones = {
        "ā": ("a", 1), "á": ("a", 2), "ǎ": ("a", 3), "à": ("a", 4),
        "ē": ("e", 1), "é": ("e", 2), "ě": ("e", 3), "è": ("e", 4),
        "ī": ("i", 1), "í": ("i", 2), "ǐ": ("i", 3), "ì": ("i", 4),
        "ō": ("o", 1), "ó": ("o", 2), "ǒ": ("o", 3), "ò": ("o", 4),
        "ū": ("u", 1), "ú": ("u", 2), "ǔ": ("u", 3), "ù": ("u", 4),
        "ǖ": ("v", 1), "ǘ": ("v", 2), "ǚ": ("v", 3), "ǜ": ("v", 4), "ü": ("v", 0),
    }
    out = []
    for syllable in str(pinyin or "").split():
        buf, tone = "", 5
        for ch in syllable:
            if ch in tones:
                base, t = tones[ch]
                buf += base
                if t:
                    tone = t
            else:
                buf += ch
        out.append(f"{buf}{tone if tone != 5 else ''}")
    return " ".join(out)


def main():
    if len(sys.argv) > 2:
        ru_raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
        hsk_raw = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
    else:
        print("скачиваю списки HSK…")
        ru_raw, hsk_raw = download(RAW_RU), download(RAW_HSK)

    ru_list = json.loads(ru_raw)
    hsk_list = json.loads(hsk_raw)
    in_course = course_words()

    rows = {}
    # 1) русский список HSK 1–6 — основа: у него есть перевод на русский
    for e in ru_list:
        hanzi = (e.get("hanzi") or "").strip()
        if not hanzi:
            continue
        rus = [x for x in ((e.get("translations") or {}).get("rus") or []) if x]
        eng = [x for x in ((e.get("translations") or {}).get("eng") or []) if x]
        meaning = clean_ru(rus[0]) if rus else clean_ru(eng[0] if eng else "")
        if not meaning:
            continue
        pinyin = (e.get("pinyin") or "").strip()
        level = int(e.get("level") or 6)
        # HSK 5–6 в карманный словарь не берём: для курса это далёкий горизонт,
        # а каждая тысяча слов — это вес страницы.
        if hanzi not in in_course and level > MAX_LEVEL:
            continue
        rows[hanzi] = [hanzi, numeric_from_marks(pinyin), pinyin, meaning, level, 5000 + int(e.get("id") or 0), 0]

    # 2) HSK 2.0/3.0 + CC-CEDICT — только слова курса: у остальных перевод
    #    английский, а ученику он не помогает. Честнее сказать «нет в курсе»,
    #    чем показать «apartment» вместо «квартира».
    for e in hsk_list:
        hanzi = (e.get("s") or "").strip()
        if not hanzi or hanzi in rows:
            continue
        forms = e.get("f") or []
        tr = (forms[0].get("i") if forms else {}) or {}
        meanings = (forms[0].get("m") if forms else []) or []
        if not meanings:
            continue
        if hanzi not in in_course:
            continue
        level = min([LEVEL.get(lv, 7) for lv in e.get("l") or ["n7"]] or [7])
        freq = e.get("q") or 99999
        rows[hanzi] = [hanzi, tr.get("n") or "", tr.get("y") or "",
                       clean_ru(meanings[0]), level, freq, 0]

    # 3) бытовой набор: он важнее «далёких» HSK 5–6 и добавляется всегда
    for hanzi, pnum, py, ru, level in LIFE_WORDS:
        rows[hanzi] = [hanzi, pnum, py, ru, level, 10, 0]

    for hanzi in list(rows):
        rows[hanzi][6] = 1 if hanzi in in_course else 0

    ordered = sorted(rows.values(), key=lambda r: (-r[6], r[4], r[5], r[0]))
    payload = json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))
    header = (
        "/* Карманный словарь помощника: HSK 1–6 с русским переводом\n"
        "   (LiudmilaLV/json_hsk) + HSK 2.0/3.0 и CC-CEDICT\n"
        "   (drkameleon/complete-hsk-vocabulary, MIT).\n"
        "   Файл генерируется: python3 tools/make-lexicon.py.\n"
        f"   Строк: {len(ordered)}. Формат: [иероглифы, пиньинь цифрами, пиньинь,\n"
        "   перевод, уровень HSK, частота, есть_в_курсе]. */\n"
        "const LEXICON_ROWS = "
    )
    OUT.write_text(header + payload + ";\n", encoding="utf-8")
    print(f"OK {OUT} — {len(ordered)} слов, {OUT.stat().st_size / 1024:.0f} KB, "
          f"на кириллице: {sum(1 for r in ordered if re.search('[а-яА-Я]', r[3]))}")


if __name__ == "__main__":
    main()
