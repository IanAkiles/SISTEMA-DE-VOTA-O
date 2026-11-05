"""Integration checks through real HTTP sockets and temporary SQLite databases."""
import concurrent.futures
from contextlib import ExitStack
import csv
import hashlib
import hmac
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from http.cookies import SimpleCookie

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PASSWORD = "test-admin-password-2026"


class Client:
    def __init__(self, server, cookies=None):
        self.host, self.port = server.server_address[:2]
        self.origin = f"http://{self.host}:{self.port}"
        self.cookies = dict(cookies or {})

    def request(self, method, path, payload=None, *, raw=None, headers=None):
        request_headers = {"Origin": self.origin}
        if self.cookies:
            request_headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        body = raw
        if payload is not None:
            body = json.dumps(payload).encode()
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})
        connection = http.client.HTTPConnection(self.host, self.port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            content = response.read()
            response_headers = dict(response.getheaders())
            for key, value in response.getheaders():
                if key.lower() == "set-cookie":
                    cookie = SimpleCookie(value)
                    for name, morsel in cookie.items():
                        if morsel["max-age"] == "0":
                            self.cookies.pop(name, None)
                        else:
                            self.cookies[name] = morsel.value
            result = json.loads(content) if "application/json" in response_headers.get("Content-Type", "") else content
            return response.status, result, response_headers
        finally:
            connection.close()


class VotingServerTests(unittest.TestCase):
    def setUp(self):
        # Removing the server implementation must fail a behavior assertion, not import collection.
        self.assertIsNotNone(importlib.util.find_spec("server"), "The voting HTTP server is not implemented")
        import server
        self.server_module = server
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.data_dir = Path(self.directory.name)
        self.next_matricula = 10000
        self.start_server()
        self.client = Client(self.server)

    def start_server(self):
        self.server_context = ExitStack()
        self.server = self.server_context.enter_context(self.server_module.make_server("127.0.0.1", 0, self.data_dir, admin_password=PASSWORD))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        if self.server:
            self.server.shutdown()
            self.server_context.close()
            self.server.server_close()
            self.thread.join(timeout=5)
            self.server = None

    def identify(self, client=None):
        client = client or self.client
        status, payload, headers = client.request("GET", "/api/voter")
        self.assertEqual(status, 200)
        return payload, headers

    def login(self, client=None):
        status, payload, headers = (client or self.client).request("POST", "/api/admin/login", {"password": PASSWORD})
        self.assertEqual(status, 200)
        self.assertTrue(payload["authenticated"])
        return headers

    def vote(self, topic_id, client=None, matricula=None):
        client = client or self.client
        self.identify(client)
        if matricula is None:
            matricula = str(self.next_matricula)
            self.next_matricula += 1
        return client.request("POST", "/api/votes", {"topicId": topic_id, "matricula": matricula})

    def metrics(self):
        status, payload, _ = self.client.request("GET", "/api/admin/metrics")
        self.assertEqual(status, 200)
        return payload

    def test_catalog_contains_fifteen_courses_with_accessible_details(self):
        status, payload, _ = self.client.request("GET", "/api/topics")
        self.assertEqual(status, 200)
        topics = payload["topics"]
        self.assertEqual(len(topics), 15)
        self.assertEqual(len({topic["id"] for topic in topics}), 15)
        self.assertEqual({topic["category"] for topic in topics}, {"Administrativo", "Design", "Marketing digital", "Suporte técnico", "Inovação"})
        self.assertTrue(any(topic["title"] == "Robótica" for topic in topics))
        self.assertTrue(all(topic["description"] and topic["skills"] for topic in topics))

    def test_voter_cookie_is_server_issued_and_private(self):
        payload, headers = self.identify()
        self.assertEqual(payload, {"hasVoted": False, "topicId": None})
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Lax", headers["Set-Cookie"])
        cookie_before = dict(self.client.cookies)
        self.identify()
        self.assertEqual(self.client.cookies, cookie_before)
        stranger = Client(self.server, {"voter_id": "fabricated-cookie"})
        status, _, _ = stranger.request("POST", "/api/votes", {"topicId": "inovacao-robotica", "matricula": "27250"})
        self.assertEqual(status, 400)
        self.identify(stranger)
        self.assertNotEqual(stranger.cookies["voter_id"], "fabricated-cookie")

    def test_vote_and_identity_remain_persistent_but_duplicate_does_not_reveal_choice(self):
        status, payload, _ = self.vote("inovacao-robotica", matricula="27250")
        self.assertEqual((status, payload), (201, {"topicId": "inovacao-robotica"}))
        other = Client(self.server)
        self.identify(other)
        status, payload, headers = other.request("POST", "/api/votes", {"topicId": "design-web", "matricula": "27250"})
        self.assertEqual(status, 409)
        self.assertEqual(set(payload), {"error"})
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.identify(other)[0], {"hasVoted": False, "topicId": None})
        cookies = dict(self.client.cookies)
        self.stop_server()
        self.start_server()
        self.client = Client(self.server, cookies)
        self.assertEqual(self.identify()[0], {"hasVoted": True, "topicId": "inovacao-robotica"})
        third = Client(self.server)
        self.assertEqual(self.vote("design-web", third, matricula="27250")[0], 409)
        self.assertEqual(self.identify(third)[0], {"hasVoted": False, "topicId": None})
        self.login()
        self.assertEqual(self.metrics()["totalVotes"], 1)

    def test_concurrent_requests_from_distinct_cookies_for_same_matricula_count_once(self):
        clients = [Client(self.server) for _ in range(8)]
        for client in clients:
            self.identify(client)
        def submit(client):
            return client.request("POST", "/api/votes", {"topicId": "design-web", "matricula": "27250"})
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(submit, clients))
        self.assertEqual([response[0] for response in responses].count(201), 1)
        self.assertEqual([response[0] for response in responses].count(409), 7)
        for client, response in zip(clients, responses):
            if response[0] == 409:
                self.assertEqual(set(response[1]), {"error"})
                self.assertFalse(self.identify(client)[0]["hasVoted"])
        self.login()
        self.assertEqual(self.metrics()["totalVotes"], 1)

    def test_two_matriculas_can_vote_from_same_cookie_and_receipt_is_latest_success(self):
        self.assertEqual(self.vote("inovacao-robotica", matricula="27250")[0], 201)
        cookie_before = dict(self.client.cookies)
        self.assertEqual(self.vote("design-web", matricula="00123")[0], 201)
        self.assertEqual(self.client.cookies, cookie_before)
        self.assertEqual(self.identify()[0], {"hasVoted": True, "topicId": "design-web"})
        status, payload, _ = self.vote("design-grafico", matricula="27250")
        self.assertEqual(status, 409)
        self.assertEqual(set(payload), {"error"})
        self.assertEqual(self.identify()[0], {"hasVoted": True, "topicId": "design-web"})
        self.login()
        self.assertEqual(self.metrics()["totalVotes"], 2)

    def test_matricula_requires_exactly_five_ascii_digits_and_string_type(self):
        self.identify()
        missing_status, _, _ = self.client.request("POST", "/api/votes", {"topicId": "design-web"})
        self.assertEqual(missing_status, 400)
        invalid_values = (None, 27250, 123, True, {}, [], "", "1234", "123456", "27a50", "27 50", "27-50", "27.50", "２７２５０", "٢٧٢٥٠", "27\n50", "\ud800")
        for value in invalid_values:
            with self.subTest(matricula=value):
                status, payload, _ = self.client.request("POST", "/api/votes", {"topicId": "design-web", "matricula": value})
                self.assertEqual(status, 400)
                self.assertIn("error", payload)
        self.assertFalse(self.identify()[0]["hasVoted"])
        self.assertEqual(self.vote("design-web", matricula="  00123  ")[0], 201)
        self.assertEqual(self.vote("design-grafico", Client(self.server), matricula="00123")[0], 409)
        self.assertEqual(self.vote("design-grafico", matricula="00000")[0], 201)
        self.assertEqual(self.vote("design-grafico", matricula="01230")[0], 201)
        self.login()
        self.assertEqual(self.metrics()["totalVotes"], 3)

    def test_matricula_is_private_hmac_and_key_survives_password_rotation(self):
        self.assertEqual(self.vote("inovacao-robotica", matricula="00123")[0], 201)
        with sqlite3.connect(self.data_dir / "voting.sqlite3") as connection:
            key = connection.execute("SELECT value FROM config WHERE key = 'matricula_hmac_key'").fetchone()[0]
            saved_digest = connection.execute("SELECT matricula_hash FROM votes").fetchone()[0]
            self.assertGreaterEqual(len(key), 32)
            self.assertEqual(saved_digest, hmac.new(key, b"00123", hashlib.sha256).hexdigest())
            self.assertNotEqual(saved_digest, hashlib.sha256(b"00123").hexdigest())
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM votes WHERE matricula_hash = '00123'").fetchone()[0], 0)
        self.login()
        serialized_metrics = json.dumps(self.metrics())
        _, csv_content, _ = self.client.request("GET", "/api/admin/export")
        for private_value in ("00123", saved_digest):
            self.assertNotIn(private_value, serialized_metrics)
            self.assertNotIn(private_value.encode(), csv_content)
        from voting.store import Store
        rotated_store = Store(self.data_dir, admin_password="rotated-admin-password-2026")
        self.assertEqual(rotated_store.vote(self.client.cookies["voter_id"], "design-web", "00123"), (False, None))
        with sqlite3.connect(self.data_dir / "voting.sqlite3") as connection:
            retained_key = connection.execute("SELECT value FROM config WHERE key = 'matricula_hmac_key'").fetchone()[0]
        self.assertEqual(retained_key, key)
        self.assertEqual(self.vote("design-web", Client(self.server), matricula="00123")[0], 409)

    def test_missing_identity_and_invalid_topics_do_not_record_votes(self):
        self.assertEqual(self.client.request("POST", "/api/votes", {"topicId": "design-web", "matricula": "27250"})[0], 400)
        self.identify()
        for invalid in ({}, {"topicId": "unknown", "matricula": "27250"}, {"topicId": None, "matricula": "27250"}, {"topicId": 1, "matricula": "27250"}, {"topicId": "design-web", "matricula": "27250", "extra": True}):
            with self.subTest(payload=invalid):
                self.assertEqual(self.client.request("POST", "/api/votes", invalid)[0], 400)
        self.login()
        self.assertEqual(self.metrics()["totalVotes"], 0)

    def test_admin_routes_require_authentication(self):
        self.assertEqual(self.client.request("GET", "/api/admin/session")[1], {"authenticated": False})
        for path in ("/api/admin/metrics", "/api/admin/export"):
            self.assertEqual(self.client.request("GET", path)[0], 401)
        self.assertEqual(self.client.request("POST", "/api/admin/login", {"password": "wrong"})[0], 401)
        headers = self.login()
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertEqual(self.client.request("GET", "/api/admin/session")[1], {"authenticated": True})

    def test_logout_invalidates_session_even_when_cookie_is_replayed(self):
        self.login()
        stolen_cookies = dict(self.client.cookies)
        self.assertEqual(self.client.request("POST", "/api/admin/logout", {})[0], 200)
        self.assertNotIn("admin_session", self.client.cookies)
        self.assertEqual(Client(self.server, stolen_cookies).request("GET", "/api/admin/metrics")[0], 401)

    def test_logout_accepts_empty_body_from_browser_fetch(self):
        self.login()
        status, payload, _ = self.client.request("POST", "/api/admin/logout")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"authenticated": False})
        self.assertEqual(self.client.request("GET", "/api/admin/session")[1], {"authenticated": False})

    def test_oversized_json_integer_and_surrogate_password_return_client_errors(self):
        cases = (
            ("/api/votes", b'{"topicId":' + b"9" * 5000 + b"}"),
            ("/api/admin/login", b'{"password":"\\ud800"}'),
        )
        for path, raw in cases:
            with self.subTest(path=path):
                try:
                    status, payload, _ = self.client.request("POST", path, raw=raw, headers={"Content-Type": "application/json"})
                except http.client.RemoteDisconnected:
                    status, payload = 0, {}
                self.assertEqual(status, 400, "Malformed input must return JSON 400 instead of disconnecting")
                self.assertIn("error", payload)

    def test_sessions_are_hashed_at_rest_and_expire(self):
        self.login()
        raw_token = self.client.cookies["admin_session"]
        with sqlite3.connect(self.data_dir / "voting.sqlite3") as connection:
            saved_hash, expires_at = connection.execute("SELECT token_hash, expires_at FROM sessions").fetchone()
            self.assertNotEqual(saved_hash, raw_token)
            self.assertGreater(expires_at, 0)
            connection.execute("UPDATE sessions SET expires_at = 0")
        self.assertEqual(self.client.request("GET", "/api/admin/session")[1], {"authenticated": False})
        self.assertEqual(self.client.request("GET", "/api/admin/metrics")[0], 401)

    def test_failed_login_is_rate_limited(self):
        for _ in range(5):
            self.assertEqual(self.client.request("POST", "/api/admin/login", {"password": "wrong"})[0], 401)
        status, payload, headers = self.client.request("POST", "/api/admin/login", {"password": PASSWORD})
        self.assertEqual(status, 429)
        self.assertIn("error", payload)
        self.assertIn("Retry-After", headers)

    def test_empty_metrics_have_no_leader_and_all_topics(self):
        self.login()
        metrics = self.metrics()
        self.assertEqual(metrics["totalVotes"], 0)
        self.assertEqual(metrics["leaders"], [])
        self.assertEqual(metrics["timeline"], [])
        self.assertEqual(len(metrics["topics"]), 15)
        self.assertEqual(len(metrics["categories"]), 5)
        self.assertTrue(all(topic["votes"] == 0 and topic["percentage"] == 0 for topic in metrics["topics"]))
        self.assertTrue(metrics["updatedAt"].endswith("Z"))

    def test_metrics_aggregate_real_votes_and_ties(self):
        for topic_id in ("design-web", "inovacao-robotica", "design-web", "inovacao-robotica", "design-grafico"):
            self.assertEqual(self.vote(topic_id, Client(self.server))[0], 201)
        self.login()
        metrics = self.metrics()
        self.assertEqual(metrics["totalVotes"], 5)
        self.assertEqual(set(metrics["leaders"]), {"design-web", "inovacao-robotica"})
        self.assertEqual([topic["votes"] for topic in metrics["topics"][:3]], [2, 2, 1])
        topics = {topic["id"]: topic for topic in metrics["topics"]}
        self.assertEqual(topics["design-web"]["percentage"], 40)
        categories = {category["name"]: category for category in metrics["categories"]}
        self.assertEqual(categories["Design"]["votes"], 3)
        self.assertEqual(categories["Design"]["percentage"], 60)
        self.assertEqual(len(metrics["timeline"]), 1)
        self.assertEqual(metrics["timeline"][0]["votes"], 5)

    def test_timeline_uses_brasilia_calendar_day(self):
        self.vote("inovacao-robotica")
        with sqlite3.connect(self.data_dir / "voting.sqlite3") as connection:
            connection.execute("UPDATE votes SET created_at = '2026-11-06T01:30:00Z'")
        self.login()
        self.assertEqual(self.metrics()["timeline"], [{"date": "2026-11-05", "votes": 1}])

    def test_csv_is_private_utf8_and_matches_real_counts(self):
        self.vote("inovacao-robotica")
        self.login()
        status, content, headers = self.client.request("GET", "/api/admin/export")
        self.assertEqual(status, 200)
        self.assertIn("text/csv", headers["Content-Type"])
        self.assertIn("attachment", headers["Content-Disposition"])
        rows = list(csv.reader(io.StringIO(content.decode("utf-8-sig"))))
        self.assertEqual(rows[0], ["Tópico", "Área", "Votos", "Percentual"])
        self.assertEqual(len(rows), 16)
        self.assertIn(["Robótica", "Inovação", "1", "100.00"], rows)

    def test_json_types_size_and_external_origin_are_rejected(self):
        self.identify()
        for raw in (b"{broken", b"[]", b"null", b'"text"'):
            with self.subTest(raw=raw):
                self.assertEqual(self.client.request("POST", "/api/votes", raw=raw, headers={"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.client.request("POST", "/api/votes", raw=b"{}", headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.client.request("POST", "/api/votes", raw=b"x" * 20000, headers={"Content-Type": "application/json"})[0], 413)
        self.assertEqual(self.client.request("POST", "/api/votes", {"topicId": "design-web"}, headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.client.request("POST", "/api/votes", {"topicId": "design-web"}, headers={"Origin": "null"})[0], 403)
        self.assertFalse(self.identify()[0]["hasVoted"])

    def test_private_files_and_traversal_are_not_served(self):
        for path in ("/server.py", "/data/voting.sqlite3", "/data/admin-password", "/.git/config", "/../server.py", "/%2e%2e/server.py", "/docs/superpowers/specs/2026-11-05-votacao-design.md"):
            with self.subTest(path=path):
                status, content, headers = self.client.request("GET", path)
                self.assertEqual(status, 404)
                self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.client.request("GET", "/api/topics")[2]["X-Content-Type-Options"], "nosniff")

    def test_secure_cookie_option_marks_both_cookies(self):
        self.stop_server()
        self.server = self.server_module.make_server("127.0.0.1", 0, self.data_dir, admin_password=PASSWORD, secure_cookies=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = Client(self.server)
        self.client.origin = self.client.origin.replace("http:", "https:")
        self.assertIn("Secure", self.identify()[1]["Set-Cookie"])
        self.assertIn("Secure", self.login()["Set-Cookie"])


class MigrationTests(unittest.TestCase):
    def seed_legacy_database(self, directory, *, orphan=False):
        path = Path(directory) / "voting.sqlite3"
        with sqlite3.connect(path) as connection:
            connection.executescript("""
                CREATE TABLE credentials (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), salt BLOB NOT NULL, password_hash BLOB NOT NULL);
                CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at REAL NOT NULL);
                CREATE TABLE voters (voter_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL);
                CREATE TABLE votes (
                    voter_hash TEXT PRIMARY KEY REFERENCES voters(voter_hash),
                    topic_id TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
            """)
            salt = bytes(range(16))
            password_digest = hashlib.scrypt(PASSWORD.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
            connection.execute("INSERT INTO credentials VALUES (1, ?, ?)", (salt, password_digest))
            connection.execute("INSERT INTO sessions VALUES (?, ?)", (hashlib.sha256(b"a" * 43).hexdigest(), 4102444800))
            rows = [("legacy-cookie-one", "design-web", "2026-11-05T10:20:30Z"), ("legacy-cookie-two", "inovacao-robotica", "2026-11-05T11:22:33Z")]
            for token, topic, timestamp in rows:
                digest = hashlib.sha256(token.encode()).hexdigest()
                if not orphan:
                    connection.execute("INSERT INTO voters VALUES (?, ?)", (digest, timestamp))
                connection.execute("INSERT INTO votes VALUES (?, ?, ?)", (digest, topic, timestamp))
        return rows

    def test_legacy_votes_and_timestamps_survive_idempotent_migration(self):
        from voting.store import Store
        with tempfile.TemporaryDirectory() as directory:
            originals = self.seed_legacy_database(directory)
            store = Store(directory, admin_password=PASSWORD)
            self.assertTrue(store.verify_password(PASSWORD))
            self.assertTrue(store.authenticated("a" * 43))
            with sqlite3.connect(store.db_path) as connection:
                self.assertEqual(connection.execute("SELECT salt FROM credentials").fetchone()[0], bytes(range(16)))
                columns = {row[1] for row in connection.execute("PRAGMA table_info(votes)")}
                self.assertIn("matricula_hash", columns)
                migrated = list(connection.execute("SELECT voter_hash, topic_id, created_at, matricula_hash FROM votes ORDER BY id"))
                key = connection.execute("SELECT value FROM config WHERE key = 'matricula_hmac_key'").fetchone()[0]
                self.assertEqual(migrated, [(hashlib.sha256(token.encode()).hexdigest(), topic, timestamp, None) for token, topic, timestamp in originals])
            self.assertEqual(store.metrics()["totalVotes"], 2)
            self.assertEqual(store.voter_topic("legacy-cookie-one"), "design-web")
            self.assertEqual(store.vote("legacy-cookie-one", "design-grafico", "27250"), (True, "design-grafico"))
            Store(directory, admin_password=PASSWORD)
            Store(directory, admin_password=PASSWORD)
            with sqlite3.connect(store.db_path) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM votes").fetchone()[0], 3)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM votes WHERE matricula_hash IS NULL").fetchone()[0], 2)
                self.assertEqual(connection.execute("SELECT value FROM config WHERE key = 'matricula_hmac_key'").fetchone()[0], key)
            self.assertEqual(store.vote("legacy-cookie-two", "design-web", "27250"), (False, None))

    def test_failed_migration_rolls_back_original_votes_and_schema(self):
        from voting.store import Store
        with tempfile.TemporaryDirectory() as directory:
            self.seed_legacy_database(directory, orphan=True)
            with self.assertRaises(sqlite3.IntegrityError):
                Store(directory, admin_password=PASSWORD)
            with sqlite3.connect(Path(directory) / "voting.sqlite3") as connection:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(votes)")}
                self.assertNotIn("matricula_hash", columns)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM votes").fetchone()[0], 2)
                tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                self.assertNotIn("votes_migrating", tables)
                self.assertNotIn("config", tables)


class InitializationTests(unittest.TestCase):
    def test_cli_initialization_is_idempotent_private_and_does_not_print_password(self):
        self.assertTrue((ROOT / "server.py").exists(), "The CLI is not implemented")
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, VOTING_DATA_DIR=directory)
            env.pop("ADMIN_PASSWORD", None)
            first = subprocess.run([sys.executable, "server.py", "--init"], cwd=ROOT, env=env, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            password_path = Path(directory) / "admin-password"
            first_password = password_path.read_text()
            self.assertGreaterEqual(len(first_password.strip()), 24)
            self.assertEqual(password_path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(first_password.strip(), first.stdout + first.stderr)
            second = subprocess.run([sys.executable, "server.py", "--init"], cwd=ROOT, env=env, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(password_path.read_text(), first_password)
            self.assertTrue((Path(directory) / "voting.sqlite3").exists())

    def test_environment_password_does_not_create_plaintext_password_file(self):
        self.assertTrue((ROOT / "server.py").exists(), "The CLI is not implemented")
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, VOTING_DATA_DIR=directory, ADMIN_PASSWORD=PASSWORD)
            result = subprocess.run([sys.executable, "server.py", "--init"], cwd=ROOT, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((Path(directory) / "admin-password").exists())
            self.assertNotIn(PASSWORD, result.stdout + result.stderr)
            self.assertNotIn(PASSWORD.encode(), (Path(directory) / "voting.sqlite3").read_bytes())


if __name__ == "__main__":
    unittest.main()
