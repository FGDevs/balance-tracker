-- ============================================================
-- Migration 0006 — Switch group invitations to auto-bind on login
-- See CLAUDE.md §13.5.
--
-- Why: v1 has no SMTP/email transport. Instead, the host writes an email
-- onto an invitation row, and any later sign-in by a user with that email
-- auto-claims the invitation (creates the membership, marks accepted).
--
-- What this does:
--   1. Drops the token-based accept_invitation(text) RPC (no link flow).
--   2. Adds claim_invitations_for_email() RPC — SECURITY DEFINER, looks up
--      the caller's auth.users.email, accepts every matching 'pending'
--      invitation, returns the number of memberships created.
--   3. Token column on group_invitations stays for forward-compat but is
--      relaxed to nullable since we no longer generate one.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS accept_invitation(TEXT);

ALTER TABLE group_invitations
  ALTER COLUMN token DROP NOT NULL;

-- Claim any pending invitation rows whose invitee_email matches the caller's
-- auth.users.email. For each, INSERT a membership and UPDATE the invitation
-- to 'accepted'. Skips self-invites and rows where the membership already
-- exists. Returns the number of new memberships created.
CREATE OR REPLACE FUNCTION claim_invitations_for_email()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id  UUID := auth.uid();
  v_user_email TEXT;
  v_inv        RECORD;
  v_count      INT  := 0;
BEGIN
  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_member_id;
  IF v_user_email IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_inv IN
    SELECT *
      FROM group_invitations
     WHERE status = 'pending'
       AND LOWER(invitee_email) = LOWER(v_user_email)
       AND (expires_at IS NULL OR expires_at >= NOW())
     FOR UPDATE
  LOOP
    -- Skip self-invites silently.
    IF v_inv.host_user_id = v_member_id THEN
      UPDATE group_invitations
         SET status = 'revoked'
       WHERE id = v_inv.id;
      CONTINUE;
    END IF;

    -- Skip if already a member.
    IF EXISTS (
      SELECT 1 FROM group_memberships
       WHERE host_user_id   = v_inv.host_user_id
         AND member_user_id = v_member_id
    ) THEN
      UPDATE group_invitations
         SET status = 'accepted', accepted_at = NOW()
       WHERE id = v_inv.id;
      CONTINUE;
    END IF;

    INSERT INTO group_memberships (host_user_id, member_user_id)
    VALUES (v_inv.host_user_id, v_member_id);

    UPDATE group_invitations
       SET status = 'accepted', accepted_at = NOW()
     WHERE id = v_inv.id;

    v_count := v_count + 1;
  END LOOP;

  -- Mark any past-expiry pending rows for this email as expired so the
  -- host's outbound list stays tidy.
  UPDATE group_invitations
     SET status = 'expired'
   WHERE status = 'pending'
     AND LOWER(invitee_email) = LOWER(v_user_email)
     AND expires_at IS NOT NULL
     AND expires_at < NOW();

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_invitations_for_email() TO authenticated;

COMMIT;
