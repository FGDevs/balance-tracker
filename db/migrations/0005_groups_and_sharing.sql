-- ============================================================
-- Migration 0005 — Groups & Sharing (Phase 1)
-- See CLAUDE.md §13 for the full design.
--
-- What this does:
--   1. Two new tables: group_memberships, group_invitations.
--   2. created_by column on every group-shared table (accounts, categories,
--      transactions, transaction_items, debt_settlements). Backfills from
--      user_id, then sets NOT NULL.
--   3. user_id column on debt_settlements (so its RLS doesn't have to JOIN
--      to accounts). Backfilled from accounts.user_id via account_id.
--   4. Replaces every single-user RLS policy with a group-aware one using
--      the is_group_visible(uuid) helper.
--   5. Re-creates account_balances view WITH security_invoker so it follows
--      the calling user's RLS on the underlying accounts table.
--   6. accept_invitation(text) RPC, granted to `authenticated`.
--
-- Idempotency: uses CREATE ... IF NOT EXISTS and DROP ... IF EXISTS where it
-- helps, but the migration is intended to run exactly once on a 0004 baseline.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. GROUP TABLES
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS group_memberships (
  host_user_id   UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  member_user_id UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (host_user_id, member_user_id),
  CHECK (host_user_id <> member_user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_memberships_member
  ON group_memberships(member_user_id);

CREATE TABLE IF NOT EXISTS group_invitations (
  id            BIGINT       PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  host_user_id  UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  invitee_email TEXT         NOT NULL,
  token         TEXT         NOT NULL UNIQUE,
  status        TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','revoked','expired')),
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMP,
  accepted_at   TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_group_invitations_host_status
  ON group_invitations(host_user_id, status);
CREATE INDEX IF NOT EXISTS idx_group_invitations_email
  ON group_invitations(LOWER(invitee_email));

-- ────────────────────────────────────────────────────────────
-- 2. MEMBERSHIP HELPER (used by every group-aware RLS policy)
-- ────────────────────────────────────────────────────────────
-- SECURITY DEFINER so it can read group_memberships even when invoked from
-- an RLS context that hasn't yet evaluated membership. Leaks at most the
-- existence of a (host, member) pair — acceptable for this app.
CREATE OR REPLACE FUNCTION is_group_visible(group_owner UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    group_owner = auth.uid()
    OR EXISTS (
      SELECT 1
        FROM group_memberships
       WHERE host_user_id   = group_owner
         AND member_user_id = auth.uid()
    );
$$;

GRANT EXECUTE ON FUNCTION is_group_visible(UUID) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 3. created_by COLUMNS + BACKFILL + NOT NULL
-- ────────────────────────────────────────────────────────────

ALTER TABLE accounts          ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);
ALTER TABLE categories        ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);
ALTER TABLE transactions      ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);
ALTER TABLE debt_settlements  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);

UPDATE accounts          SET created_by = user_id          WHERE created_by IS NULL;
UPDATE categories        SET created_by = user_id          WHERE created_by IS NULL AND user_id IS NOT NULL;
UPDATE transactions      SET created_by = user_id          WHERE created_by IS NULL;
UPDATE transaction_items ti
   SET created_by = (SELECT user_id FROM transactions WHERE id = ti.transaction_id)
 WHERE ti.created_by IS NULL;
UPDATE debt_settlements ds
   SET created_by = (SELECT user_id FROM accounts WHERE id = ds.account_id)
 WHERE ds.created_by IS NULL;

ALTER TABLE accounts          ALTER COLUMN created_by SET NOT NULL;
-- categories.user_id is nullable (system defaults). created_by stays nullable
-- to match — system categories have NULL created_by too.
ALTER TABLE transactions      ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE transaction_items ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE debt_settlements  ALTER COLUMN created_by SET NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 4. user_id ON debt_settlements (for direct RLS, no JOIN)
-- ────────────────────────────────────────────────────────────

ALTER TABLE debt_settlements
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES profiles(id);

UPDATE debt_settlements ds
   SET user_id = (SELECT user_id FROM accounts WHERE id = ds.account_id)
 WHERE ds.user_id IS NULL;

ALTER TABLE debt_settlements ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_debt_settlements_user
  ON debt_settlements(user_id);

-- ────────────────────────────────────────────────────────────
-- 5. RLS — drop old policies, install group-aware ones
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "accounts_own"            ON accounts;
DROP POLICY IF EXISTS "categories_own_system"   ON categories;
DROP POLICY IF EXISTS "transactions_own"        ON transactions;
DROP POLICY IF EXISTS "tx_items_own"            ON transaction_items;
DROP POLICY IF EXISTS "settlements_own"         ON debt_settlements;

CREATE POLICY "accounts_group" ON accounts
  USING (is_group_visible(user_id))
  WITH CHECK (is_group_visible(user_id));

CREATE POLICY "categories_group" ON categories
  USING (user_id IS NULL OR is_group_visible(user_id))
  WITH CHECK (user_id IS NULL OR is_group_visible(user_id));

CREATE POLICY "transactions_group" ON transactions
  USING (is_group_visible(user_id))
  WITH CHECK (is_group_visible(user_id));

