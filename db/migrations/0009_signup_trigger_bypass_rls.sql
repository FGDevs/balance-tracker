-- ============================================================
-- Migration 0009 — handle_new_user must bypass RLS on profiles
--
-- After migration 0007 split the `profiles_own` ALL policy into separate
-- SELECT and UPDATE policies, `profiles` has NO INSERT policy. Postgres
-- defaults to "deny" when no policy matches, so the auth.users → profiles
-- trigger now errors with "Database error saving new user" on signup.
--
-- The trigger is SECURITY DEFINER, but SECURITY DEFINER alone does NOT
-- bypass RLS — only roles with the BYPASSRLS attribute (or session-level
-- `row_security = off`) do. We add `SET row_security = off` at the function
-- level so it's bounded to this trigger and doesn't widen any other surface.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  INSERT INTO profiles (id, name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', 'User'));
  RETURN NEW;
END;
$$;

COMMIT;
