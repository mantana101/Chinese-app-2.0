#!/usr/bin/env python3
"""Точка входа контейнера: права на диск → запуск сервера не от root.

Зачем это нужно
---------------
Render Disk / Railway Volume монтируется в /app/data **после** сборки образа
и принадлежит root. Пользователь appuser (uid 10001) тогда не может ни
создать app.db, ни открыть базу на запись — отсюда
«sqlite3.OperationalError: attempt to write a readonly database».

Почему не shell-скрипт с su
---------------------------
В slim-образе может не оказаться `su`, `chown` или `chmod`, а `su` ещё и
по-разному передаёт окружение. Здесь всё делается средствами Python
(os.chown, os.setgid, os.setuid) — без внешних бинарников и без сюрпризов.

Если контейнер запущен не от root (Kubernetes runAsNonRoot) — просто
запускаем сервер как есть, ничего не меняя.
"""

import grp
import os
import sys

APP_UID = 10001
APP_GID = 0


def data_dir() -> str:
    db_path = os.environ.get("DB_PATH") or "/app/data/app.db"
    return os.path.dirname(os.path.abspath(db_path)) or "/app"


def ensure_dir(path: str) -> None:
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as exc:
        print(f"[entrypoint] не удалось создать {path}: {exc}", file=sys.stderr)
        sys.exit(1)


def chown_tree(path: str) -> None:
    """Отдаёт каталог данных пользователю приложения.

    Ошибки не фатальны: на некоторых сетевых ФС (NFS) chown запрещён, но
    запись при этом может быть разрешена. Реальную проверку делаем ниже.
    """
    targets = [path]
    try:
        for name in os.listdir(path):
            targets.append(os.path.join(path, name))
    except OSError:
        pass
    for target in targets:
        try:
            os.chown(target, APP_UID, APP_GID)
        except OSError:
            pass
        # Каталогу нужен бит записи для владельца, файлам — нет.
        if os.path.isdir(target):
            try:
                os.chmod(target, 0o775)
            except OSError:
                pass


def can_write_as_app_user(path: str) -> bool:
    """Проверяет запись, временно переключаясь на appuser (и возвращаясь)."""
    saved_uid, saved_gid = os.getuid(), os.getgid()
    try:
        os.setegid(APP_GID)
        os.seteuid(APP_UID)
        probe = os.path.join(path, ".write-probe")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.unlink(probe)
        return True
    except OSError:
        return False
    finally:
        os.seteuid(saved_uid)
        os.setegid(saved_gid)


def main() -> None:
    argv = sys.argv[1:] or ["python3", "-u", "server.py"]
    target_dir = data_dir()

    is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    if not is_root:
        # Уже непривилегированный процесс — менять нечего.
        print(f"[entrypoint] не root, запускаю как есть: {argv}", flush=True)
        os.execvp(argv[0], argv)

    ensure_dir(target_dir)
    chown_tree(target_dir)

    if not can_write_as_app_user(target_dir):
        print(
            f"ОШИБКА: у пользователя appuser (uid {APP_UID}) нет прав на запись "
            f"в {target_dir}.\n"
            "Проверьте в Render/Railway, что диск привязан к этому сервису, "
            "смонтирован в /app/data и не помечен read-only.",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    try:
        gid = grp.getgrnam("appuser").gr_gid
        uid = APP_UID
    except KeyError:
        gid, uid = APP_GID, APP_UID

    print(f"[entrypoint] права на {target_dir} в порядке, запускаю: {' '.join(argv)}",
          flush=True)

    # Сбрасываем привилегии навсегда и запускаем сервер.
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    os.execvp(argv[0], argv)


if __name__ == "__main__":
    main()
