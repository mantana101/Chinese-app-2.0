#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
汉语学习 · Сервер приложения «Китайский язык».

Роли:
  owner   — владелец (учитель-владелец): полный доступ, создаёт учеников и учителей
  teacher — учитель: видит класс, выставляет оценки, создаёт коды-приглашения
  student — ученик: свой профиль, свой прогресс

Запуск:
  python3 server.py            # http://0.0.0.0:8080
  PORT=9000 python3 server.py
Первый зарегистрировавшийся человек автоматически становится владельцем.
"""

import http.server
import socketserver
import json
import sqlite3
import os
import re
import hashlib
import hmac
import secrets
import time
import threading
import urllib.parse
import urllib.request
import csv
import io
import sys
import tempfile
import traceback

STARTED_AT = int(time.time())

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH") or os.path.join(BASE, "data", "app.db")
INDEX = os.path.join(BASE, "index.html")

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))

SESSION_DAYS = 30
PBKDF2_ROUNDS = 200_000
MIN_PASSWORD_LEN = 8

# Единственное место, где задано число уроков курса.
# Должно совпадать с количеством уроков в src/data.js (объект LESSONS).
LESSONS_TOTAL = int(os.environ.get("LESSONS_TOTAL", "15"))

# Пределы размера тела запроса — защита от DoS и раздувания базы.
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(1_000_000)))
MAX_PROGRESS_BYTES = int(os.environ.get("MAX_PROGRESS_BYTES", str(512_000)))
MAX_DRAIN_BYTES = int(os.environ.get("MAX_DRAIN_BYTES", str(8_000_000)))

# Доверять ли X-Forwarded-For. На Render/Railway сервер стоит за прокси,
# который сам проставляет заголовок. Если сервер открыт в интернет напрямую,
# обязательно выставите TRUST_PROXY=0, иначе клиент подделает свой IP.
TRUST_PROXY = os.environ.get("TRUST_PROXY", "1").strip().lower() not in ("0", "false", "no")

# Флаг Secure для cookie сессии — включайте на HTTPS (SECURE_COOKIES=1).
SECURE_COOKIES = os.environ.get("SECURE_COOKIES", "0").strip().lower() in ("1", "true", "yes")


class ApiError(Exception):
    """Ожидаемая ошибка API: превращается в аккуратный JSON-ответ."""

    def __init__(self, code, error):
        super().__init__(error)
        self.code = code
        self.error = error


# ---------------- база ----------------

_local = threading.local()


def _track(conn):
    """Запоминает соединение, чтобы его закрыли в finally обработчика."""
    conns = getattr(_local, "conns", None)
    if conns is None:
        conns = _local.conns = []
    conns.append(conn)
    return conn


def close_all_conns():
    """Закрывает все соединения, открытые в текущем потоке.

    Без этого любое исключение оставляло соединение с блокировкой: сервер
    постепенно упирался в «database is locked» и исчерпание дескрипторов.
    """
    for conn in (getattr(_local, "conns", None) or []):
        try:
            conn.close()
        except Exception:
            pass
    _local.conns = []


def db():
    d = os.path.dirname(os.path.abspath(DB_PATH))
    if d:
        os.makedirs(d, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    # busy_timeout заставляет SQLite самому ждать освобождения блокировки
    # вместо мгновенной ошибки «database is locked».
    conn.execute("PRAGMA busy_timeout=30000")
    return _track(conn)


def init_db():
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            display_name  TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'student',
            pass_hash     TEXT NOT NULL,
            salt          TEXT NOT NULL,
            active        INTEGER NOT NULL DEFAULT 1,
            created_at    INTEGER NOT NULL,
            last_login    INTEGER
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS progress (
            user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            payload    TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind       TEXT NOT NULL,
            detail     TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invites (
            code       TEXT PRIMARY KEY,
            created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL,
            used_at    INTEGER,
            note       TEXT
        );
        CREATE TABLE IF NOT EXISTS grades (
            user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            grade      TEXT,
            comment    TEXT,
            updated_at INTEGER NOT NULL,
            by_user    INTEGER
        );
        CREATE TABLE IF NOT EXISTS system_errors (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            source     TEXT NOT NULL,
            message    TEXT NOT NULL,
            detail     TEXT,
            user_id    INTEGER,
            created_at INTEGER NOT NULL
        );
        """
    )
    # Гарантия «ровно один владелец» на уровне базы: иначе одновременная
    # регистрация первых пользователей создавала несколько владельцев.
    try:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uniq_single_owner "
            "ON users(role) WHERE role = 'owner'"
        )
    except sqlite3.IntegrityError:
        print("⚠  в базе несколько владельцев — уникальный индекс не создан")
    conn.commit()
    conn.close()


