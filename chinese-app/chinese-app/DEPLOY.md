# Запуск программы в интернете (для учеников с телефонов и компьютеров)

Программа не требует сторонних библиотек — только Python 3 и один файл базы данных SQLite (`app.db`). Все конфиги уже лежат в этой папке.

> **Важно:** храните папку с базой (`/app/data`) на постоянном диске (Persistent Disk / Volume), чтобы аккаунты и оценки учеников не пропадали при перезапуске.

---

## Вариант 1. Render (проще всего)

1. Загрузите содержимое папки `chinese-app` в репозиторий на GitHub.
2. Зайдите на [render.com](https://render.com) → **New → Blueprint** и выберите репозиторий.
3. Render автоматически подхватит файл `render.yaml` (Docker + постоянный диск `/app/data` на 1 ГБ).
4. После сборки вы получите постоянную ссылку вида `https://chinese-learning-app.onrender.com` — её можно отправлять ученикам.

---

## Вариант 2. Railway

1. Загрузите папку `chinese-app` на GitHub и откройте [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
2. Railway подхватит `Dockerfile` и `railway.toml`.
3. В настройках сервиса добавьте **Volume**, смонтированный в `/app/data`, и переменную `DB_PATH=/app/data/app.db`.
4. В разделе **Settings → Networking** нажмите **Generate Domain** и получите публичную HTTPS-ссылку.

---

## Вариант 3. Свой VPS / компьютер (Docker)

```bash
docker build -t chinese-app .
docker run -d \
  --name chinese-app \
  --restart unless-stopped \
  -p 8080:8080 \
  -v chinese_data:/app/data \
  chinese-app
```

Или без Docker напрямую через Python 3:

```bash
python3 build.py
python3 -u server.py
```

После запуска откройте сайт, зарегистрируйтесь первым (вы сразу станете **Владельцем**), затем зайдите в **«Класс» → «Создать код»** и раздайте коды ученикам.
