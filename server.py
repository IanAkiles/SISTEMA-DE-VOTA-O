#!/usr/bin/env python3
"""Same-origin voting HTTP server. Run ``python3 server.py --help`` for options."""
import argparse
from collections import defaultdict, deque
import csv
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
from urllib.parse import urlsplit

from voting.catalog import TOPICS, TOPIC_IDS
from voting.store import SESSION_SECONDS, VOTER_SECONDS, Store, canonical_matricula

ROOT = Path(__file__).resolve().parent
MAX_JSON_BYTES = 16 * 1024
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/metricas": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/config.js": ("config.js", "application/javascript; charset=utf-8"),
    "/supabase-backend.mjs": ("supabase-backend.mjs", "application/javascript; charset=utf-8"),
    "/model.mjs": ("model.mjs", "application/javascript; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}


class APIError(Exception):
    def __init__(self, status, message, **extra):
        self.status = status
        self.payload = {"error": message, **extra}


class LoginLimiter:
    """A per-address window, guarded across the server's worker threads."""
    def __init__(self):
        self.attempts = defaultdict(deque)
        self.lock = threading.Lock()

    def attempt(self, address, check_password):
        # Password checking stays inside the lock so simultaneous requests cannot
        # bypass the attempt budget before failures are recorded.
        now = time.monotonic()
        with self.lock:
            failures = self.attempts[address]
            while failures and now - failures[0] >= 60:
                failures.popleft()
            if len(failures) >= 5:
                return False, max(1, math.ceil(60 - (now - failures[0])))
            if check_password():
                self.attempts.pop(address, None)
                return True, 0
            failures.append(now)
            return False, 0


class VotingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address


class Handler(BaseHTTPRequestHandler):
    server_version = "Vota/1.0"
    sys_version = ""

    def log_message(self, format, *args):
        # Avoid logging request paths, cookies or submitted credentials.
        return

    @property
    def store(self):
        return self.server.store

    def respond(self, status, payload, content_type="application/json; charset=utf-8", headers=None):
        if isinstance(payload, dict):
            payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(payload)

    def cookie(self, name):
        try:
            parsed = SimpleCookie(self.headers.get("Cookie", ""))
            return parsed[name].value if name in parsed else None
        except CookieError:
            return None

    def set_cookie(self, name, token, lifetime):
        cookie = SimpleCookie()
        cookie[name] = token
        cookie[name]["httponly"] = True
        cookie[name]["samesite"] = "Lax"
        cookie[name]["path"] = "/"
        cookie[name]["max-age"] = lifetime
        if self.server.secure_cookies:
            cookie[name]["secure"] = True
        return cookie.output(header="").strip()

    def require_admin(self):
        if not self.store.authenticated(self.cookie("admin_session")):
            raise APIError(401, "Entre com a senha administrativa para continuar.")

    def json_body(self, allow_empty=False):
        expected_origin = ("https" if self.server.secure_cookies else "http") + "://" + self.headers.get("Host", "")
        if self.headers.get("Origin") != expected_origin:
            raise APIError(403, "Origem da solicitação não permitida.")
        if self.headers.get("Transfer-Encoding"):
            raise APIError(400, "Codificação da solicitação não permitida.")
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths and allow_empty:
            return {}
        if len(lengths) != 1:
            raise APIError(411, "Informe o tamanho da solicitação.")
        try:
            size = int(lengths[0])
        except ValueError:
            raise APIError(400, "Tamanho da solicitação inválido.") from None
        if size < 0:
            raise APIError(400, "Tamanho da solicitação inválido.")
        if size > MAX_JSON_BYTES:
            raise APIError(413, "A solicitação é muito grande.")
        if size == 0 and allow_empty:
            return {}
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise APIError(415, "Envie os dados como application/json.")
        try:
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise APIError(400, "Solicitação incompleta.")
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise APIError(400, "JSON inválido.") from None
        if not isinstance(payload, dict):
            raise APIError(400, "Envie um objeto JSON.")
        return payload

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method):
        try:
            path = urlsplit(self.path).path
            if method == "GET":
                self.get_route(path)
            else:
                self.post_route(path)
        except APIError as error:
            self.respond(error.status, error.payload)
        except sqlite3.Error:
            self.respond(503, {"error": "Não foi possível acessar os dados. Tente novamente."})

    def get_route(self, path):
        if path == "/api/topics":
            self.respond(200, {"topics": TOPICS})
        elif path == "/api/voter":
            token = self.cookie("voter_id")
            headers = {}
            if not self.store.valid_voter(token):
                token = self.store.issue_voter()
                headers["Set-Cookie"] = self.set_cookie("voter_id", token, VOTER_SECONDS)
            topic_id = self.store.voter_topic(token)
            self.respond(200, {"hasVoted": topic_id is not None, "topicId": topic_id}, headers=headers)
        elif path == "/api/admin/session":
            self.respond(200, {"authenticated": self.store.authenticated(self.cookie("admin_session"))})
        elif path == "/api/admin/metrics":
            self.require_admin()
            self.respond(200, self.store.metrics())
        elif path == "/api/admin/export":
            self.require_admin()
            stream = io.StringIO(newline="")
            writer = csv.writer(stream)
            writer.writerow(["Tópico", "Área", "Votos", "Percentual"])
            for topic in self.store.metrics()["topics"]:
                writer.writerow([topic["title"], topic["category"], topic["votes"], f'{topic["percentage"]:.2f}'])
            self.respond(200, stream.getvalue().encode("utf-8-sig"), "text/csv; charset=utf-8", {"Content-Disposition": 'attachment; filename="votacao.csv"'})
        elif path in STATIC_FILES:
            filename, content_type = STATIC_FILES[path]
            public_dir = ROOT / "public"
            target = public_dir / filename
            # Even an accidentally added symlink cannot escape the static root.
            if target.resolve().parent != public_dir.resolve() or not target.is_file():
                raise APIError(404, "Arquivo não encontrado.")
            self.respond(200, target.read_bytes(), content_type)
        else:
            raise APIError(404, "Página não encontrada.")

    def post_route(self, path):
        if path not in {"/api/votes", "/api/admin/login", "/api/admin/logout"}:
            raise APIError(404, "Página não encontrada.")
        payload = self.json_body(allow_empty=path == "/api/admin/logout")
        if path == "/api/votes":
            topic_id = payload.get("topicId")
            if not isinstance(topic_id, str) or topic_id not in TOPIC_IDS:
                raise APIError(400, "Escolha um tópico válido.")
            matricula = canonical_matricula(payload.get("matricula"))
            if matricula is None:
                raise APIError(400, "Informe uma matrícula com exatamente 5 dígitos.")
            if set(payload) != {"topicId", "matricula"}:
                raise APIError(400, "Solicitação de votação inválida.")
            token = self.cookie("voter_id")
            if not self.store.valid_voter(token):
                raise APIError(400, "Atualize a página para iniciar sua votação.")
            created, actual_topic_id = self.store.vote(token, topic_id, matricula)
            if not created:
                raise APIError(409, "Esta matrícula já registrou um voto.")
            self.respond(201, {"topicId": actual_topic_id})
        elif path == "/api/admin/login":
            password = payload.get("password")
            if set(payload) != {"password"} or not isinstance(password, str) or not password or len(password) > 1024:
                raise APIError(400, "Informe uma senha válida.")
            try:
                password.encode("utf-8")
            except UnicodeEncodeError:
                raise APIError(400, "Informe uma senha válida.") from None
            valid, retry_after = self.server.login_limiter.attempt(self.client_address[0], lambda: self.store.verify_password(password))
            if retry_after:
                self.respond(429, {"error": "Muitas tentativas. Aguarde um minuto e tente novamente."}, headers={"Retry-After": str(retry_after)})
            elif not valid:
                raise APIError(401, "Senha incorreta.")
            else:
                token = self.store.new_session(self.cookie("admin_session"))
                self.respond(200, {"authenticated": True}, headers={"Set-Cookie": self.set_cookie("admin_session", token, SESSION_SECONDS)})
        else:
            if payload:
                raise APIError(400, "Solicitação de saída inválida.")
            self.store.logout(self.cookie("admin_session"))
            self.respond(200, {"authenticated": False}, headers={"Set-Cookie": self.set_cookie("admin_session", "", 0)})


