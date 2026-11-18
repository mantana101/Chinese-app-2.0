#!/usr/bin/env python3
# Сборка единого автономного HTML-файла из исходников в src/
import pathlib, sys, datetime

base = pathlib.Path(__file__).parent
src = base / "src"

styles = (src / "styles.css").read_text(encoding="utf-8")
data = (src / "data.js").read_text(encoding="utf-8")
auth = (src / "auth.js").read_text(encoding="utf-8")
app = (src / "app.js").read_text(encoding="utf-8")
tpl = (src / "index.template.html").read_text(encoding="utf-8")

# Защита от конфликта тегов </script> внутри JS
def safe(js: str) -> str:
    return js.replace("</script>", "<\\/script>")

out = (tpl
       .replace("{{STYLES}}", styles)
       .replace("{{DATA}}", safe(data))
       .replace("{{AUTH}}", safe(auth))
       .replace("{{APP}}", safe(app)))

target = base / "index.html"
target.write_text(out, encoding="utf-8")
print(f"OK  {target}  ({len(out)/1024:.1f} KB)")

# Проверка баланса тегов <script>
if out.count("<script>") != out.count("</script>"):
    sys.exit("ОШИБКА: дисбаланс тегов script")
