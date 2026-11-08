"""SQLite-backed counselor service. Run behind HTTPS for network access."""
import argparse
import base64
import binascii
import getpass
import hashlib
import hmac
import json
import os
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import secrets
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit

from admin_reports import DEFAULT_AREAS, area_catalog, report_data, report_workbook

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "work-report"
KST = timezone(timedelta(hours=9))
TYPES = {"최초 방문", "재방문", "단순 업데이트"}
RESULTS = {"상담 완료", "부재", "방문 거절", "기타"}
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/demo.html": ("demo.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/admin": ("admin.html", "text/html; charset=utf-8"),
    "/admin/": ("admin.html", "text/html; charset=utf-8"),
    "/admin.html": ("admin.html", "text/html; charset=utf-8"),
    "/admin.js": ("admin.js", "text/javascript; charset=utf-8"),
    "/admin.css": ("admin.css", "text/css; charset=utf-8"),
}


@contextmanager
def database(path):
    with closing(sqlite3.connect(path, timeout=10)) as db, db:
        db.execute("PRAGMA foreign_keys=ON")
        yield db


def initialize(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with database(path) as db:
        db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS users(
                username TEXT PRIMARY KEY, name TEXT NOT NULL,
                salt BLOB NOT NULL, password BLOB NOT NULL,
                role TEXT NOT NULL DEFAULT 'counselor' CHECK(role IN ('counselor','admin')),
                areas TEXT NOT NULL DEFAULT 'a,b,c'
            );
            CREATE TABLE IF NOT EXISTS sessions(
                token TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username),
                expires INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS entries(
                username TEXT NOT NULL REFERENCES users(username), request_id TEXT NOT NULL,
                body TEXT NOT NULL, PRIMARY KEY(username, request_id)
            );
            CREATE TABLE IF NOT EXISTS areas(
                id TEXT PRIMARY KEY, name TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS active_area_name
                ON areas(name COLLATE NOCASE) WHERE active=1;
        """)
        db.execute("BEGIN IMMEDIATE")
        columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
        if "role" not in columns:
            db.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'counselor' "
                       "CHECK(role IN ('counselor','admin'))")
        if "areas" not in columns:
            db.execute("ALTER TABLE users ADD COLUMN areas TEXT NOT NULL DEFAULT 'a,b,c'")
        if not db.execute("SELECT 1 FROM areas LIMIT 1").fetchone():
            db.executemany("INSERT INTO areas(id, name) VALUES (?, ?)", DEFAULT_AREAS.items())


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)


def checked_areas(db, selected, required=False):
    active = area_catalog(db, active_only=True)
    if not isinstance(selected, list) or (required and not selected):
        raise ValueError("담당 구역을 하나 이상 선택해 주세요.")
    if any(not isinstance(key, str) or key not in active for key in selected):
        raise ValueError("현재 사용 중인 구역을 선택해 주세요.")
    return ",".join(dict.fromkeys(selected))


def assigned_areas(db, stored):
    active = area_catalog(db, active_only=True)
    return {key: active[key] for key in stored.split(",") if key in active}


def add_user(path, username, name, password, role="counselor", areas=None):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{3,48}", username) or not 1 <= len(name.strip()) <= 80:
        raise ValueError("아이디는 영문·숫자·밑줄·점·하이픈 3~48자, 이름은 1~80자로 입력해 주세요.")
    if not 5 <= len(password) <= 12:
        raise ValueError("비밀번호는 5~12자로 입력해 주세요.")
    salt = secrets.token_bytes(16)
    hashed = password_hash(password, salt)
    with database(path) as db:
        db.execute("BEGIN IMMEDIATE")
        if areas is None:
            areas = list(area_catalog(db, active_only=True)) if role == "counselor" else []
        assigned = checked_areas(db, areas, required=role == "counselor")
        db.execute("INSERT INTO users(username, name, salt, password, role, areas) VALUES (?, ?, ?, ?, ?, ?)",
                   (username, name.strip(), salt, hashed, role, assigned))


def read_field(data, key, limit=200, required=False):
    value = data.get(key, "")
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError("입력값을 확인해 주세요.")
    return value.strip()


def validate_entry(data):
    date = read_field(data, "date", 10, True)
    area = read_field(data, "area", 16, True)
    kind = read_field(data, "type", 24, True)
    result = read_field(data, "result", 24)
    if date != datetime.now(KST).date().isoformat() or kind not in TYPES:
        raise ValueError("오늘 날짜, 구역, 활동 유형을 확인해 주세요.")
    if (kind == "단순 업데이트" and result) or (kind != "단순 업데이트" and result not in RESULTS):
        raise ValueError("방문 결과를 확인해 주세요.")
    entry = {k: read_field(data, k) for k in (
        "unit", "homePhone", "mobilePhone", "postcode", "residentAddress", "addressDetail",
        "follow", "followDate", "preference",
    )}
    entry.update(date=date, area=area, type=kind, result=result,
                 address=read_field(data, "address", required=True),
                 owner=read_field(data, "owner", required=True))
    for key in ("consent", "privacy", "identity", "other"):
        if not isinstance(data.get(key), bool):
            raise ValueError("서류 징구 여부를 확인해 주세요.")
        entry[key] = data[key]
    entry["otherDocument"] = read_field(data, "otherDocument", required=True) if entry["other"] else ""
    entry["resultOther"] = read_field(data, "resultOther", required=True) if result == "기타" else ""
    for key in ("notes", "changesItems"):
        items = data.get(key, [])
        if not isinstance(items, list) or len(items) > 100:
            raise ValueError("기록 항목을 확인해 주세요.")
        entry[key] = []
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("기록 항목을 확인해 주세요.")
            entry[key].append({"text": read_field(item, "text", 3000, True),
                               "at": int(time.time() * 1000)})
    attachments = data.get("attachments", [])
    if not isinstance(attachments, list) or len(attachments) > 5:
        raise ValueError("사진은 최대 5장까지 첨부할 수 있습니다.")
    entry["attachments"] = []
    for item in attachments:
        if not isinstance(item, dict):
            raise ValueError("사진 형식을 확인해 주세요.")
        source = read_field(item, "data", 390_000, True)
        if not re.fullmatch(r"data:image/(png|jpeg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/=]+", source):
            raise ValueError("사진 형식을 확인해 주세요.")
        try:
            base64.b64decode(source.split(",", 1)[1], validate=True)
        except binascii.Error as exc:
            raise ValueError("사진을 읽을 수 없습니다.") from exc
        entry["attachments"].append({"name": read_field(item, "name", 240, True), "data": source})
    return entry


def user_entries(db, username):
    return [json.loads(row[0]) for row in db.execute(
        "SELECT body FROM entries WHERE username=? ORDER BY rowid", (username,)
    )]


class Handler(BaseHTTPRequestHandler):
    def send_content(self, status, mime, body, cookie=None, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, body, cookie=None):
        self.send_content(status, "application/json; charset=utf-8",
                          json.dumps(body, ensure_ascii=False).encode(), cookie)

    def cookie(self, token, max_age=None):
        lifetime = f"; Max-Age={max_age}" if max_age is not None else ""
        secure = "; Secure" if self.server.secure_cookie else ""
        return f"work_session={token}; Path=/; HttpOnly; SameSite=Strict{lifetime}{secure}"

    def session_hash(self):
        jar = SimpleCookie()
        jar.load(self.headers.get("Cookie", ""))
        token = jar.get("work_session")
        return hashlib.sha256(token.value.encode()).hexdigest() if token else ""

    def current_user(self, db):
        return db.execute(
            """SELECT u.username, u.name, u.role, u.areas FROM sessions s JOIN users u USING(username)
               WHERE s.token=? AND s.expires>?""",
            (self.session_hash(), int(time.time())),
        ).fetchone()

    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        if path in ASSETS:
            file, mime = ASSETS[path]
            self.send_content(200, mime, (ROOT / file).read_bytes())
            return
        if path == "/api/entries":
            with database(self.server.db_path) as db:
                user = self.current_user(db)
                if user and user[2] == "counselor":
                    areas = assigned_areas(db, user[3])
                    self.send_json(200, {"name": user[1], "areas": list(areas), "areaNames": areas,
                                         "entries": user_entries(db, user[0])})
                else:
                    self.send_json(401, {"error": "로그인이 필요합니다."})
            return
        if path in ("/api/admin/reports", "/api/admin/export"):
            self.admin_report(path, url.query)
            return
        if path == "/api/admin/photo":
            self.admin_photo(url.query)
            return
        self.send_json(404, {"error": "페이지를 찾을 수 없습니다."})

    def require_admin(self, db):
        user = self.current_user(db)
        if not user:
            self.send_json(401, {"error": "관리자 로그인이 필요합니다."})
        elif user[2] != "admin":
            self.send_json(403, {"error": "관리자 계정으로 로그인해 주세요."})
        else:
            return user
        return None

    def admin_report(self, path, query):
        try:
            with database(self.server.db_path) as db:
                db.execute("BEGIN")
                user = self.require_admin(db)
                if not user:
                    return
                report = report_data(db, parse_qs(query, max_num_fields=8),
                                     datetime.now(KST).date().isoformat())
            if path.endswith("/export"):
                filters = report["filters"]
                filename = f"work-report-{filters['start']}-{filters['end']}.xlsx"
                self.send_content(200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                  report_workbook(report), filename=filename)
            else:
                self.send_json(200, {"name": user[1], **report})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except sqlite3.Error:
            self.send_json(503, {"error": "보고서를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."})

    def admin_photo(self, query):
        try:
            with database(self.server.db_path) as db:
                if not self.require_admin(db):
                    return
                params = parse_qs(query, max_num_fields=3)
                username = params.get("counselor", [""])[0]
                request_id = params.get("report", [""])[0]
                index = params.get("photo", [""])[0]
                row = db.execute("SELECT body FROM entries WHERE username=? AND request_id=?",
                                 (username, request_id)).fetchone()
            if row and index in "01234" and len(index) == 1:
                photos = json.loads(row[0]).get("attachments", [])
                if int(index) < len(photos):
                    source = photos[int(index)]["data"]
                    prefix, encoded = source.split(",", 1)
                    mime = prefix.removeprefix("data:").removesuffix(";base64")
                    if mime in {"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"}:
                        self.send_content(200, mime, base64.b64decode(encoded, validate=True))
                        return
        except (ValueError, sqlite3.Error):
            pass
        self.send_json(404, {"error": "첨부 사진을 찾을 수 없습니다."})

    def do_POST(self):
        if self.headers.get("X-Work-Report") != "1" or self.headers.get_content_type() != "application/json":
            self.send_json(403, {"error": "허용되지 않은 요청입니다."})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 2_200_000:
                raise ValueError("요청 크기를 확인해 주세요.")
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError("입력값을 확인해 주세요.")
            path = urlsplit(self.path).path
            if path in ("/api/login", "/api/admin/login"):
                self.login(data, "admin" if path.startswith("/api/admin/") else "counselor")
            elif path == "/api/logout":
                with database(self.server.db_path) as db:
                    db.execute("DELETE FROM sessions WHERE token=?", (self.session_hash(),))
                self.send_json(200, {}, self.cookie("", 0))
            elif path == "/api/entries":
                self.save_entry(data)
            elif path == "/api/admin/counselors":
                with database(self.server.db_path) as db:
                    if not self.require_admin(db):
                        return
                username = read_field(data, "username", 48, True)
                name = read_field(data, "name", 80, True)
                password = data.get("password")
                if not isinstance(password, str):
                    raise ValueError("비밀번호를 확인해 주세요.")
                try:
                    add_user(self.server.db_path, username, name, password, areas=data.get("areas", []))
                except sqlite3.IntegrityError:
                    self.send_json(409, {"error": "이미 사용 중인 아이디입니다."})
                    return
                self.send_json(201, {"username": username, "name": name})
            elif path in ("/api/admin/areas", "/api/admin/areas/delete", "/api/admin/counselors/areas"):
                self.change_areas(path, data)
            else:
                self.send_json(404, {"error": "페이지를 찾을 수 없습니다."})
        except (ValueError, UnicodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except sqlite3.Error:
            self.send_json(503, {"error": "저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."})

    def change_areas(self, path, data):
        with database(self.server.db_path) as db:
            db.execute("BEGIN IMMEDIATE")
            if not self.require_admin(db):
                return
            if path == "/api/admin/areas":
                name = " ".join(read_field(data, "name", 80, True).split())
                if db.execute("SELECT 1 FROM areas WHERE active=1 AND name=? COLLATE NOCASE", (name,)).fetchone():
                    self.send_json(409, {"error": "이미 사용 중인 구역 이름입니다."})
                    return
                key = secrets.token_hex(8)
                db.execute("INSERT INTO areas(id, name) VALUES (?, ?)", (key, name))
                result = (201, {"id": key, "name": name})
            elif path == "/api/admin/areas/delete":
                key = read_field(data, "id", 16, True)
                if not db.execute("UPDATE areas SET active=0 WHERE id=? AND active=1", (key,)).rowcount:
                    self.send_json(404, {"error": "사용 중인 구역을 찾을 수 없습니다."})
                    return
                affected = db.execute("SELECT username, areas FROM users WHERE role='counselor'").fetchall()
                for username, stored in affected:
                    assigned = stored.split(",")
                    if key in assigned:
                        db.execute("UPDATE users SET areas=? WHERE username=?",
                                   (",".join(area for area in assigned if area != key), username))
                result = (200, {})
            else:
                username = read_field(data, "username", 48, True)
                assigned = checked_areas(db, data.get("areas"))
                if not db.execute("UPDATE users SET areas=? WHERE username=? AND role='counselor'",
                                  (assigned, username)).rowcount:
                    self.send_json(404, {"error": "상담사 계정을 찾을 수 없습니다."})
                    return
                result = (200, {})
        self.send_json(*result)

    def login(self, data, role):
        username = read_field(data, "username", 48, True)
        password = data.get("password")
        if not isinstance(password, str) or not 5 <= len(password) <= 12:
            raise ValueError("비밀번호는 5~12자로 입력해 주세요.")
        with database(self.server.db_path) as db:
            user = db.execute("SELECT name, salt, password, role, areas FROM users WHERE username=?",
                              (username,)).fetchone()
            expected = user[2] if user else bytes(64)
            salt = user[1] if user else bytes(16)
            if not hmac.compare_digest(expected, password_hash(password, salt)) or not user or user[3] != role:
                self.send_json(401, {"error": "아이디 또는 비밀번호를 확인해 주세요."})
                return
            now = int(time.time())
            remember = data.get("remember") is True
            lifetime = 7 * 86400 if remember else 12 * 3600
            token = secrets.token_urlsafe(32)
            db.execute("DELETE FROM sessions WHERE expires<=? OR token=?", (now, self.session_hash()))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)",
                       (hashlib.sha256(token.encode()).hexdigest(), username, now + lifetime))
            entries = user_entries(db, username) if role == "counselor" else []
            areas = assigned_areas(db, user[4])
        self.send_json(200, {"name": user[0], "entries": entries, "areas": list(areas), "areaNames": areas},
                       self.cookie(token, lifetime if remember else None))

    def save_entry(self, data):
        with database(self.server.db_path) as db:
            db.execute("BEGIN IMMEDIATE")
            user = self.current_user(db)
            if not user:
                self.send_json(401, {"error": "다시 로그인해 주세요."})
                return
            if user[2] != "counselor":
                self.send_json(403, {"error": "상담사 계정으로 로그인해 주세요."})
                return
            request_id = read_field(data, "requestId", 100, True)
            username = user[0]
            entries = user_entries(db, username)
            if db.execute("SELECT 1 FROM entries WHERE username=? AND request_id=?",
                          (username, request_id)).fetchone():
                self.send_json(200, {"entries": entries})
                return
            entry = validate_entry(data)
            if entry["area"] not in assigned_areas(db, user[3]):
                self.send_json(403, {"error": "담당 구역에만 활동을 기록할 수 있습니다."})
                return
            target = read_field(data, "targetId", 100)
            previous = next((x for x in reversed(entries) if x["targetId"] == target), None)
            if target and (previous is None or previous["area"] != entry["area"]):
                raise ValueError("선택한 기존 대상을 다시 확인해 주세요.")
            entry.update(targetId=target or secrets.token_hex(16), createdAt=int(time.time() * 1000),
                         previousConsent=bool(previous and previous["consent"]))
            db.execute("INSERT INTO entries VALUES (?, ?, ?)",
                       (username, request_id, json.dumps(entry, ensure_ascii=False)))
            entries.append(entry)
        self.send_json(201, {"entries": entries})


def make_server(path, port, secure_cookie=False):
    initialize(path)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.db_path = path
    server.secure_cookie = secure_cookie
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DATA_DIR / "work-report.sqlite3")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("add-user", "add-admin"):
        create = commands.add_parser(command)
        create.add_argument("username")
        create.add_argument("name")
    run = commands.add_parser("serve")
    run.add_argument("--port", type=int, default=8766)
    run.add_argument("--secure-cookie", action="store_true")
    args = parser.parse_args()
    if args.command in ("add-user", "add-admin"):
        initialize(args.db)
        role = "admin" if args.command == "add-admin" else "counselor"
        password = getpass.getpass("비밀번호: ")
        if password != getpass.getpass("비밀번호 확인: "):
            parser.error("비밀번호가 일치하지 않습니다.")
        try:
            add_user(args.db, args.username, args.name, password, role)
        except (ValueError, sqlite3.IntegrityError) as exc:
            parser.error(str(exc))
        print(("관리자" if role == "admin" else "상담사") + " 계정을 만들었습니다.")
        return
    with make_server(args.db, args.port, args.secure_cookie) as server:
        print(f"http://127.0.0.1:{args.port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()

