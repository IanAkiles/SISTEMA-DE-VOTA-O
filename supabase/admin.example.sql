-- Run only as the project owner in the Supabase SQL editor, after schema.sql.
-- 1. Create the administrator in Authentication > Users.
-- 2. Replace the example email below with that existing user's email.
-- 3. Run this script; it resolves the UUID from auth.users and grants access.
-- Disable public signups in Authentication settings when they are unnecessary.
-- No password, API secret, service role key or browser permission code belongs here.
BEGIN;
DO $administrator$
DECLARE
    v_email constant text := 'admin@example.invalid';
    v_user_id uuid;
    v_matches bigint;
BEGIN
    SELECT pg_catalog.count(*) INTO v_matches
    FROM auth.users u WHERE pg_catalog.lower(u.email) = pg_catalog.lower(v_email);
    IF v_matches <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_USER_NOT_FOUND';
    END IF;
    SELECT u.id INTO STRICT v_user_id
    FROM auth.users u WHERE pg_catalog.lower(u.email) = pg_catalog.lower(v_email);
    INSERT INTO voting_private.administrators (user_id) VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;
END
$administrator$;
COMMIT;
