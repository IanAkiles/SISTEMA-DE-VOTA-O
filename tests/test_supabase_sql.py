"""Real PostgreSQL integration tests for the Supabase SQL boundary.

Runs a disposable, network-isolated PostgreSQL 16 Docker container. No Supabase
project, credentials, database files, or published ports are used. If Docker is
unavailable the integration class is explicitly skipped, never reported passed.
"""
import concurrent.futures
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "supabase" / "schema.sql"
ADMIN_EXAMPLE = ROOT / "supabase" / "admin.example.sql"
ADMIN_UID = "11111111-1111-4111-8111-111111111111"
OTHER_UID = "22222222-2222-4222-8222-222222222222"
IMAGE = "postgres:16-bookworm"


def literal(value):
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


class SupabaseSQLTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("docker"):
            raise unittest.SkipTest("PostgreSQL integration skipped: Docker CLI unavailable")
        cls.docker_env = dict(os.environ)
        for name in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            cls.docker_env.pop(name, None)
        health = cls.docker("info", "--format", "{{.ServerVersion}}", check=False)
        if health.returncode:
            raise unittest.SkipTest("PostgreSQL integration skipped: managed Docker socket unavailable (may require sandbox escalation)")
        if cls.docker("image", "inspect", IMAGE, check=False).returncode:
            pull = cls.docker("pull", IMAGE, check=False, timeout=300)
            if pull.returncode:
                raise RuntimeError("PostgreSQL test image could not be pulled through the configured registry/proxy")
        cls.container = "voting-sql-test-" + uuid.uuid4().hex[:12]
        cls.docker("run", "--rm", "-d", "--name", cls.container, "--network", "none", "--label", "purpose=voting-sql-tests", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE, "-c", "wal_level=logical")
        cls.addClassCleanup(cls.docker, "rm", "-f", "-v", cls.container, check=False)
        for _ in range(120):
            # The image briefly starts a Unix-socket-only server during init.
            # TCP loopback becomes ready only for the final server process.
            ready = cls.docker("exec", cls.container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", check=False)
            if ready.returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("Temporary PostgreSQL did not become ready")
        cls.psql("postgres", "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;")

    @classmethod
    def docker(cls, *arguments, check=True, timeout=60, input=None):
        result = subprocess.run(["docker", "--host=unix:///var/run/docker.sock", *arguments], env=cls.docker_env, input=input, capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError("Docker/PostgreSQL test command failed: " + result.stderr)
        return result

    @classmethod
    def psql(cls, database, query, check=True):
        return cls.docker("exec", "-i", cls.container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", "postgres", "-d", database, input=query, check=check)

    def setUp(self):
        self.assertTrue(SCHEMA.is_file(), "Supabase SQL schema has not been implemented")
        self.database = "voting_" + uuid.uuid4().hex[:12]
        self.psql("postgres", "CREATE DATABASE " + self.database)
        self.addCleanup(self.psql, "postgres", "DROP DATABASE " + self.database + " WITH (FORCE)")
        self.psql(self.database, """
            CREATE SCHEMA auth;
            CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL);
            CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
                SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
            $$;
            CREATE PUBLICATION supabase_realtime;
        """)
        self.psql(self.database, SCHEMA.read_text())
        self.psql(self.database, f"INSERT INTO auth.users VALUES ('{ADMIN_UID}', 'admin@example.test'), ('{OTHER_UID}', 'student@example.test'); INSERT INTO voting_private.administrators (user_id) VALUES ('{ADMIN_UID}');")

    def sql(self, query, role=None, uid=None, check=True):
        if role:
            query = "BEGIN; SET LOCAL ROLE " + role + "; SET LOCAL request.jwt.claim.sub = " + literal(uid or "") + "; " + query + "; COMMIT;"
        return self.psql(self.database, query, check=check)

    def value(self, query, role=None, uid=None):
        return self.sql(query, role, uid).stdout.strip()

    def json_value(self, query, role=None, uid=None):
        return json.loads(self.value(query, role, uid))

    def cast(self, matricula, topic="design-web", role="anon", uid=None, check=True):
        query = "SELECT public.cast_vote(" + literal(topic) + ", " + literal(json.dumps(matricula, ensure_ascii=False)) + "::jsonb)"
        return self.sql(query, role, uid, check=check)

    def assert_error(self, result, code, message=None):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(code, result.stderr)
        if message:
            self.assertIn(message, result.stderr)

    def metrics(self):
        return self.json_value("SELECT public.get_voting_metrics()", "authenticated", ADMIN_UID)

    def test_public_catalog_has_fifteen_original_topics_and_details(self):
        for role in ("anon", "authenticated"):
            data = self.json_value("SELECT public.get_voting_topics()", role)
            self.assertEqual(len(data["topics"]), 15)
            self.assertEqual(data["topics"][0]["id"], "admin-sistemas")
            self.assertEqual(data["topics"][-1]["title"], "Edição de vídeos")
            self.assertEqual(len({topic["category"] for topic in data["topics"]}), 5)
            self.assertTrue(all(topic["description"] and topic["skills"] for topic in data["topics"]))
            self.assertTrue(all(set(topic) == {"id", "title", "category", "description", "skills"} for topic in data["topics"]))
        self.assertEqual(self.value("SELECT count(*) FROM public.voting_topics", "anon"), "15")

    def test_cast_requires_string_five_ascii_digits_and_preserves_leading_zeroes(self):
        invalid = (None, 27250, 123, True, {}, [], "", "1234", "123456", "27a50", "27 50", "27-50", "27.50", "２７２５０", "٢٧٢٥٠", "27\n50")
        for matricula in invalid:
            with self.subTest(matricula=matricula):
                self.assert_error(self.cast(matricula, check=False), "22023", "INVALID_MATRICULA")
        self.assert_error(self.sql("SELECT public.cast_vote('design-web', NULL)", "anon", check=False), "22023", "INVALID_MATRICULA")
        self.assertEqual(json.loads(self.cast(" \t00123\n ").stdout), {"topicId": "design-web"})
        self.assertEqual(json.loads(self.cast("00000").stdout), {"topicId": "design-web"})
        self.assert_error(self.cast("00123", topic="inovacao-robotica", check=False), "P0001", "VOTE_ALREADY_RECORDED")
        self.assertEqual(self.metrics()["totalVotes"], 2)

    def test_invalid_topics_never_insert_or_increment(self):
        for topic in ("unknown", "", None):
            with self.subTest(topic=topic):
                self.assert_error(self.cast("27250", topic, check=False), "22023", "INVALID_TOPIC")
        self.assertEqual(self.metrics()["totalVotes"], 0)
        self.assertEqual(self.value("SELECT coalesce(sum(votes), 0) FROM public.voting_totals"), "0")

    def test_duplicate_between_roles_does_not_reveal_original_topic(self):
        self.cast("27250", "inovacao-robotica")
        duplicate = self.cast("27250", "design-web", role="authenticated", uid=OTHER_UID, check=False)
        self.assert_error(duplicate, "P0001", "VOTE_ALREADY_RECORDED")
        self.assertNotIn("inovacao-robotica", duplicate.stderr + duplicate.stdout)
        self.assertNotIn("27250", duplicate.stderr + duplicate.stdout)
        self.assertEqual(self.metrics()["totalVotes"], 1)

    def test_concurrent_same_matricula_has_one_vote_and_one_total_increment(self):
        def submit(_):
            return self.cast("27250", check=False)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(submit, range(8)))
        self.assertEqual(sum(result.returncode == 0 for result in results), 1)
        for result in results:
            if result.returncode:
                self.assert_error(result, "P0001", "VOTE_ALREADY_RECORDED")
        self.assertEqual(self.value("SELECT count(*) FROM voting_private.votes"), "1")
        self.assertEqual(self.value("SELECT votes FROM public.voting_totals WHERE topic_id='design-web'"), "1")

    def test_rollbacks_never_publish_partial_totals(self):
        self.sql("BEGIN; SET LOCAL ROLE anon; SELECT public.cast_vote('design-web', '\"27250\"'::jsonb); ROLLBACK;")
        self.assertEqual(self.metrics()["totalVotes"], 0)
        self.assertEqual(self.value("SELECT sum(votes) FROM public.voting_totals"), "0")
        self.cast("27250")
        self.assertEqual(self.metrics()["totalVotes"], 1)

    def test_private_tables_keys_and_direct_writes_are_denied(self):
        for role, uid in (("anon", None), ("authenticated", OTHER_UID), ("authenticated", ADMIN_UID)):
            for table in ("config", "votes", "administrators"):
                with self.subTest(role=role, table=table):
                    self.assert_error(self.sql("SELECT * FROM voting_private." + table, role, uid, check=False), "42501")
                    self.assert_error(self.sql("INSERT INTO voting_private.administrators(user_id) VALUES ('" + OTHER_UID + "')", role, uid, check=False), "42501")
            for table in ("voting_topics", "voting_totals"):
                self.assert_error(self.sql("DELETE FROM public." + table, role, uid, check=False), "42501")
        self.assertEqual(self.value("SELECT has_schema_privilege('anon', 'voting_private', 'usage')"), "f")
        self.assertEqual(self.value("SELECT has_schema_privilege('authenticated', 'voting_private', 'usage')"), "f")

    def test_totals_rls_and_metrics_require_authorized_admin_uid(self):
        self.assertEqual(self.value("SELECT public.is_voting_admin()", "anon"), "f")
        self.assertEqual(self.value("SELECT public.is_voting_admin()", "authenticated", OTHER_UID), "f")
        self.assertEqual(self.value("SELECT public.is_voting_admin()", "authenticated", ADMIN_UID), "t")
        self.assert_error(self.sql("SELECT public.get_voting_metrics()", "anon", check=False), "42501")
        self.assert_error(self.sql("SELECT public.get_voting_metrics()", "authenticated", OTHER_UID, check=False), "42501")
        self.assert_error(self.sql("SELECT public.get_voting_metrics()", "authenticated", check=False), "42501")
        self.assertEqual(self.value("SELECT count(*) FROM public.voting_totals", "authenticated", OTHER_UID), "0")
        self.assertEqual(self.value("SELECT count(*) FROM public.voting_totals", "authenticated", ADMIN_UID), "15")
        self.assertEqual(self.value("SELECT relrowsecurity FROM pg_class WHERE oid='public.voting_totals'::regclass"), "t")

    def test_hmac_is_private_and_remains_stable_after_idempotent_setup(self):
        self.cast("00123")
        key_before = self.value("SELECT encode(value, 'hex') FROM voting_private.config WHERE key='matricula_hmac_key'")
        digest = self.value("SELECT encode(matricula_hash, 'hex') FROM voting_private.votes")
        expected = self.value("SELECT encode(extensions.hmac(convert_to('00123','UTF8'), value, 'sha256'),'hex') FROM voting_private.config WHERE key='matricula_hmac_key'")
        self.assertEqual(digest, expected)
        self.assertGreaterEqual(len(key_before), 64)
        self.assertNotEqual(digest, self.value("SELECT encode(extensions.digest('00123', 'sha256'), 'hex')"))
        columns = self.value("SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_schema='voting_private' AND table_name='votes'")
        self.assertNotIn("matricula,", columns)
        self.assertNotIn("email", columns)
        self.sql(SCHEMA.read_text())
        self.sql(SCHEMA.read_text())
        self.assertEqual(self.value("SELECT encode(value, 'hex') FROM voting_private.config WHERE key='matricula_hmac_key'"), key_before)
        self.assert_error(self.cast("00123", check=False), "P0001", "VOTE_ALREADY_RECORDED")
        self.assertEqual(self.metrics()["totalVotes"], 1)
        self.assertEqual(self.value("SELECT sum(votes) FROM public.voting_totals"), "1")
        self.assertTrue(self.value("SELECT public.is_voting_admin()", "authenticated", ADMIN_UID) == "t")
        serialized = json.dumps(self.metrics())
        for private in ("00123", digest, key_before, ADMIN_UID):
            self.assertNotIn(private, serialized)

    def test_metrics_empty_tie_percentages_ranking_and_brasilia_timeline(self):
        empty = self.metrics()
        self.assertEqual(empty["totalVotes"], 0)
        self.assertEqual(empty["leaders"], [])
        self.assertEqual(empty["timeline"], [])
        self.assertEqual(len(empty["topics"]), 15)
        self.assertEqual(len(empty["categories"]), 5)
        self.assertTrue(all(topic["votes"] == 0 and topic["percentage"] == 0 for topic in empty["topics"]))
        self.assertTrue(empty["updatedAt"].endswith("Z"))
        for index, topic in enumerate(("design-web", "inovacao-robotica", "design-web", "inovacao-robotica", "design-grafico")):
            self.cast(str(10000 + index), topic)
        self.sql("UPDATE voting_private.votes SET created_at='2026-11-06T01:30:00Z'")
        metrics = self.metrics()
        self.assertEqual(set(metrics), {"totalVotes", "topics", "categories", "timeline", "leaders", "updatedAt"})
        self.assertEqual(metrics["totalVotes"], 5)
        self.assertEqual(set(metrics["leaders"]), {"design-web", "inovacao-robotica"})
        self.assertEqual([topic["votes"] for topic in metrics["topics"][:3]], [2, 2, 1])
        self.assertEqual(metrics["topics"][0]["percentage"], 40)
        self.assertEqual(next(area for area in metrics["categories"] if area["name"] == "Design"), {"name": "Design", "votes": 3, "percentage": 60})
        self.assertEqual(metrics["timeline"], [{"date": "2026-11-05", "votes": 5}])

    def test_functions_are_security_definer_without_public_execute_or_search_path(self):
        rows = self.json_value("""SELECT json_agg(json_build_object('name',p.proname,'definer',p.prosecdef,'config',p.proconfig))
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
            AND p.proname IN ('cast_vote','get_voting_topics','is_voting_admin','get_voting_metrics')""")
        self.assertEqual(len(rows), 4)
        for row in rows:
            self.assertTrue(row["definer"])
            self.assertIn('search_path=""', row["config"])
        self.assertEqual(self.value("SELECT has_function_privilege('anon','public.cast_vote(text,jsonb)','execute')"), "t")
        self.assertEqual(self.value("SELECT has_function_privilege('anon','public.get_voting_metrics()','execute')"), "f")
        self.assertEqual(self.value("SELECT count(*) FROM pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a WHERE p.oid IN ('public.cast_vote(text,jsonb)'::regprocedure,'public.get_voting_topics()'::regprocedure,'public.is_voting_admin()'::regprocedure,'public.get_voting_metrics()'::regprocedure) AND a.grantee=0 AND a.privilege_type='EXECUTE'"), "0")

    def test_realtime_publication_contains_only_public_aggregate_from_this_schema(self):
        published = self.value("SELECT schemaname || '.' || tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' ORDER BY 1")
        self.assertEqual(published, "public.voting_totals")
        self.sql(SCHEMA.read_text())
        self.assertEqual(self.value("SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='voting_totals'"), "1")
        self.sql("DROP PUBLICATION supabase_realtime")
        self.sql(SCHEMA.read_text())
        self.assertEqual(self.metrics()["totalVotes"], 0)

    def test_admin_example_requires_existing_auth_user_and_is_idempotent(self):
        self.assertTrue(ADMIN_EXAMPLE.is_file(), "Administrator enrollment SQL has not been implemented")
        # The owner edits v_email when configuring the project. Exercise that
        # exact artifact against disposable Auth users instead of replacing a
        # hard-coded example address that may no longer be present.
        self.sql("DELETE FROM voting_private.administrators; DELETE FROM auth.users")
        self.assertEqual(self.value("SELECT public.is_voting_admin()", "authenticated", ADMIN_UID), "f")
        example = ADMIN_EXAMPLE.read_text()
        match = re.search(r"\bv_email\s+constant\s+text\s*:=\s*'((?:''|[^'])*)'", example, re.IGNORECASE)
        self.assertIsNotNone(match, "Administrator enrollment needs a configured v_email literal")
        configured_email = match.group(1).replace("''", "'")
        self.assert_error(self.sql(example, check=False), "P0001", "ADMIN_USER_NOT_FOUND")
        self.sql("INSERT INTO auth.users (id,email) VALUES (" + literal(ADMIN_UID) + "," + literal(configured_email) + ")")
        self.sql(example)
        self.sql(example)
        self.assertEqual(self.value("SELECT public.is_voting_admin()", "authenticated", ADMIN_UID), "t")
        self.assertEqual(self.value("SELECT count(*) FROM voting_private.administrators"), "1")


if __name__ == "__main__":
    unittest.main()
