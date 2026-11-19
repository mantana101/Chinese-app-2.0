#!/bin/sh
# Точка входа контейнера.
#
# Проблема: Render Disk / Railway Volume монтируется в /app/data уже после
# сборки образа и принадлежит root. Пользователь appuser (uid 10001) тогда
# не может создать/открыть app.db → «attempt to write a readonly database».
#
# Решение: пока мы root — приводим каталог данных в порядок и запускаем
# сервер от непривилегированного appuser. Если контейнер уже запущен не
# от root (например, Kubernetes с runAsNonRoot), просто запускаем сервер.

set -e

APP_UID=10001
APP_USER=appuser
DATA_DIR="$(dirname "${DB_PATH:-/app/data/app.db}")"

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_DIR"

    # chown может не сработать на некоторых сетевых ФС (NFS и т.п.) —
    # это не повод падать, поэтому ошибку игнорируем.
    chown -R "$APP_UID:0" "$DATA_DIR" 2>/dev/null || true
    chmod 0775 "$DATA_DIR" 2>/dev/null || true

    # Если база уже есть — нужны права и на неё, и на файлы WAL/SHM.
    for f in "$DATA_DIR"/app.db "$DATA_DIR"/app.db-wal "$DATA_DIR"/app.db-shm; do
        [ -e "$f" ] && chown "$APP_UID:0" "$f" 2>/dev/null || true
    done

    # Проверяем, что запись действительно возможна, и только тогда
    # понижаем привилегии. Иначе лучше упасть сразу с понятным сообщением,
    # чем получить «readonly database» внутри приложения.
    if ! su -s /bin/sh "$APP_USER" -c "test -w '$DATA_DIR'"; then
        echo "ОШИБКА: у пользователя $APP_USER нет прав на запись в $DATA_DIR." >&2
        echo "Проверьте, что диск смонтирован и доступен на запись." >&2
        exit 1
    fi

    exec su -s /bin/sh "$APP_USER" -c 'exec "$0" "$@"' "$@"
fi

exec "$@"
