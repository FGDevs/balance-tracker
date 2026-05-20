-- ============================================================
-- Migration 0007 — Grants + profile visibility for groups
--
-- Two issues addressed:
--
-- 1. The new `group_memberships` / `group_invitations` tables, created by
--    migration 0005, only have RLS policies — they don't have table-level
--    GRANTs to the `authenticated` role. Supabase relies on `ALTER DEFAULT
--    PRIVILEGES` (set during project bootstrap) to auto-grant on new tables,
--    but that doesn't always apply on every project. Without GRANT, queries
--    fail with "permission denied for table group_memberships" before RLS
--    even gets a chance to filter rows. Fix: GRANT explicitly.
--
-- 2. The original `profiles_own` policy restricts SELECT to `id = auth.uid()`.
--    That blocks the foreign-author annotations (`· {ownerName}` on Account
--    Card, `oleh {creatorName}` on Transaction rows) from resolving names of
--    hostmates. Fix: replace with a SELECT policy that allows hosts/members
--    of any group I'm part of; keep UPDATE strictly to my own row.
-- ============================================================

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON group_memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON group_invitations TO authenticated;

DROP POLICY IF EXISTS "profiles_own" ON profiles;

CREATE POLICY "profiles_select_groupmates" ON profiles
  FOR SELECT
  USING (
    id = auth.uid()
    OR id IN (
      SELECT host_user_id   FROM group_memberships WHERE member_user_id = auth.uid()
    )
    OR id IN (
      SELECT member_user_id FROM group_memberships WHERE host_user_id   = auth.uid()
    )
  );

CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

COMMIT;
