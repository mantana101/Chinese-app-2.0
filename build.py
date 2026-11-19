#!/usr/bin/env python3
"""Сборка единого автономного HTML-файла из исходников в src/."""

import pathlib
import sys

base = pathlib.Path(__file__).parent
src = base / "src"

styles = (src / "styles.css").read_text(encoding="utf-8")
data = (src / "data.js").read_text(encoding="utf-8")
auth = (src / "auth.js").read_text(encoding="utf-8")
app = (src / "app.js").read_text(encoding="utf-8")
tpl = (src / "index.template.html").read_text(encoding="utf-8")


def safe(js: str) -> str:
    """Защита от преждевременного закрытия тега <script> внутри JS."""
    return js.replace("</script>", "<\\/script>")


out = (
    tpl.replace("{{STYLES}}", styles)
    .replace("{{DATA}}", safe(data))
    .replace("{{AUTH}}", safe(auth))
    .replace("{{APP}}", safe(app))
)

# Незаполненный плейсхолдер означает, что сборка «успешна», но приложение сломано.
leftovers = [p for p in ("{{STYLES}}", "{{DATA}}", "{{AUTH}}", "{{APP}}") if p in out]
if leftovers:
    sys.exit(f"ОШИБКА: в шаблоне остались плейсхолдеры: {', '.join(leftovers)}")

# Проверка баланса тегов <script>
if out.count("<script>") != out.count("</script>"):
    sys.exit("ОШИБКА: дисбаланс тегов script")

target = base / "index.html"
target.write_bytes(out.encode("utf-8"))
print(f"OK  {target}  ({len(out.encode('utf-8')) / 1024:.1f} KB)")