def make_server(host, port, data_dir, admin_password=None, secure_cookies=False):
    """Create a context-managed HTTP server; callers control ``serve_forever``."""
    store = Store(data_dir, admin_password=admin_password)
    server = VotingHTTPServer((host, port), Handler)
    server.store = store
    server.secure_cookies = secure_cookies
    server.login_limiter = LoginLimiter()
    return server


def main():
    parser = argparse.ArgumentParser(description="Votação de tópicos com dados persistentes em SQLite.")
    parser.add_argument("--host", default="127.0.0.1", help="Endereço de escuta (padrão: 127.0.0.1).")
    parser.add_argument("--port", type=int, default=8000, help="Porta HTTP (padrão: 8000).")
    parser.add_argument("--init", action="store_true", help="Inicializa banco e credencial, depois encerra.")
    parser.add_argument("--secure-cookies", action="store_true", help="Usa cookies Secure para acesso por HTTPS.")
    args = parser.parse_args()
    data_dir = Path(os.environ.get("VOTING_DATA_DIR", ROOT / "data"))
    if args.init:
        store = Store(data_dir)
        print(f"Dados inicializados em {store.data_dir}.")
        if store.password_path.exists() and "ADMIN_PASSWORD" not in os.environ:
            print(f"Senha administrativa disponível somente em {store.password_path}.")
        return
    with make_server(args.host, args.port, data_dir, secure_cookies=args.secure_cookies) as server:
        print(f"Votação disponível em http://{args.host}:{server.server_address[1]}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
