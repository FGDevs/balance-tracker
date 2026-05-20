-- ============================================================
-- Migration 0008 — group_invitations SELECT: host-only
--
-- The previous policy (migration 0005) had an invitee-side clause:
--   OR LOWER(invitee_email) = LOWER((SELECT email FROM auth.users WHERE id = auth.uid()))
-- That subquery reads auth.users in the calling role's context. The
-- `authenticated` role has no grant on auth.users, so the policy itself
-- errors with "permission denied for table users" whenever ANY user
-- queries group_invitations.
--
-- With the auto-bind-on-login flow (§13.5), invitees never need to read
-- invitation rows directly — the SECURITY DEFINER `claim_invitations_for_email`
-- RPC handles email matching internally. So the invitee-side clause is
-- dead weight. Drop the policy and recreate scoped to the host only.
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "group_invitations_select" ON group_invitations;

CREATE POLICY "group_invitations_select" ON group_invitations
  FOR SELECT
  USING (host_user_id = auth.uid());

COMMIT;
