FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/app/data/app.db

WORKDIR /app

COPY build.py server.py ./
COPY src ./src

# Собираем index.html на этапе образа и сразу готовим каталог для базы.
RUN python3 build.py \
 && mkdir -p /app/data \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin appuser \
 && chown -R appuser:appuser /app

# Не работаем от root: сервер не должен иметь прав на всю файловую систему.
USER appuser

EXPOSE 8080

# /api/auth/status отвечает без авторизации — удобно для healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/api/auth/status', timeout=4)"

CMD ["python3", "-u", "server.py"]