CREATE POLICY "transaction_items_group" ON transaction_items
  USING (
    transaction_id IN (
      SELECT id FROM transactions WHERE is_group_visible(user_id)
    )
  )
  WITH CHECK (
    transaction_id IN (
      SELECT id FROM transactions WHERE is_group_visible(user_id)
    )
  );

CREATE POLICY "debt_settlements_group" ON debt_settlements
  USING (is_group_visible(user_id))
  WITH CHECK (is_group_visible(user_id));

-- ────────────────────────────────────────────────────────────
-- 6. RLS on the new group tables
-- ────────────────────────────────────────────────────────────

ALTER TABLE group_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_invitations ENABLE ROW LEVEL SECURITY;

-- group_memberships: visible to both host and member. INSERT happens ONLY
-- through accept_invitation() (no INSERT policy here). DELETE allowed by
-- either party (kick or leave). No UPDATEs supported.
CREATE POLICY "group_memberships_select" ON group_memberships
  FOR SELECT
  USING (host_user_id = auth.uid() OR member_user_id = auth.uid());

CREATE POLICY "group_memberships_delete" ON group_memberships
  FOR DELETE
  USING (host_user_id = auth.uid() OR member_user_id = auth.uid());

-- group_invitations: host sees their outbound; invitee sees inbound (matched
-- by email). INSERT only by host. UPDATE to 'revoked' only by host; UPDATE to
-- 'accepted' happens through accept_invitation() (security definer).
CREATE POLICY "group_invitations_select" ON group_invitations
  FOR SELECT
  USING (
    host_user_id = auth.uid()
    OR LOWER(invitee_email) = LOWER(
      (SELECT email FROM auth.users WHERE id = auth.uid())
    )
  );

CREATE POLICY "group_invitations_insert" ON group_invitations
  FOR INSERT
  WITH CHECK (host_user_id = auth.uid());

CREATE POLICY "group_invitations_update_revoke" ON group_invitations
  FOR UPDATE
  USING (host_user_id = auth.uid())
  WITH CHECK (host_user_id = auth.uid() AND status = 'revoked');

-- ────────────────────────────────────────────────────────────
-- 7. account_balances view — security_invoker so RLS follows the caller
-- ────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS account_balances;

CREATE VIEW account_balances
WITH (security_invoker = true)
AS
SELECT
  a.*,
  COALESCE((
    SELECT SUM(amt) FROM (
      SELECT t.amount AS amt
        FROM transactions t
       WHERE t.reserved_from_account_id = a.id
         AND t.settlement_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM transaction_items i WHERE i.transaction_id = t.id)
      UNION ALL
      SELECT ti.amount
        FROM transaction_items ti
       WHERE ti.reserved_from_account_id = a.id
         AND ti.settlement_id IS NULL
    ) u
  ), 0) AS total_reserved,
  a.balance - COALESCE((
    SELECT SUM(amt) FROM (
      SELECT t.amount AS amt
        FROM transactions t
       WHERE t.reserved_from_account_id = a.id
         AND t.settlement_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM transaction_items i WHERE i.transaction_id = t.id)
      UNION ALL
      SELECT ti.amount
        FROM transaction_items ti
       WHERE ti.reserved_from_account_id = a.id
         AND ti.settlement_id IS NULL
    ) u
  ), 0) AS available_balance
FROM accounts a
WHERE a.deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- 8. accept_invitation RPC
-- ------------------------------------------------------------
-- Validates a pending invitation token against the calling user's email,
-- inserts a group_memberships row, and flips the invitation to 'accepted'.
-- Returns the new membership.
--
-- Raised exceptions (callers surface these to the UI):
--   not_authenticated, invitation_not_found, invitation_not_pending,
--   invitation_expired, invitation_email_mismatch, cannot_self_join,
--   already_member.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION accept_invitation(p_token TEXT)
RETURNS group_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id  UUID := auth.uid();
  v_user_email TEXT;
  v_inv        group_invitations%ROWTYPE;
  v_membership group_memberships%ROWTYPE;
BEGIN
  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_member_id;

  SELECT * INTO v_inv
    FROM group_invitations
   WHERE token = p_token
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found';
  END IF;

  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'invitation_not_pending';
  END IF;

  IF v_inv.expires_at IS NOT NULL AND v_inv.expires_at < NOW() THEN
    UPDATE group_invitations SET status = 'expired' WHERE id = v_inv.id;
    RAISE EXCEPTION 'invitation_expired';
  END IF;

  IF LOWER(v_inv.invitee_email) <> LOWER(v_user_email) THEN
    RAISE EXCEPTION 'invitation_email_mismatch';
  END IF;

  IF v_inv.host_user_id = v_member_id THEN
    RAISE EXCEPTION 'cannot_self_join';
  END IF;

  IF EXISTS (
    SELECT 1 FROM group_memberships
     WHERE host_user_id   = v_inv.host_user_id
       AND member_user_id = v_member_id
  ) THEN
    RAISE EXCEPTION 'already_member';
  END IF;

  INSERT INTO group_memberships (host_user_id, member_user_id)
  VALUES (v_inv.host_user_id, v_member_id)
  RETURNING * INTO v_membership;

  UPDATE group_invitations
     SET status = 'accepted', accepted_at = NOW()
   WHERE id = v_inv.id;

  RETURN v_membership;
END;
$$;

GRANT EXECUTE ON FUNCTION accept_invitation(TEXT) TO authenticated;

COMMIT;
