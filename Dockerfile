FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/app/data/app.db

WORKDIR /app

COPY build.py server.py docker-entrypoint.sh ./
COPY src ./src

# Собираем index.html на этапе образа и готовим каталог для базы.
RUN python3 build.py \
 && mkdir -p /app/data \
 && useradd --system --uid 10001 --gid 0 --home-dir /app --shell /usr/sbin/nologin appuser \
 && chown -R appuser:0 /app \
 && chmod 0775 /app/data \
 && chmod +x /app/docker-entrypoint.sh

# Не работаем от root: сервер не должен иметь прав на всю файловую систему.
#
# ВАЖНО: примонтированный в /app/data диск (Render Disk / Railway Volume)
# перекрывает каталог из образа, и владельцем становится root. Процесс под
# appuser тогда не может ни создать app.db, ни открыть базу на запись —
# отсюда «sqlite3.OperationalError: attempt to write a readonly database».
# Поэтому точку входа делаем root'ом: она выдаёт appuser права на диск
# и только потом запускает сервер уже от непривилегированного пользователя.
USER root

ENTRYPOINT ["/app/docker-entrypoint.sh"]

EXPOSE 8080

# /api/auth/status отвечает без авторизации — удобно для healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/api/auth/status', timeout=4)"

CMD ["python3", "-u", "server.py"]
