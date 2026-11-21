#!/usr/bin/env python3
"""Сборка единого автономного HTML-файла из исходников в src/.

Скрипт проставляет в сборку «метку версии» (хеш содержимого src/ и время
сборки). По ней сервер и браузер понимают, что на диске уже новая сборка,
и не показывают старую страницу из кэша.
"""

import hashlib
import json
import os
import pathlib
import sys
import time

base = pathlib.Path(__file__).parent
src = base / "src"

SOURCE_FILES = ("styles.css", "data.js", "lexicon.js", "pinyin.js", "homework.js", "auth.js", "app.js", "index.template.html")

styles = (src / "styles.css").read_text(encoding="utf-8")
data = (src / "data.js").read_text(encoding="utf-8")
lexicon = (src / "lexicon.js").read_text(encoding="utf-8")
pinyin_src = (src / "pinyin.js").read_text(encoding="utf-8")
hw = (src / "homework.js").read_text(encoding="utf-8")
auth = (src / "auth.js").read_text(encoding="utf-8")
app = (src / "app.js").read_text(encoding="utf-8")
tpl = (src / "index.template.html").read_text(encoding="utf-8")


def safe(js: str) -> str:
    """Защита от преждевременного закрытия тега <script> внутри JS."""
    return js.replace("</script>", "<\\/script>")


# Версия сборки = хеш всех исходников. Меняется только при реальной правке кода,
# поэтому пересборка без изменений даёт тот же идентификатор.
digest = hashlib.sha256()
for name in SOURCE_FILES:
    digest.update(name.encode("utf-8"))
    digest.update((src / name).read_bytes())
    digest.update(b"\0")
BUILD_ID = digest.hexdigest()[:12]

# Время сборки берём из SOURCE_DATE_EPOCH, если он задан. Так сборка
# воспроизводима: CI может собрать тот же index.html байт в байт, и
# проверка «index.html не расходится с src/» не падает из-за минут.
# Если переменная не задана, используем текущее время.
_epoch = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
if _epoch.isdigit():
    _when = time.gmtime(int(_epoch))
    BUILD_TIME = time.strftime("%d.%m.%Y %H:%M", _when) + " UTC"
    _built_ts = int(_epoch)
else:
    BUILD_TIME = time.strftime("%d.%m.%Y %H:%M", time.localtime())
    _built_ts = int(time.time())

out = (
    tpl.replace("{{BUILD_ID}}", BUILD_ID)
    .replace("{{STYLES}}", styles)
    .replace("{{DATA}}", safe(data))
    .replace("{{LEXICON}}", safe(lexicon))
    .replace("{{PINYIN}}", safe(pinyin_src))
    .replace("{{HOMEWORK}}", safe(hw))
    .replace("{{AUTH}}", safe(auth))
    .replace("{{APP}}", safe(app))
)

# Незаполненный плейсхолдер означает, что сборка «успешна», но приложение сломано.
leftovers = [
    p for p in ("{{BUILD_ID}}", "{{STYLES}}", "{{DATA}}", "{{LEXICON}}", "{{PINYIN}}", "{{HOMEWORK}}", "{{AUTH}}", "{{APP}}")
    if p in out
]
if leftovers:
    sys.exit(f"ОШИБКА: в шаблоне остались плейсхолдеры: {', '.join(leftovers)}")

# Каждый иероглиф курса должен иметь чтение: иначе ученик увидит значок
# без пиньиня — ровно та проблема, из-за которой пиньинь и добавляли.
import re

py_chars = set(re.findall(r'"([\u3400-\u9fff])":"', pinyin_src))
data_chars = set(re.findall(r"[\u3400-\u9fff]", data))
missing = sorted(data_chars - py_chars)
if missing:
    sys.exit(
        "ОШИБКА: нет пиньиня для иероглифов: " + " ".join(missing[:40])
        + "\nОбновите src/pinyin.js (python3 tools/make-pinyin.py)."
    )

# Проверка баланса тегов <script>. Считаем только реальные теги шаблона:
# в комментариях кода слово «<script>» тоже встречается и раньше давало
# ложное срабатывание.
_tpl_open = tpl.count("<script>")
_tpl_close = tpl.count("</script>")
if _tpl_open != _tpl_close:
    sys.exit(f"ОШИБКА: дисбаланс тегов script в шаблоне ({_tpl_open} против {_tpl_close})")
if out.count("</script>") != _tpl_close + sum(
    f.count("</script>") for f in (styles, data, lexicon, pinyin_src, hw, auth, app)
):
    sys.exit("ОШИБКА: в собранной странице потерян закрывающий тег script")

target = base / "index.html"
target.write_bytes(out.encode("utf-8"))

# PWA-обвязка: манифест и service worker копируются рядом со страницей,
# иначе установка на телефон и офлайн-режим не работают.
import shutil
for name in ("manifest.json", "sw.js"):
    shutil.copyfile(src / name, base / name)
# Метка сборки в service worker: при обновлении страницы кэш обновится сам.
_sw = (base / "sw.js").read_text(encoding="utf-8").replace("zh-app-v1", f"zh-app-{BUILD_ID}")
(base / "sw.js").write_text(_sw, encoding="utf-8")
for name in ("icon-192.png", "icon-512.png"):
    if (base / name).exists():
        continue
    shutil.copyfile(base / name if (base / name).exists() else src / name, base / name)

# Рядом кладём метку сборки: сервер пересобирает index.html, если исходники
# в src/ новее этой метки. Так забытый build.py больше не выдаёт старую версию.
(base / "build-info.json").write_text(
    json.dumps({"id": BUILD_ID, "built_at": BUILD_TIME, "built_ts": _built_ts},
               ensure_ascii=False, indent=2),
    encoding="utf-8",
)

print(f"OK  {target}  ({len(out.encode('utf-8')) / 1024:.1f} KB)  build {BUILD_ID} · {BUILD_TIME}")
