"""SQLite persistence, opaque identities, and administrator credentials."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time

from .catalog import TOPICS

SESSION_SECONDS = 8 * 60 * 60
VOTER_SECONDS = 365 * 24 * 60 * 60
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")


def canonical_matricula(value):
    """Keep leading zeroes and accept exactly five ASCII digits after stripping."""
    if not isinstance(value, str):
        return None
    canonical = value.strip()
    return canonical if re.fullmatch(r"[0-9]{5}", canonical) else None


def create_votes_table(connection, name):
    # The table name comes only from the two constant calls in migrate_votes.
    connection.execute(f"""
        CREATE TABLE {name} (
            id INTEGER PRIMARY KEY,
            voter_hash TEXT NOT NULL REFERENCES voters(voter_hash),
            matricula_hash TEXT UNIQUE,
            topic_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)


def migrate_votes(connection):
    """Rebuild the legacy cookie-unique table inside the caller's transaction."""
    columns = {row[1] for row in connection.execute("PRAGMA table_info(votes)")}
    if not columns:
        create_votes_table(connection, "votes")
    elif "matricula_hash" not in columns:
        create_votes_table(connection, "votes_migrating")
        connection.execute("""
            INSERT INTO votes_migrating (voter_hash, topic_id, created_at, matricula_hash)
            SELECT voter_hash, topic_id, created_at, NULL FROM votes ORDER BY rowid
        """)
        connection.execute("DROP TABLE votes")
        connection.execute("ALTER TABLE votes_migrating RENAME TO votes")
    connection.execute("CREATE INDEX IF NOT EXISTS votes_voter_receipt ON votes(voter_hash, id DESC)")


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def token_hash(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def password_hash(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)


class Store:
    def __init__(self, data_dir, admin_password=None):
        self.data_dir = Path(data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db_path = self.data_dir / "voting.sqlite3"
        self.password_path = self.data_dir / "admin-password"
        configured_password = admin_password if admin_password is not None else os.environ.get("ADMIN_PASSWORD")
        if configured_password is None:
            try:
                configured_password = self.password_path.read_text(encoding="utf-8").strip()
            except FileNotFoundError:
                configured_password = secrets.token_urlsafe(24)
                try:
                    descriptor = os.open(self.password_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    configured_password = self.password_path.read_text(encoding="utf-8").strip()
                else:
                    with os.fdopen(descriptor, "w", encoding="utf-8") as password_file:
                        password_file.write(configured_password + "\n")
        if not isinstance(configured_password, str) or not configured_password or len(configured_password) > 1024:
            raise ValueError("A senha administrativa deve ter entre 1 e 1024 caracteres.")
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            # DDL and HMAC-key creation commit together. executescript must not
            # be used here: it implicitly commits an existing transaction.
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS credentials (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    salt BLOB NOT NULL,
                    password_hash BLOB NOT NULL
                )
            """)
            connection.execute("""
                CREATE TABLE IF NOT EXISTS voters (
                    voter_hash TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL
                )
            """)
            connection.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    expires_at REAL NOT NULL
                )
            """)
            connection.execute("""
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value BLOB NOT NULL
                )
            """)
            migrate_votes(connection)
            connection.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('matricula_hmac_key', ?)", (secrets.token_bytes(32),))
            self.matricula_key = connection.execute("SELECT value FROM config WHERE key = 'matricula_hmac_key'").fetchone()[0]
            credential = connection.execute("SELECT salt, password_hash FROM credentials WHERE singleton = 1").fetchone()
            if credential is None or not secrets.compare_digest(password_hash(configured_password, credential[0]), credential[1]):
                salt = secrets.token_bytes(16)
                digest = password_hash(configured_password, salt)
                connection.execute("INSERT OR REPLACE INTO credentials VALUES (1, ?, ?)", (salt, digest))
                connection.execute("DELETE FROM sessions")
                credential = (salt, digest)
            self.salt, self.admin_digest = credential
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (time.time(),))
        self.db_path.chmod(0o600)

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def valid_voter(self, token):
        if not token or not TOKEN_PATTERN.fullmatch(token):
            return False
        with self.connection() as connection:
            return connection.execute("SELECT 1 FROM voters WHERE voter_hash = ?", (token_hash(token),)).fetchone() is not None

    def issue_voter(self):
        token = secrets.token_urlsafe(32)
        with self.connection() as connection:
            connection.execute("INSERT INTO voters VALUES (?, ?)", (token_hash(token), utc_now()))
        return token

    def voter_topic(self, token):
        with self.connection() as connection:
            row = connection.execute("SELECT topic_id FROM votes WHERE voter_hash = ? ORDER BY id DESC LIMIT 1", (token_hash(token),)).fetchone()
            return row[0] if row else None

    def vote(self, token, topic_id, matricula):
        canonical = canonical_matricula(matricula)
        if canonical is None:
            raise ValueError("A matrícula deve conter exatamente cinco dígitos.")
        digest = hmac.new(self.matricula_key, canonical.encode("ascii"), hashlib.sha256).hexdigest()
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("INSERT INTO votes (voter_hash, matricula_hash, topic_id, created_at) VALUES (?, ?, ?, ?)", (token_hash(token), digest, topic_id, utc_now()))
            except sqlite3.IntegrityError:
                if connection.execute("SELECT 1 FROM votes WHERE matricula_hash = ?", (digest,)).fetchone():
                    return False, None
                raise
            return True, topic_id

    def verify_password(self, password):
        return secrets.compare_digest(password_hash(password, self.salt), self.admin_digest)

    def new_session(self, old_token=None):
        token = secrets.token_urlsafe(32)
        with self.connection() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (time.time(),))
            if old_token and TOKEN_PATTERN.fullmatch(old_token):
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(old_token),))
            connection.execute("INSERT INTO sessions VALUES (?, ?)", (token_hash(token), time.time() + SESSION_SECONDS))
        return token

    def authenticated(self, token):
        if not token or not TOKEN_PATTERN.fullmatch(token):
            return False
        with self.connection() as connection:
            return connection.execute("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?", (token_hash(token), time.time())).fetchone() is not None

    def logout(self, token):
        if token and TOKEN_PATTERN.fullmatch(token):
            with self.connection() as connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))

    def metrics(self):
        with self.connection() as connection:
            # A read transaction keeps the topic totals and timeline on one snapshot.
            connection.execute("BEGIN")
            counts = dict(connection.execute("SELECT topic_id, COUNT(*) FROM votes GROUP BY topic_id"))
            # Brasília observes UTC-3 year-round for the current voting period.
            timeline = [{"date": row[0], "votes": row[1]} for row in connection.execute("SELECT date(created_at, '-3 hours'), COUNT(*) FROM votes GROUP BY date(created_at, '-3 hours') ORDER BY 1")]
        total = sum(counts.values())
        topics = [{**topic, "votes": counts.get(topic["id"], 0), "percentage": round(100 * counts.get(topic["id"], 0) / total, 2) if total else 0} for topic in TOPICS]
        topics.sort(key=lambda topic: -topic["votes"])
        categories = []
        for name in dict.fromkeys(topic["category"] for topic in TOPICS):
            count = sum(topic["votes"] for topic in topics if topic["category"] == name)
            categories.append({"name": name, "votes": count, "percentage": round(100 * count / total, 2) if total else 0})
        leaders = [topic["id"] for topic in topics if topic["votes"] == topics[0]["votes"]] if total else []
        return {"totalVotes": total, "topics": topics, "categories": categories, "timeline": timeline, "leaders": leaders, "updatedAt": utc_now()}