def migrate(conn):
    """Простые миграции схемы по PRAGMA user_version."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < 1:
        # v1 — базовая схема (все таблицы создаются через IF NOT EXISTS).
        conn.execute("PRAGMA user_version = 1")
        conn.commit()


def record_error(source: str, message: str, detail: str = "", user_id=None):
    try:
        conn = db()
        conn.execute(
            "INSERT INTO system_errors (source, message, detail, user_id, created_at) VALUES (?,?,?,?,?)",
            ((source or "server")[:20], (message or "")[:400], (detail or "")[:2000], user_id, now()),
        )
        # оставляем не более 200 последних записей
        conn.execute(
            "DELETE FROM system_errors WHERE id NOT IN (SELECT id FROM system_errors ORDER BY id DESC LIMIT 200)"
        )
        conn.commit()
        conn.close()
    except Exception:
        pass


# ---------------- утилиты ----------------

def hash_pw(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS
    ).hex()


def make_salt() -> str:
    return secrets.token_hex(16)


def now() -> int:
    return int(time.time())


_CYR = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z',
    'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
    'с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh',
    'щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    'ғ':'g','ӣ':'i','қ':'q','ӯ':'u','ҳ':'h','ҷ':'j',
}


def slugify(text: str) -> str:
    s = "".join(_CYR.get(ch, ch) for ch in (text or "").strip().lower())
    t = re.sub(r"[^a-z0-9_.-]+", "", s)
    return t[:24] or "user"


def json_body(handler, max_bytes=None):
    """Читает JSON-тело запроса с ограничением размера."""
    limit = max_bytes or MAX_BODY_BYTES
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except (TypeError, ValueError):
        raise ApiError(400, "bad_length")
    if length < 0:
        raise ApiError(400, "bad_length")
    if not length:
        return {}
    if length > limit:
        # Если ответить не дочитав тело, клиент получит обрыв соединения
        # вместо внятного 413. Дочитываем в разумных пределах и закрываемся.
        try:
            handler.rfile.read(min(length, MAX_DRAIN_BYTES))
        except Exception:
            pass
        handler.close_connection = True
        raise ApiError(413, "payload_too_large")
    raw = handler.rfile.read(length)
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        raise ApiError(400, "bad_json")
    if not isinstance(data, dict):
        raise ApiError(400, "bad_json")
    return data


def parse_id(value):
    """Положительный int из недоверенного значения или 400."""
    try:
        num = int(value)
    except (TypeError, ValueError):
        raise ApiError(400, "bad_id")
    if num <= 0:
        raise ApiError(400, "bad_id")
    return num


def csv_safe(value):
    """Защита от CSV-инъекции: Excel не должен выполнять формулы из ячеек."""
    text = "" if value is None else str(value)
    if text[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text
    return text


def _as_text(value):
    """Строка из недоверенного значения (без падений на dict/list)."""
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return str(value).strip()


def _as_int(value, default=0):
    try:
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, float) and value != value:  # NaN
            return default
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _as_float(value, default=0.0):
    try:
        if isinstance(value, bool):
            return float(value)
        num = float(value)
        return default if num != num else num  # NaN
    except (TypeError, ValueError, OverflowError):
        return default


def _safe_write(handler, body: bytes):
    """Отправка тела клиенту, который мог уже отключиться."""
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        pass


def send_json(handler, code, obj, extra_headers=None):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    if getattr(handler, "close_connection", False):
        handler.send_header("Connection", "close")
    send_common_headers(handler)
    for k, v in (extra_headers or {}).items():
        handler.send_header(k, v)
    handler.end_headers()
    _safe_write(handler, body)


def send_common_headers(handler):
    """CORS (нужен для iframe с origin: null) и базовые заголовки безопасности."""
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    handler.send_header("Access-Control-Max-Age", "86400")
    handler.send_header("Vary", "Origin")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    # Приложение — один HTML-файл с inline-скриптами, поэтому 'unsafe-inline'
    # неизбежен; зато внешние источники и загрузка чужих скриптов запрещены.
    # frame-ancestors '*' сохраняет работу внутри iframe (превью).
    handler.send_header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "connect-src 'self'; font-src 'self'; frame-ancestors *; "
        "base-uri 'none'; form-action 'self'",
    )


# ---------------- сессии ----------------

class RateLimiter:
    """Ограничитель попыток с ограниченным размером памяти.

    Раньше словарь рос бесконечно: каждый новый «IP» добавлял запись навсегда.
    """

    def __init__(self, max_hits, block_sec, max_keys=20000):
        self.max_hits = max_hits
        self.block_sec = block_sec
        self.max_keys = max_keys
        self._lock = threading.Lock()
        self._hits = {}  # key -> (count, blocked_until)

    def allowed(self, key):
        with self._lock:
            _, until = self._hits.get(key, (0, 0))
            return not (until and now() < until)

    def fail(self, key):
        with self._lock:
            if len(self._hits) >= self.max_keys:
                self._prune_locked()
            count, until = self._hits.get(key, (0, 0))
            if until and now() >= until:
                count, until = 0, 0
            count += 1
            if count >= self.max_hits:
                count, until = 0, now() + self.block_sec
            self._hits[key] = (count, until)

    def reset(self, key):
        with self._lock:
            self._hits.pop(key, None)

    def _prune_locked(self):
        cutoff = now()
        stale = [k for k, (_, until) in self._hits.items() if not until or until < cutoff]
        for key in stale[: max(1, self.max_keys // 2)]:
            self._hits.pop(key, None)
        if len(self._hits) >= self.max_keys:
            self._hits.clear()


login_limiter = RateLimiter(max_hits=8, block_sec=300)
register_limiter = RateLimiter(max_hits=20, block_sec=3600)
ai_limiter = RateLimiter(max_hits=40, block_sec=3600)
client_error_limiter = RateLimiter(max_hits=30, block_sec=3600)


def session_token(handler):
    """Токен из Authorization: Bearer или из cookie sid."""
    auth_hdr = handler.headers.get("Authorization") or ""
    if auth_hdr.lower().startswith("bearer "):
        token = auth_hdr[7:].strip()
        if token:
            return token
    cookie = handler.headers.get("Cookie") or ""
    m = re.search(r"(?:^|;\s*)sid=([A-Za-z0-9_\-]+)", cookie)
    return m.group(1) if m else None


def get_session(handler):
    token = session_token(handler)
    if not token:
        return None
    conn = db()
    row = conn.execute(
        "SELECT s.token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND u.active = 1",
        (token,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    if row["expires_at"] < now():
        conn = db()
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()
        return None
    return row


def require_role(handler, *roles):
    """Сессия с нужной ролью или ожидаемая ошибка API."""
    row = get_session(handler)
    if not row:
        raise ApiError(401, "not_authenticated")
    if row["role"] not in roles:
        raise ApiError(403, "forbidden")
    return row


def load_target(conn, sid, actor, action):
    """Проверяет право актора воздействовать на пользователя sid.

    Раньше учитель мог удалить другого учителя, поставить оценку владельцу
    и сбросить прогресс владельца — роли проверялись только у актора.
    """
    target = conn.execute("SELECT id, role FROM users WHERE id = ?", (sid,)).fetchone()
    if not target:
        raise ApiError(404, "not_found")
    role = target["role"]
    if role == "owner":
        raise ApiError(403, "cannot_touch_owner")
    if role == "teacher":
        if actor["role"] != "owner" or action == "grade":
            raise ApiError(403, "forbidden")
    return target


def user_json(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
        "created_at": row["created_at"],
        "last_login": row["last_login"],
    }


def log_event(user_id, kind, detail=""):
    conn = db()
    conn.execute(
        "INSERT INTO events (user_id, kind, detail, created_at) VALUES (?,?,?,?)",
        (user_id, kind, detail[:400], now()),
    )
    conn.commit()
    conn.close()


# ---------------- агрегаты по прогрессу ----------------

def summarize(payload: dict) -> dict:
    """Считает сводные показатели из JSON-прогресса ученика.

    Прогресс присылает сам ученик, поэтому ни одно поле не считается
    доверенным: раньше строка вместо числа в totalRight валила всю
    страницу класса с ValueError.
    """
    if not isinstance(payload, dict):
        payload = {}
    lessons = payload.get("lessons")
    if not isinstance(lessons, dict):
        lessons = {}
    cards = payload.get("cards")
    if not isinstance(cards, dict):
        cards = {}
    days = payload.get("days")
    if not isinstance(days, list):
        days = []
    days = [d for d in days if isinstance(d, str)]
    quiz_log = payload.get("quizLog")
    if not isinstance(quiz_log, list):
        quiz_log = []

    right = max(0, _as_int(payload.get("totalRight")))
    wrong = max(0, _as_int(payload.get("totalWrong")))
    total = right + wrong

    done, scores, best = [], [], {}
    for key, value in lessons.items():
        if not isinstance(value, dict):
            continue
        if value.get("done"):
            done.append(key)
        if value.get("score") is None:
            continue
        score = min(1.0, max(0.0, _as_float(value.get("score"))))
        scores.append(score)
        best[str(key)] = round(score * 100)

    avg_score = round(sum(scores) / len(scores) * 100) if scores else 0
    accuracy = round(right / total * 100) if total else 0
    today = time.strftime("%Y-%m-%d")
    active_today = bool(days) and days[-1] == today

    return {
        "lessons_done": len(done),
        "lessons_total": LESSONS_TOTAL,
        "avg_score": avg_score,
        "accuracy": accuracy,
        "answers": total,
        "cards": len(cards),
        "streak": max(0, _as_int(payload.get("streak"))),
        "days_active": len(days),
        "active_today": active_today,
        "quizzes": len(quiz_log),
        "lesson_scores": best,
        "updated_at": _as_int(payload.get("_updated")),
    }


# ---------------- статика ----------------

_index_state = {"mtime": None, "body": None}
_index_lock = threading.Lock()


def _index_cache():
    """Читает index.html один раз и переиспользует, пока файл не изменился."""
    try:
        mtime = os.path.getmtime(INDEX)
    except OSError:
        return None
    with _index_lock:
        if _index_state["mtime"] != mtime:
            try:
                with open(INDEX, "rb") as f:
                    _index_state["body"] = f.read()
                _index_state["mtime"] = mtime
            except OSError:
                return None
        return _index_state["body"]


# ---------------- обработчик ----------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ChineseApp/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[{self.client_ip()}] {fmt % args}", flush=True)

    # ---------- утилиты ----------

    def client_ip(self):
        if TRUST_PROXY:
            fwd = self.headers.get("X-Forwarded-For") or ""
            parts = [p.strip() for p in fwd.split(",") if p.strip()]
            if parts:
                # Прокси дописывает адрес клиента в конец цепочки. Левые
                # значения присылает сам клиент — брать их означало
                # позволять обходить ограничение попыток входа.
                return parts[-1][:64]
        return self.client_address[0]

    def send_html(self, code, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        send_common_headers(self)
        self.end_headers()
        _safe_write(self, body)

    # ---------- маршрутизация ----------

    def do_OPTIONS(self):
        self.send_response(204)
        send_common_headers(self)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _dispatch(self, method: str):
        """Единая точка входа: аккуратные ошибки и закрытие соединений."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if not path.startswith("/api/"):
                return self.serve_app()
            if method == "GET":
                return self.api_get(path, urllib.parse.parse_qs(parsed.query))
            return self.api_post(path)
        except ApiError as exc:
            return send_json(self, exc.code, {"error": exc.error})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            record_error("server", f"{method} {self.path}: {exc}", traceback.format_exc())
            try:
                return send_json(self, 500, {"error": "server_error"})
            except Exception:
                return
        finally:
            close_all_conns()

    def do_GET(self):
        return self._dispatch("GET")

    def do_POST(self):
        return self._dispatch("POST")

    def do_PUT(self):
        return self._dispatch("PUT")

    def do_DELETE(self):
        return self._dispatch("DELETE")

    # ---------- статика ----------

    def serve_app(self):
        body = _index_cache()
        if body is None:
            body = b"<h1>index.html not found - run build.py</h1>"
        self.send_html(200, body)

    # ---------- API: GET ----------

    def api_get(self, path, query):
        conn = db()

        if path == "/api/auth/status":
            has = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
            codes = conn.execute("SELECT COUNT(*) c FROM invites WHERE used_by IS NULL").fetchone()["c"]
            conn.close()
            return send_json(self, 200, {"has_users": has > 0, "open_invites": codes})

        if path == "/api/auth/me":
            row = get_session(self)
            if not row:
                conn.close()
                return send_json(self, 401, {"error": "not_authenticated"})
            gr = conn.execute(
                "SELECT grade, comment, updated_at FROM grades WHERE user_id = ?", (row["id"],)
            ).fetchone()
            conn.close()
            return send_json(self, 200, {
                "user": user_json(row),
                "grade": dict(gr) if gr else None,
            })

        if path == "/api/progress":
            row = get_session(self)
            if not row:
                conn.close()
                return send_json(self, 401, {"error": "not_authenticated"})
            pr = conn.execute("SELECT payload, updated_at FROM progress WHERE user_id = ?", (row["id"],)).fetchone()
            conn.close()
            payload = json.loads(pr["payload"]) if pr else {}
            return send_json(self, 200, {"payload": payload, "updated_at": pr["updated_at"] if pr else 0})

        # --- класс (учитель / владелец) ---

        if path in ("/api/class/students", "/api/class/overview"):
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            rows = conn.execute(
                "SELECT u.*, g.grade, g.comment, g.updated_at AS grade_at, p.updated_at AS prog_at, p.payload "
                "FROM users u LEFT JOIN grades g ON g.user_id = u.id LEFT JOIN progress p ON p.user_id = u.id "
                "WHERE u.role = 'student' ORDER BY u.display_name COLLATE NOCASE"
            ).fetchall()
            students = []
            for r in rows:
                payload = json.loads(r["payload"]) if r["payload"] else {}
                s = summarize(payload)
                s.update(
                    {
                        "id": r["id"],
                        "username": r["username"],
                        "display_name": r["display_name"],
                        "grade": r["grade"],
                        "comment": r["comment"],
                        "created_at": r["created_at"],
                        "last_login": r["last_login"],
                        "last_active": r["prog_at"] or r["last_login"] or r["created_at"],
                    }
                )
                students.append(s)
            conn.close()
            overview = {
                "students": students,
                "count": len(students),
                "avg_score": round(sum(s["avg_score"] for s in students) / len(students)) if students else 0,
                "avg_accuracy": round(sum(s["accuracy"] for s in students) / len(students)) if students else 0,
                "active_today": sum(1 for s in students if s["active_today"]),
                "total_lessons": sum(s["lessons_done"] for s in students),
            }
            return send_json(self, 200, overview)

        if path == "/api/class/invites":
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            rows = conn.execute(
                "SELECT i.*, u.display_name AS creator FROM invites i "
                "JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 100"
            ).fetchall()
            conn.close()
            return send_json(self, 200, {"invites": [dict(r) for r in rows]})

        if path == "/api/class/export.csv":
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            rows = conn.execute(
                "SELECT u.*, g.grade, g.comment, p.payload, p.updated_at AS prog_at FROM users u "
                "LEFT JOIN grades g ON g.user_id = u.id LEFT JOIN progress p ON p.user_id = u.id "
                "WHERE u.role = 'student' ORDER BY u.display_name COLLATE NOCASE"
            ).fetchall()
            buf = io.StringIO()
            w = csv.writer(buf, delimiter=";")
            w.writerow(
                ["Имя", "Логин", "Уроки", "Средний балл", "Точность", "Карточки", "Дней подряд",
                 "Оценка", "Комментарий", "Последняя активность", "Создан"]
            )
            for r in rows:
                s = summarize(json.loads(r["payload"]) if r["payload"] else {})
                last = r["prog_at"] or r["last_login"] or r["created_at"]
                w.writerow(
                    [
                        # csv_safe: имя вида "=cmd|..." иначе выполнится в Excel.
                        csv_safe(r["display_name"]), csv_safe(r["username"]),
                        f"{s['lessons_done']}/{s['lessons_total']}",
                        s["avg_score"], f"{s['accuracy']}%", s["cards"], s["streak"],
                        csv_safe(r["grade"] or ""), csv_safe(r["comment"] or ""),
                        time.strftime("%Y-%m-%d %H:%M", time.localtime(last)) if last else "",
                        time.strftime("%Y-%m-%d", time.localtime(r["created_at"])),
                    ]
                )
            data = buf.getvalue().encode("utf-8-sig")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="klass.csv"')
            self.send_header("Content-Length", str(len(data)))
            send_common_headers(self)
            self.end_headers()
            _safe_write(self, data)
            return

        m = re.match(r"^/api/class/students/(\d+)$", path)
        if m:
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            sid = int(m.group(1))
            u = conn.execute("SELECT * FROM users WHERE id = ?", (sid,)).fetchone()
            if not u:
                conn.close()
                return send_json(self, 404, {"error": "not_found"})
            pr = conn.execute("SELECT payload, updated_at FROM progress WHERE user_id = ?", (sid,)).fetchone()
            gr = conn.execute("SELECT grade, comment, updated_at FROM grades WHERE user_id = ?", (sid,)).fetchone()
            ev = conn.execute(
                "SELECT kind, detail, created_at FROM events WHERE user_id = ? ORDER BY created_at DESC LIMIT 60",
                (sid,),
            ).fetchall()
            conn.close()
            payload = json.loads(pr["payload"]) if pr else {}
            return send_json(
                self,
                200,
                {
                    "user": user_json(u),
                    "payload": payload,
                    "summary": summarize(payload),
                    "grade": dict(gr) if gr else None,
                    "events": [dict(e) for e in ev],
                },
            )

        # --- система: статус, журнал ошибок и резервная копия (только владелец) ---

        if path == "/api/system/status":
            row = get_session(self)
            if not row or row["role"] != "owner":
                conn.close()
                return send_json(self, 403, {"error": "owner_only"})
            db_abs = os.path.abspath(DB_PATH)
            db_size = os.path.getsize(db_abs) if os.path.exists(db_abs) else 0
            counts = {
                "users": conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"],
                "students": conn.execute("SELECT COUNT(*) c FROM users WHERE role = 'student'").fetchone()["c"],
                "teachers": conn.execute("SELECT COUNT(*) c FROM users WHERE role IN ('owner','teacher')").fetchone()["c"],
                "sessions_active": conn.execute("SELECT COUNT(*) c FROM sessions WHERE expires_at > ?", (now(),)).fetchone()["c"],
                "invites_open": conn.execute("SELECT COUNT(*) c FROM invites WHERE used_by IS NULL").fetchone()["c"],
                "progress_rows": conn.execute("SELECT COUNT(*) c FROM progress").fetchone()["c"],
                "events": conn.execute("SELECT COUNT(*) c FROM events").fetchone()["c"],
                "errors": conn.execute("SELECT COUNT(*) c FROM system_errors").fetchone()["c"],
            }
            errs = conn.execute(
                "SELECT e.id, e.source, e.message, e.detail, e.created_at, u.username "
                "FROM system_errors e LEFT JOIN users u ON u.id = e.user_id "
                "ORDER BY e.id DESC LIMIT 40"
            ).fetchall()
            conn.close()
            return send_json(self, 200, {
                "ok": True,
                "uptime_sec": max(0, now() - STARTED_AT),
                "server_time": now(),
                "python_version": sys.version.split()[0],
                "db_path": db_abs,
                "db_size_bytes": db_size,
                "counts": counts,
                "errors": [dict(e) for e in errs],
            })

        if path == "/api/system/backup":
            row = get_session(self)
            if not row or row["role"] != "owner":
                conn.close()
                return send_json(self, 403, {"error": "owner_only"})
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=".db")
            os.close(tmp_fd)
            try:
                dst = sqlite3.connect(tmp_path)
                conn.backup(dst)
                dst.close()
                with open(tmp_path, "rb") as f:
                    data = f.read()
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            conn.close()
            fname = f"chinese-app-backup-{time.strftime('%Y%m%d-%H%M')}.db"
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
            self.send_header("Content-Length", str(len(data)))
            send_common_headers(self)
            self.end_headers()
            self.wfile.write(data)
            return

        conn.close()
        return send_json(self, 404, {"error": "not_found"})

    # ---------- API: POST / PUT / DELETE ----------

    def api_post(self, path):
        body = json_body(self)
        conn = db()

        # --- регистрация по коду приглашения ---

        if path == "/api/auth/register":
            ip = self.client_ip()
            # Регистрация раньше не ограничивалась вовсе — это позволяло
            # перебирать коды приглашений.
            if not register_limiter.allowed(ip):
                raise ApiError(429, "too_many")

            code = _as_text(body.get("code")).upper()[:40]
            display_name = _as_text(body.get("display_name"))[:40]
            password = body.get("password")
            if not isinstance(password, str):
                raise ApiError(400, "weak_password")
            if len(password) > 256:
                raise ApiError(400, "password_too_long")

            if len(display_name) < 2:
                raise ApiError(400, "name_required")
            if len(password) < MIN_PASSWORD_LEN:
                raise ApiError(400, "weak_password")

            username = slugify(_as_text(body.get("username")) or display_name)

            # Свободный код приглашения (занимаем его позже, атомарно).
            inv = None
            if code:
                inv = conn.execute(
                    "SELECT * FROM invites WHERE code = ? AND used_by IS NULL", (code,)
                ).fetchone()

            users_count = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
            if users_count > 0 and not inv:
                register_limiter.fail(ip)
                raise ApiError(403, "bad_invite")

            base = username
            i = 0
            while conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
                i += 1
                if i > 99:
                    raise ApiError(409, "username_busy")
                username = f"{base}{i}"

            salt = make_salt()
            pass_hash = hash_pw(password, salt)

            role = "owner" if users_count == 0 else "student"
            try:
                cur = conn.execute(
                    "INSERT INTO users (username, display_name, role, pass_hash, salt, created_at) "
                    "VALUES (?,?,?,?,?,?)",
                    (username, display_name, role, pass_hash, salt, now()),
                )
            except sqlite3.IntegrityError:
                # Между подсчётом и вставкой владельцем успел стать другой.
                conn.rollback()
                if role != "owner" or not inv:
                    register_limiter.fail(ip)
                    raise ApiError(403, "bad_invite")
                try:
                    cur = conn.execute(
                        "INSERT INTO users (username, display_name, role, pass_hash, salt, created_at) "
                        "VALUES (?,?,?,?,?,?)",
                        (username, display_name, "student", pass_hash, salt, now()),
                    )
                except sqlite3.IntegrityError:
                    conn.rollback()
                    raise ApiError(409, "username_busy")
            uid = cur.lastrowid

            if inv:
                # Атомарно занимаем код: два одновременных запроса с одним
                # кодом не должны оба пройти.
                taken = conn.execute(
                    "UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL",
                    (uid, now(), code),
                ).rowcount
                if not taken:
                    conn.rollback()
                    register_limiter.fail(ip)
                    raise ApiError(403, "bad_invite")

            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
            register_limiter.reset(ip)
            log_event(uid, "register", f"role={row['role']}")
            token = self.start_session(uid)
            return send_json(self, 200, {"user": user_json(row), "token": token},
                             self.cookie_headers(token))

        # --- вход ---

        if path == "/api/auth/login":
            ip = self.client_ip()
            if not login_limiter.allowed(ip):
                raise ApiError(429, "too_many")
            username = _as_text(body.get("username")).lstrip("@")[:40]
            password = body.get("password")
            if not isinstance(password, str) or len(password) > 256:
                login_limiter.fail(ip)
                raise ApiError(401, "bad_credentials")

            row = conn.execute(
                "SELECT * FROM users WHERE LOWER(username) = LOWER(?)", (username,)
            ).fetchone()
            if not row and username:
                low = username.lower()
                all_u = conn.execute("SELECT * FROM users").fetchall()
                matches = [u for u in all_u
                           if u["display_name"].strip().lower() == low
                           or u["username"].lower() == low]
                if len(matches) == 1:
                    row = matches[0]
            if not row or not row["active"] or not hmac.compare_digest(
                row["pass_hash"], hash_pw(password, row["salt"])
            ):
                login_limiter.fail(ip)
                raise ApiError(401, "bad_credentials")
            login_limiter.reset(ip)
            conn.execute("UPDATE users SET last_login = ? WHERE id = ?", (now(), row["id"]))
            # Заодно чистим просроченные сессии, иначе таблица растёт вечно.
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
            conn.commit()
            token = self.start_session(row["id"])
            log_event(row["id"], "login")
            return send_json(self, 200, {"user": user_json(row), "token": token},
                             self.cookie_headers(token))

        # --- смена своего пароля ---

        if path == "/api/auth/password":
            row = require_role(self, "owner", "teacher", "student")
            current = body.get("current")
            new = body.get("new")
            if not isinstance(current, str) or not isinstance(new, str):
                raise ApiError(400, "bad_password")
            if len(new) > 256:
                raise ApiError(400, "password_too_long")
            if len(new) < MIN_PASSWORD_LEN:
                raise ApiError(400, "weak_password")
            if not hmac.compare_digest(row["pass_hash"], hash_pw(current, row["salt"])):
                raise ApiError(403, "bad_password")
            salt = make_salt()
            conn.execute(
                "UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?",
                (hash_pw(new, salt), salt, row["id"]),
            )
            # Все прочие сессии отзываем: смена пароля должна выкидывать
            # посторонние устройства. Текущую оставляем рабочей.
            keep = session_token(self) or ""
            conn.execute(
                "DELETE FROM sessions WHERE user_id = ? AND token != ?", (row["id"], keep)
            )
            conn.commit()
            log_event(row["id"], "password_change", "пароль изменён владельцем аккаунта")
            return send_json(self, 200, {"ok": True})

        # --- сброс пароля учителем/владельцем ---

        if path == "/api/class/password":
            actor = require_role(self, "owner", "teacher")
            sid = parse_id(body.get("student_id"))
            new = body.get("new_password")
            if not isinstance(new, str) or not new:
                raise ApiError(400, "bad_password")
            if len(new) > 256:
                raise ApiError(400, "password_too_long")
            if len(new) < MIN_PASSWORD_LEN:
                raise ApiError(400, "weak_password")
            load_target(conn, sid, actor, "reset_password")
            salt = make_salt()
            conn.execute(
                "UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?",
                (hash_pw(new, salt), salt, sid),
            )
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (sid,))
            conn.execute(
                "INSERT INTO events (user_id, kind, detail, created_at) VALUES (?,?,?,?)",
                (sid, "password_reset", "пароль сброшен учителем", now()),
            )
            conn.commit()
            return send_json(self, 200, {"ok": True})

        if path == "/api/auth/logout":
            tok = session_token(self)
            if tok:
                conn.execute("DELETE FROM sessions WHERE token = ?", (tok,))
                conn.commit()
            conn.close()
            return send_json(self, 200, {"ok": True}, {"Set-Cookie": self.clear_cookie()})

        # --- сохранение своего прогресса ---

        if path == "/api/progress":
            row = get_session(self)
            if not row:
                raise ApiError(401, "not_authenticated")
            payload = body.get("payload")
            if payload is None:
                raise ApiError(400, "no_payload")
            if not isinstance(payload, dict):
                # Раньше массив здесь ронял обработчик (payload["_updated"]).
                raise ApiError(400, "bad_payload")

            # Защита от затирания: телефон и компьютер не должны молча
            # перезаписывать прогресс друг друга. Клиент присылает версию,
            # от которой отталкивался; если на сервере уже новее — 409
            # с серверным состоянием, клиент объединит и повторит.
            base = _as_int(body.get("base_updated"))
            existing = conn.execute(
                "SELECT payload, updated_at FROM progress WHERE user_id = ?", (row["id"],)
            ).fetchone()
            if existing and base and existing["updated_at"] > base:
                try:
                    server_payload = json.loads(existing["payload"])
                except Exception:
                    server_payload = {}
                return send_json(self, 409, {
                    "error": "conflict",
                    "payload": server_payload if isinstance(server_payload, dict) else {},
                    "updated_at": existing["updated_at"],
                })

            stamp = now()
            payload["_updated"] = stamp
            text = json.dumps(payload, ensure_ascii=False)
            if len(text) > MAX_PROGRESS_BYTES:
                raise ApiError(413, "payload_too_large")
            conn.execute(
                "INSERT INTO progress (user_id, payload, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
                (row["id"], text, stamp),
            )
            conn.commit()
            return send_json(self, 200, {"ok": True, "updated_at": stamp})

        # --- класс: коды-приглашения ---

        if path == "/api/class/invite":
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            # 4 буквы + 4 цифры: ~1.1e9 комбинаций вместо ~6.2e6.
            code = "-".join(
                [secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(4)]
                + [secrets.choice("23456789") for _ in range(4)]
            )
            note = _as_text(body.get("note"))[:60]
            conn.execute("INSERT INTO invites (code, created_by, created_at, note) VALUES (?,?,?,?)",
                         (code, row["id"], now(), note))
            conn.commit()
            conn.close()
            return send_json(self, 200, {"code": code, "note": note})

        if path == "/api/class/invites/revoke":
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            conn.execute("DELETE FROM invites WHERE code = ? AND used_by IS NULL", ((body.get("code") or "",),))
            conn.commit()
            conn.close()
            return send_json(self, 200, {"ok": True})

        # --- класс: оценка и комментарий ---

        if path == "/api/class/grade":
            actor = require_role(self, "owner", "teacher")
            sid = parse_id(body.get("student_id"))
            load_target(conn, sid, actor, "grade")
            grade = "" if body.get("grade") is None else _as_text(body.get("grade"))[:10]
            comment = "" if body.get("comment") is None else _as_text(body.get("comment"))[:400]
            conn.execute(
                "INSERT INTO grades (user_id, grade, comment, updated_at, by_user) VALUES (?,?,?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET grade = excluded.grade, comment = excluded.comment, "
                "updated_at = excluded.updated_at, by_user = excluded.by_user",
                (sid, grade, comment, now(), actor["id"]),
            )
            conn.execute("INSERT INTO events (user_id, kind, detail, created_at) VALUES (?,?,?,?)",
                         (sid, "grade_set", f"{grade} | {comment}", now()))
            conn.commit()
            return send_json(self, 200, {"ok": True})

        # --- класс: сброс прогресса ученика ---

        if path == "/api/class/reset":
            actor = require_role(self, "owner", "teacher")
            sid = parse_id(body.get("student_id"))
            load_target(conn, sid, actor, "reset")
            conn.execute("DELETE FROM progress WHERE user_id = ?", (sid,))
            conn.execute("INSERT INTO events (user_id, kind, detail, created_at) VALUES (?,?,?,?)",
                         (sid, "reset", "прогресс сброшен учителем", now()))
            conn.commit()
            return send_json(self, 200, {"ok": True})

        # --- класс: удалить ученика ---

        if path == "/api/class/delete":
            actor = require_role(self, "owner", "teacher")
            sid = parse_id(body.get("student_id"))
            target = conn.execute("SELECT id, role FROM users WHERE id = ?", (sid,)).fetchone()
            if not target:
                raise ApiError(404, "not_found")
            if target["role"] == "owner":
                raise ApiError(403, "cannot_delete_owner")
            if target["role"] == "teacher" and actor["role"] != "owner":
                raise ApiError(403, "forbidden")
            if target["id"] == actor["id"]:
                raise ApiError(400, "cannot_delete_self")
            conn.execute("DELETE FROM users WHERE id = ?", (sid,))
            conn.commit()
            return send_json(self, 200, {"ok": True})

        # --- класс: сменить роль (только владелец) ---

        if path == "/api/class/role":
            actor = require_role(self, "owner")
            sid = parse_id(body.get("user_id"))
            new_role = body.get("role")
            if new_role not in ("student", "teacher"):
                raise ApiError(400, "bad_role")
            if sid == actor["id"]:
                raise ApiError(400, "cannot_change_own_role")
            changed = conn.execute(
                "UPDATE users SET role = ? WHERE id = ? AND role != 'owner'", (new_role, sid)
            ).rowcount
            if not changed:
                raise ApiError(404, "not_found")
            conn.commit()
            return send_json(self, 200, {"ok": True})

        # --- система: запись ошибок клиента и очистка журнала ---

        if path == "/api/system/client-error":
            ip = self.client_ip()
            # Эндпоинт анонимный: без ограничения журнал ошибок засыпали бы.
            if not client_error_limiter.allowed(ip):
                raise ApiError(429, "too_many")
            client_error_limiter.fail(ip)
            row = get_session(self)
            msg = _as_text(body.get("message"))[:300]
            detail = _as_text(body.get("detail"))[:1500]
            if msg:
                record_error("client", msg, detail, row["id"] if row else None)
            return send_json(self, 200, {"ok": True})

        if path == "/api/system/errors/clear":
            row = get_session(self)
            if not row or row["role"] != "owner":
                conn.close()
                return send_json(self, 403, {"error": "owner_only"})
            conn.execute("DELETE FROM system_errors")
            conn.commit()
            conn.close()
            return send_json(self, 200, {"ok": True})

        # --- внутренний ИИ-репетитор ---

        if path == "/api/tutor/chat":
            # Раньше эндпоинт был анонимным и тратил серверный ключ ИИ:
            # теперь нужна сессия и есть квота на пользователя.
            actor = require_role(self, "owner", "teacher", "student")
            quota_key = f"user:{actor['id']}"
            if not ai_limiter.allowed(quota_key):
                raise ApiError(429, "too_many")
            msg = _as_text(body.get("message"))[:1000]
            history = body.get("history")
            if not isinstance(history, list):
                history = []
            ctx = _as_text(body.get("context"))[:400]
            api_key = os.environ.get("AI_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
            if not api_key or not msg:
                return send_json(self, 200, {"ok": True, "mode": "local"})
            base_url = (os.environ.get("AI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
            model = os.environ.get("AI_MODEL") or "gpt-4o-mini"
            sys_prompt = (
                "Ты — Сяо Мин (小明), дружелюбный ИИ-репетитор китайского языка на русскоязычной учебной платформе. "
                "Отвечай по-русски, обязательно приводи китайские иероглифы, пиньинь с тонами и перевод. "
                "Будь кратким, ясным и поддерживающим. Контекст ученика: " + str(ctx)[:400]
            )
            messages = [{"role": "system", "content": sys_prompt}]
            for h in history[-6:]:
                if isinstance(h, dict) and h.get("role") in ("user", "assistant") and h.get("content"):
                    messages.append({"role": h["role"], "content": str(h["content"])[:600]})
            messages.append({"role": "user", "content": msg})
            ai_limiter.fail(quota_key)
            try:
                req = urllib.request.Request(
                    base_url + "/chat/completions",
                    data=json.dumps({"model": model, "messages": messages, "temperature": 0.6, "max_tokens": 500}).encode("utf-8"),
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=18) as resp:
                    res_data = json.loads(resp.read().decode("utf-8"))
                reply = res_data["choices"][0]["message"]["content"].strip()
                return send_json(self, 200, {"ok": True, "mode": "ai", "reply": reply})
            except Exception as exc:
                record_error("server", f"tutor AI fallback: {exc}")
                return send_json(self, 200, {"ok": True, "mode": "local"})

        conn.close()
        return send_json(self, 404, {"error": "not_found"})

    # ---------- сессия ----------

    def start_session(self, user_id):
        token = secrets.token_urlsafe(32)
        conn = db()
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
            (token, user_id, now(), now() + SESSION_DAYS * 86400),
        )
        conn.commit()
        conn.close()
        return token

    def cookie_headers(self, token):
        return {"Set-Cookie": self._cookie(token, SESSION_DAYS * 86400)}

    def clear_cookie(self):
        return self._cookie("", 0)

    @staticmethod
    def _cookie(token, max_age):
        # Secure включается на HTTPS (SECURE_COOKIES=1): cookie не должна
        # уходить по открытому HTTP.
        parts = [f"sid={token}", "Path=/", f"Max-Age={max_age}",
                 "HttpOnly", "SameSite=Lax"]
        if SECURE_COOKIES:
            parts.append("Secure")
        return "; ".join(parts)


# ---------------- запуск ----------------

class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    init_db()
    conn = db()
    migrate(conn)
    conn.close()
    if not os.path.exists(INDEX):
        print("⚠  index.html не найден — сначала выполните: python3 build.py")
    srv = ThreadedServer((HOST, PORT), Handler)
    print(f"▶ 汉语学习 · сервер запущен: http://{HOST}:{PORT}")
    print(f"   база данных: {DB_PATH}")
    if TRUST_PROXY:
        print("   X-Forwarded-For: доверяем (за прокси). Прямой доступ в интернет? "
              "Выставите TRUST_PROXY=0")
    if not SECURE_COOKIES:
        print("   cookie без флага Secure. На HTTPS включите SECURE_COOKIES=1")
    print("   первый зарегистрировавшийся станет владельцем (учителем)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n■ остановлено")


if __name__ == "__main__":
    main()
