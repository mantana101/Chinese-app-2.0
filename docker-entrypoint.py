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
В slim-образе нет `su` (busybox «su» из util-linux не принимает -s так, как
ожидает POSIX-скрипт), может не быть `chown`. Здесь всё делается средствами
Python: os.chown, os.setgid, os.setuid — без внешних бинарников.

Главный принцип: **никогда не падать молча**. Если права исправить не
удалось, сервер всё равно запускается, а в лог пишется точная причина.
Пусть лучше приложение ответит понятной ошибкой на /api/*, чем сервис
уйдёт в бесконечный рестарт с пустым логом.
"""

import os
import sys

APP_UID = 10001
APP_GID = 0


def log(msg: str) -> None:
    print(f"[entrypoint] {msg}", flush=True)


def err(msg: str) -> None:
    print(f"[entrypoint] ОШИБКА: {msg}", file=sys.stderr, flush=True)


def data_dir() -> str:
    db_path = os.environ.get("DB_PATH") or "/app/data/app.db"
    return os.path.dirname(os.path.abspath(db_path)) or "/app"


def describe(path: str) -> str:
    """Человеческое описание каталога: владелец, права, устройство, запись."""
    try:
        st = os.stat(path)
    except OSError as exc:
        return f"{path}: недоступен ({exc})"
    writable = "да" if os.access(path, os.W_OK) else "НЕТ"
    return (
        f"{path}: uid={st.st_uid} gid={st.st_gid} mode={oct(st.st_mode & 0o777)} "
        f"dev={st.st_dev} запись_для_root={writable}"
    )


def prepare(path: str) -> None:
    """Создаёт каталог данных и отдаёт его appuser. Ошибки — только в лог."""
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as exc:
        err(f"не удалось создать {path}: {exc}")
        return

    targets = [path]
    try:
        targets += [os.path.join(path, n) for n in os.listdir(path)]
    except OSError as exc:
        err(f"не удалось прочитать {path}: {exc}")

    for target in targets:
        try:
            os.chown(target, APP_UID, APP_GID)
        except OSError:
            pass  # NFS и некоторые ФС запрещают chown — это не фатально
        if os.path.isdir(target):
            try:
                os.chmod(target, 0o775)
            except OSError:
                pass

    log("после подготовки: " + describe(path))


def probe(path: str) -> bool:
    """Реальная пробная запись от имени appuser — единственный надёжный тест."""
    saved_uid, saved_gid = os.getuid(), os.getgid()
    try:
        os.setegid(APP_GID)
        os.seteuid(APP_UID)
        probe_path = os.path.join(path, ".write-probe")
        with open(probe_path, "w", encoding="utf-8") as f:
            f.write("ok")
        os.unlink(probe_path)
        return True
    except OSError as exc:
        err(f"запись в {path} от имени appuser не удалась: {exc}")
        return False
    finally:
        try:
            os.seteuid(saved_uid)
            os.setegid(saved_gid)
        except OSError:
            pass


def drop_privileges() -> None:
    os.setgroups([])
    os.setgid(APP_GID)
    os.setuid(APP_UID)


def main() -> None:
    argv = sys.argv[1:] or ["python3", "-u", "server.py"]
    target = data_dir()

    log(f"DB_PATH={os.environ.get('DB_PATH')} каталог={target}")
    log("до подготовки: " + describe(target))

    if not (hasattr(os, "geteuid") and os.geteuid() == 0):
        log(f"уже не root (uid={os.getuid()}) — запускаю как есть")
        os.execvp(argv[0], argv)

    prepare(target)

    if not probe(target):
        # Не выходим: пусть сервер запустится и отдаст внятную ошибку в API,
        # а не уйдёт в цикл рестартов. Причина уже записана в лог выше.
        err("продолжаю запуск без понижения привилегий — проверьте диск в Render")
        os.execvp(argv[0], argv)

    log("права в порядке, понижаю привилегии до appuser и запускаю сервер")
    try:
        drop_privileges()
    except OSError as exc:
        err(f"не удалось понизить привилегии ({exc}) — запускаю от root")
        os.execvp(argv[0], argv)

    os.execvp(argv[0], argv)


if __name__ == "__main__":
    main()
