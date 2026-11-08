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
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "work-report"
KST = timezone(timedelta(hours=9))
AREAS = {"a", "b", "c"}
TYPES = {"최초 방문", "재방문", "단순 업데이트"}
RESULTS = {"상담 완료", "부재", "방문 거절", "기타"}
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/demo.html": ("demo.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
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
                salt BLOB NOT NULL, password BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions(
                token TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username),
                expires INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS entries(
                username TEXT NOT NULL REFERENCES users(username), request_id TEXT NOT NULL,
                body TEXT NOT NULL, PRIMARY KEY(username, request_id)
            );
        """)


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)


def add_user(path, username, name, password):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{3,48}", username) or not name.strip():
        raise ValueError("아이디는 영문·숫자·밑줄·점·하이픈 3~48자, 이름은 필수입니다.")
    if not 12 <= len(password) <= 128:
        raise ValueError("비밀번호는 12~128자로 입력해 주세요.")
    salt = secrets.token_bytes(16)
    with database(path) as db:
        db.execute("INSERT INTO users VALUES (?, ?, ?, ?)",
                   (username, name.strip(), salt, password_hash(password, salt)))


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
    if date != datetime.now(KST).date().isoformat() or area not in AREAS or kind not in TYPES:
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
    def send_content(self, status, mime, body, cookie=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin")
        if cookie:
            self.send_header("Set-Cookie", cookie)
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
            """SELECT u.username, u.name FROM sessions s JOIN users u USING(username)
               WHERE s.token=? AND s.expires>?""",
            (self.session_hash(), int(time.time())),
        ).fetchone()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ASSETS:
            file, mime = ASSETS[path]
            self.send_content(200, mime, (ROOT / file).read_bytes())
            return
        if path == "/api/entries":
            with database(self.server.db_path) as db:
                user = self.current_user(db)
                if user:
                    self.send_json(200, {"name": user[1], "entries": user_entries(db, user[0])})
                else:
                    self.send_json(401, {"error": "로그인이 필요합니다."})
            return
        self.send_json(404, {"error": "페이지를 찾을 수 없습니다."})

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
            if path == "/api/login":
                self.login(data)
            elif path == "/api/logout":
                with database(self.server.db_path) as db:
                    db.execute("DELETE FROM sessions WHERE token=?", (self.session_hash(),))
                self.send_json(200, {}, self.cookie("", 0))
            elif path == "/api/entries":
                self.save_entry(data)
            else:
                self.send_json(404, {"error": "페이지를 찾을 수 없습니다."})
        except (ValueError, UnicodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except sqlite3.Error:
            self.send_json(503, {"error": "저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."})

    def login(self, data):
        username = read_field(data, "username", 48, True)
        password = data.get("password")
        if not isinstance(password, str) or not 1 <= len(password) <= 128:
            raise ValueError("비밀번호를 확인해 주세요.")
        with database(self.server.db_path) as db:
            user = db.execute("SELECT name, salt, password FROM users WHERE username=?",
                              (username,)).fetchone()
            expected = user[2] if user else bytes(64)
            salt = user[1] if user else bytes(16)
            if not hmac.compare_digest(expected, password_hash(password, salt)) or not user:
                self.send_json(401, {"error": "아이디 또는 비밀번호를 확인해 주세요."})
                return
            now = int(time.time())
            remember = data.get("remember") is True
            lifetime = 7 * 86400 if remember else 12 * 3600
            token = secrets.token_urlsafe(32)
            db.execute("DELETE FROM sessions WHERE expires<=? OR token=?", (now, self.session_hash()))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)",
                       (hashlib.sha256(token.encode()).hexdigest(), username, now + lifetime))
            entries = user_entries(db, username)
        self.send_json(200, {"name": user[0], "entries": entries},
                       self.cookie(token, lifetime if remember else None))

    def save_entry(self, data):
        with database(self.server.db_path) as db:
            db.execute("BEGIN IMMEDIATE")
            user = self.current_user(db)
            if not user:
                self.send_json(401, {"error": "다시 로그인해 주세요."})
                return
            request_id = read_field(data, "requestId", 100, True)
            username = user[0]
            entries = user_entries(db, username)
            if db.execute("SELECT 1 FROM entries WHERE username=? AND request_id=?",
                          (username, request_id)).fetchone():
                self.send_json(200, {"entries": entries})
                return
            entry = validate_entry(data)
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
    create = commands.add_parser("add-user")
    create.add_argument("username")
    create.add_argument("name")
    run = commands.add_parser("serve")
    run.add_argument("--port", type=int, default=8766)
    run.add_argument("--secure-cookie", action="store_true")
    args = parser.parse_args()
    if args.command == "add-user":
        initialize(args.db)
        password = getpass.getpass("비밀번호: ")
        if password != getpass.getpass("비밀번호 확인: "):
            parser.error("비밀번호가 일치하지 않습니다.")
        try:
            add_user(args.db, args.username, args.name, password)
        except (ValueError, sqlite3.IntegrityError) as exc:
            parser.error(str(exc))
        print("상담사 계정을 만들었습니다.")
        return
    with make_server(args.db, args.port, args.secure_cookie) as server:
        print(f"http://127.0.0.1:{args.port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()

