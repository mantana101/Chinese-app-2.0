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

SOURCE_FILES = ("styles.css", "data.js", "auth.js", "app.js", "index.template.html")

styles = (src / "styles.css").read_text(encoding="utf-8")
data = (src / "data.js").read_text(encoding="utf-8")
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
    .replace("{{AUTH}}", safe(auth))
    .replace("{{APP}}", safe(app))
)

# Незаполненный плейсхолдер означает, что сборка «успешна», но приложение сломано.
leftovers = [
    p for p in ("{{BUILD_ID}}", "{{STYLES}}", "{{DATA}}", "{{AUTH}}", "{{APP}}")
    if p in out
]
if leftovers:
    sys.exit(f"ОШИБКА: в шаблоне остались плейсхолдеры: {', '.join(leftovers)}")

# Проверка баланса тегов <script>
if out.count("<script>") != out.count("</script>"):
    sys.exit("ОШИБКА: дисбаланс тегов script")

target = base / "index.html"
target.write_bytes(out.encode("utf-8"))

# Рядом кладём метку сборки: сервер пересобирает index.html, если исходники
# в src/ новее этой метки. Так забытый build.py больше не выдаёт старую версию.
(base / "build-info.json").write_text(
    json.dumps({"id": BUILD_ID, "built_at": BUILD_TIME, "built_ts": _built_ts},
               ensure_ascii=False, indent=2),
    encoding="utf-8",
)

print(f"OK  {target}  ({len(out.encode('utf-8')) / 1024:.1f} KB)  build {BUILD_ID} · {BUILD_TIME}")
