FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/app/data/app.db

WORKDIR /app

COPY build.py server.py docker-entrypoint.py ./
COPY src ./src
# PWA: манифест, service worker и иконки нужны рядом со страницей
COPY manifest.json sw.js icon-192.png icon-512.png ./
# Изображения-заглушки папки шрифтов: build.py наполнит её из src/fonts
RUN mkdir -p /app/fonts /app/lexicon.js
# Словарь помощника (11 470 слов, сжатый): по нему он ищет офлайн.
COPY data/cedict.txt.gz ./data/cedict.txt.gz

# Собираем index.html на этапе образа и готовим каталог для базы.
RUN python3 build.py \
 && mkdir -p /app/data \
 && useradd --system --uid 10001 --gid 0 --home-dir /app --shell /usr/sbin/nologin appuser \
 && chown -R appuser:0 /app \
 && chmod 0775 /app/data \
 && chmod +x /app/docker-entrypoint.py

# Не работаем от root: сервер не должен иметь прав на всю файловую систему.
#
# ВАЖНО: примонтированный в /app/data диск (Render Disk / Railway Volume)
# перекрывает каталог из образа, и владельцем становится root. Процесс под
# appuser тогда не может ни создать app.db, ни открыть базу на запись —
# отсюда «sqlite3.OperationalError: attempt to write a readonly database».
# Поэтому точка входа стартует root'ом: она выдаёт appuser права на диск
# и только потом запускает сервер уже от непривилегированного пользователя.
# Это Питон-скрипт, а не su: в slim-образе может не оказаться su, а
# os.setuid/os.chown работают всегда и одинаково.
USER root

ENTRYPOINT ["python3", "/app/docker-entrypoint.py"]

EXPOSE 8080

# /api/auth/status отвечает без авторизации — удобно для healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/api/auth/status', timeout=4)"

CMD ["python3", "-u", "server.py"]
