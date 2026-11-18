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

# ---------------- база ----------------

_db_lock = threading.Lock()


def db():
    d = os.path.dirname(os.path.abspath(DB_PATH))
    if d:
        os.makedirs(d, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


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
    conn.commit()
    conn.close()


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


def json_body(handler):
    length = int(handler.headers.get("Content-Length") or 0)
    if not length:
        return {}
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def send_json(handler, code, obj, extra_headers=None):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    send_cors(handler)
    for k, v in (extra_headers or {}).items():
        handler.send_header(k, v)
    handler.end_headers()
    handler.wfile.write(body)


def send_cors(handler):
    """CORS: приложение может быть открыто в iframe с непрозрачным origin (origin: null)."""
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    handler.send_header("Access-Control-Max-Age", "86400")
    handler.send_header("Vary", "Origin")


# ---------------- сессии ----------------

_rate_lock = threading.Lock()
_rate = {}  # ip -> (fails, until_ts)


def rate_ok(ip):
    with _rate_lock:
        fails, until = _rate.get(ip, (0, 0))
        if until and now() < until:
            return False
        if until and now() >= until:
            _rate[ip] = (0, 0)
    return True


def rate_fail(ip):
    with _rate_lock:
        fails, until = _rate.get(ip, (0, 0))
        fails += 1
        if fails >= 8:
            until = now() + 300
            fails = 0
        _rate[ip] = (fails, until)


def rate_reset(ip):
    with _rate_lock:
        _rate.pop(ip, None)


def get_session(handler):
    # 1) Authorization: Bearer <token>  (нужно для iframe с непрозрачным origin)
    token = None
    auth_hdr = handler.headers.get("Authorization") or ""
    if auth_hdr.lower().startswith("bearer "):
        token = auth_hdr[7:].strip()
    # 2) cookie sid (обычный браузер)
    if not token:
        cookie = handler.headers.get("Cookie") or ""
        m = re.search(r"(?:^|;\s*)sid=([A-Za-z0-9_\-]+)", cookie)
        if m:
            token = m.group(1)
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
    """Считает сводные показатели из JSON-прогресса ученика."""
    payload = payload or {}
    lessons = payload.get("lessons") or {}
    cards = payload.get("cards") or {}
    days = payload.get("days") or []
    quiz_log = payload.get("quizLog") or []
    right = int(payload.get("totalRight") or 0)
    wrong = int(payload.get("totalWrong") or 0)
    total = right + wrong
    done = [k for k, v in lessons.items() if isinstance(v, dict) and v.get("done")]
    scores = [float(v.get("score") or 0) for v in lessons.values() if isinstance(v, dict)]
    best = {}
    for k, v in lessons.items():
        if isinstance(v, dict) and v.get("score") is not None:
            best[k] = round(float(v.get("score") or 0) * 100)
    avg_score = round(sum(scores) / len(scores) * 100) if scores else 0
    accuracy = round(right / total * 100) if total else 0
    active_today = bool(days) and days[-1] == time.strftime("%Y-%m-%d")
    return {
        "lessons_done": len(done),
        "lessons_total": 15,
        "avg_score": avg_score,
        "accuracy": accuracy,
        "answers": total,
        "cards": len(cards),
        "streak": int(payload.get("streak") or 0),
        "days_active": len(days),
        "active_today": active_today,
        "quizzes": len(quiz_log),
        "lesson_scores": best,
        "updated_at": payload.get("_updated") or 0,
    }


# ---------------- обработчик ----------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ChineseApp/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[{self.client_ip()}] {fmt % args}", flush=True)

    # ---------- утилиты ----------

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[0].strip()
        return self.client_address[0]

    def send_html(self, code, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        send_cors(self)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, path):
        self.send_response(302)
        self.send_header("Location", path)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- маршрутизация ----------

    def do_OPTIONS(self):
        self.send_response(204)
        send_cors(self)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            query = urllib.parse.parse_qs(parsed.query)
            if path.startswith("/api/"):
                return self.api_get(path, query)
            return self.serve_app()
        except Exception as exc:
            record_error("server", f"GET {self.path}: {exc}", traceback.format_exc())
            return send_json(self, 500, {"error": "server_error"})

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if path.startswith("/api/"):
                return self.api_post(path)
            return self.serve_app()
        except Exception as exc:
            record_error("server", f"POST {self.path}: {exc}", traceback.format_exc())
            return send_json(self, 500, {"error": "server_error"})

    def do_PUT(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.startswith("/api/"):
                return self.api_post(parsed.path)
            return self.serve_app()
        except Exception as exc:
            record_error("server", f"PUT {self.path}: {exc}", traceback.format_exc())
            return send_json(self, 500, {"error": "server_error"})

    def do_DELETE(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.startswith("/api/"):
                return self.api_post(parsed.path)
            return self.serve_app()
        except Exception as exc:
            record_error("server", f"DELETE {self.path}: {exc}", traceback.format_exc())
            return send_json(self, 500, {"error": "server_error"})

    # ---------- статика ----------

    def serve_app(self):
        try:
            with open(INDEX, "rb") as f:
                body = f.read()
        except OSError:
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
                        r["display_name"], r["username"], f"{s['lessons_done']}/{s['lessons_total']}",
                        s["avg_score"], f"{s['accuracy']}%", s["cards"], s["streak"],
                        r["grade"] or "", r["comment"] or "",
                        time.strftime("%Y-%m-%d %H:%M", time.localtime(last)) if last else "",
                        time.strftime("%Y-%m-%d", time.localtime(r["created_at"])),
                    ]
                )
            data = buf.getvalue().encode("utf-8-sig")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="klass.csv"')
            self.send_header("Content-Length", str(len(data)))
            send_cors(self)
            self.end_headers()
            self.wfile.write(data)
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
            send_cors(self)
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
            code = (body.get("code") or "").strip().upper()
            display_name = (body.get("display_name") or "").strip()[:40]
            username = slugify(body.get("username") or display_name)
            password = body.get("password") or ""

            if len(display_name) < 2:
                conn.close()
                return send_json(self, 400, {"error": "name_required"})
            if len(password) < 4:
                conn.close()
                return send_json(self, 400, {"error": "weak_password"})

            users_count = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
            inv = conn.execute("SELECT * FROM invites WHERE code = ?", (code,)).fetchone()

            if users_count == 0:
                # самый первый пользователь — владелец
                role = "owner"
            elif inv and inv["used_by"] is None:
                role = "student"
            else:
                conn.close()
                return send_json(self, 403, {"error": "bad_invite"})

            base, suffix = username, ""
            i = 1
            while conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
                username = f"{base}{i}"
                i += 1
                if i > 99:
                    conn.close()
                    return send_json(self, 409, {"error": "username_busy"})

            salt = make_salt()
            cur = conn.execute(
                "INSERT INTO users (username, display_name, role, pass_hash, salt, created_at) VALUES (?,?,?,?,?,?)",
                (username, display_name, role, hash_pw(password, salt), salt, now()),
            )
            uid = cur.lastrowid
            if inv:
                conn.execute("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?", (uid, now(), code))
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
            log_event(uid, "register", f"role={role}")
            token = self.start_session(uid)
            conn.close()
            return send_json(self, 200, {"user": user_json(row), "token": token}, self.cookie_headers(token))

        # --- вход ---

        if path == "/api/auth/login":
            ip = self.client_ip()
            if not rate_ok(ip):
                conn.close()
                return send_json(self, 429, {"error": "too_many"})
            username = (body.get("username") or "").strip().lstrip("@")
            password = body.get("password") or ""
            row = conn.execute(
                "SELECT * FROM users WHERE LOWER(username) = LOWER(?)", (username,)
            ).fetchone()
            if not row and username:
                low = username.lower()
                all_u = conn.execute("SELECT * FROM users").fetchall()
                matches = [u for u in all_u if u["display_name"].strip().lower() == low or u["username"].lower() == low]
                if len(matches) == 1:
                    row = matches[0]
            if not row or not row["active"] or not hmac.compare_digest(
                row["pass_hash"], hash_pw(password, row["salt"])
            ):
                rate_fail(ip)
                conn.close()
                return send_json(self, 401, {"error": "bad_credentials"})
            rate_reset(ip)
            conn.execute("UPDATE users SET last_login = ? WHERE id = ?", (now(), row["id"]))
            conn.commit()
            token = self.start_session(row["id"])
            conn.close()
            log_event(row["id"], "login")
            return send_json(self, 200, {"user": user_json(row), "token": token}, self.cookie_headers(token))

        if path == "/api/auth/logout":
            tok = None
            auth_hdr = self.headers.get("Authorization") or ""
            if auth_hdr.lower().startswith("bearer "):
                tok = auth_hdr[7:].strip()
            if not tok:
                cookie = self.headers.get("Cookie") or ""
                m = re.search(r"(?:^|;\s*)sid=([A-Za-z0-9_\-]+)", cookie)
                if m:
                    tok = m.group(1)
            if tok:
                conn.execute("DELETE FROM sessions WHERE token = ?", (tok,))
                conn.commit()
            conn.close()
            return send_json(self, 200, {"ok": True}, {"Set-Cookie": "sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"})

        # --- сохранение своего прогресса ---

        if path == "/api/progress":
            row = get_session(self)
            if not row:
                conn.close()
                return send_json(self, 401, {"error": "not_authenticated"})
            payload = body.get("payload")
            if payload is None:
                conn.close()
                return send_json(self, 400, {"error": "no_payload"})
            payload["_updated"] = now()
            text = json.dumps(payload, ensure_ascii=False)
            conn.execute(
                "INSERT INTO progress (user_id, payload, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
                (row["id"], text, now()),
            )
            conn.commit()
            conn.close()
            return send_json(self, 200, {"ok": True, "updated_at": now()})

        # --- класс: коды-приглашения ---

        if path == "/api/class/invite":
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            code = "-".join(
                [secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(3)]
                + [secrets.choice("23456789") for _ in range(3)]
            )
            note = (body.get("note") or "").strip()[:60]
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
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            sid = int(body.get("student_id") or 0)
            grade = (str(body.get("grade"))[:10] if body.get("grade") is not None else "")
            comment = (str(body.get("comment"))[:400] if body.get("comment") is not None else "")
            conn.execute(
                "INSERT INTO grades (user_id, grade, comment, updated_at, by_user) VALUES (?,?,?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET grade = excluded.grade, comment = excluded.comment, "
                "updated_at = excluded.updated_at, by_user = excluded.by_user",
                (sid, grade, comment, now(), row["id"]),
            )
            conn.execute("INSERT INTO events (user_id, kind, detail, created_at) VALUES (?,?,?,?)",
                         (sid, "grade_set", f"{grade} | {comment}", now()))
            conn.commit()
            conn.close()
            return send_json(self, 200, {"ok": True})

        # --- класс: сброс прогресса ученика ---

        if path == "/api/class/reset":
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            sid = int(body.get("student_id") or 0)
            conn.execute("DELETE FROM progress WHERE user_id = ?", (sid,))
            conn.execute("INSERT INTO events (user_id, kind, detail, created_at) VALUES (?,?,?,?)",
                         (sid, "reset", "прогресс сброшен учителем", now()))
            conn.commit()
            conn.close()
            return send_json(self, 200, {"ok": True})

        # --- класс: удалить ученика ---

        if path == "/api/class/delete":
            row = get_session(self)
            if not row or row["role"] not in ("owner", "teacher"):
                conn.close()
                return send_json(self, 403, {"error": "forbidden"})
            sid = int(body.get("student_id") or 0)
            target = conn.execute("SELECT * FROM users WHERE id = ?", (sid,)).fetchone()
            if not target:
                conn.close()
                return send_json(self, 404, {"error": "not_found"})
            if target["role"] == "owner":
                conn.close()
                return send_json(self, 403, {"error": "cannot_delete_owner"})
            conn.execute("DELETE FROM users WHERE id = ?", (sid,))
            conn.commit()
            conn.close()
            return send_json(self, 200, {"ok": True})

        # --- класс: сменить роль (только владелец) ---

        if path == "/api/class/role":
            row = get_session(self)
            if not row or row["role"] != "owner":
                conn.close()
                return send_json(self, 403, {"error": "owner_only"})
            sid = int(body.get("user_id") or 0)
            new_role = body.get("role")
            if new_role not in ("student", "teacher"):
                conn.close()
                return send_json(self, 400, {"error": "bad_role"})
            conn.execute("UPDATE users SET role = ? WHERE id = ? AND role != 'owner'", (new_role, sid))
            conn.commit()
            conn.close()
            return send_json(self, 200, {"ok": True})

        # --- система: запись ошибок клиента и очистка журнала ---

        if path == "/api/system/client-error":
            row = get_session(self)
            msg = (body.get("message") or "").strip()
            detail = (body.get("detail") or "").strip()
            conn.close()
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
        return {
            "Set-Cookie": f"sid={token}; Path=/; Max-Age={SESSION_DAYS*86400}; HttpOnly; SameSite=Lax"
        }


# ---------------- запуск ----------------

class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    init_db()
    if not os.path.exists(INDEX):
        print("⚠  index.html не найден — сначала выполните: python3 build.py")
    srv = ThreadedServer((HOST, PORT), Handler)
    print(f"▶ 汉语学习 · сервер запущен: http://{HOST}:{PORT}")
    print(f"   база данных: {DB_PATH}")
    print("   первый зарегистрировавшийся станет владельцем (учителем)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n■ остановлено")


if __name__ == "__main__":
    main()
