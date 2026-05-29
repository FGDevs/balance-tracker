-- Balance Tracker — canonical DB schema.
-- Source of truth for tables, indexes, RLS, views, and triggers.
-- Live applied migrations live in db/migrations/. Keep this file in sync.

-- ============================================================
-- 1. TABLES
-- ============================================================

-- PROFILES  (extends Supabase auth.users)
CREATE TABLE profiles (
  id            UUID          PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name          VARCHAR(100)  NOT NULL,
  currency_code CHAR(3)       NOT NULL DEFAULT 'USD',
  created_at    TIMESTAMP     DEFAULT NOW(),
  updated_at    TIMESTAMP     DEFAULT NOW()
);

-- GROUP_MEMBERSHIPS  (drives §13 sharing — host invites member into their household)
CREATE TABLE group_memberships (
  host_user_id   UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  member_user_id UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (host_user_id, member_user_id),
  CHECK (host_user_id <> member_user_id)
);

-- GROUP_INVITATIONS  (pending/accepted/revoked/expired email invites)
-- Auto-bind flow: when a user with `invitee_email` signs in, the
-- claim_invitations_for_email() RPC accepts every matching pending row.
-- No links, no tokens — `token` is kept nullable for forward compat.
CREATE TABLE group_invitations (
  id            BIGINT       PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  host_user_id  UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  invitee_email TEXT         NOT NULL,
  token         TEXT         UNIQUE,
  status        TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','revoked','expired')),
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMP,
  accepted_at   TIMESTAMP
);

-- ACCOUNTS
-- user_id = group owner (host); created_by = the user who physically created
-- the row (may be host or a member acting in host's group).
CREATE TABLE accounts (
  id                BIGINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id           UUID          NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_by        UUID          NOT NULL REFERENCES profiles(id),
  name              VARCHAR(100)  NOT NULL,
  type              TEXT          NOT NULL CHECK (type IN ('cash','bank','credit','savings')),
  balance           DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  currency_code     CHAR(3)       NOT NULL DEFAULT 'USD',
  color             VARCHAR(7),
  deleted_at        TIMESTAMP,
  -- credit card only (nullable for non-credit)
  credit_limit      DECIMAL(15,2),
  statement_day     SMALLINT      CHECK (statement_day BETWEEN 1 AND 31),
  payment_due_day   SMALLINT      CHECK (payment_due_day BETWEEN 1 AND 31),
  created_at        TIMESTAMP     DEFAULT NOW()
);

-- CATEGORIES
-- user_id may be NULL for system defaults; created_by mirrors that (NULL for
-- system, host user_id for user-owned).
CREATE TABLE categories (
  id         BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id    UUID        REFERENCES profiles(id) ON DELETE CASCADE,  -- NULL = system default
  created_by UUID        REFERENCES profiles(id),                     -- NULL = system default
  name       VARCHAR(80) NOT NULL,
  type       TEXT        NOT NULL CHECK (type IN ('income','expense','transfer')),
  icon       VARCHAR(50),
  color      VARCHAR(7),
  parent_id  BIGINT      REFERENCES categories(id) ON DELETE SET NULL
);

-- DEBT_SETTLEMENTS  (created before transactions — FK added after)
-- Covers BOTH credit-card settlements AND inter-account debt settlements.
-- account_id               = lender / payee (who is owed and gets paid back)
-- reserved_from_account_id = owing account (whose available_balance was reduced)
-- user_id                  = group owner (= account.user_id for the lender)
-- created_by               = author (whoever ran the settle flow)
CREATE TABLE debt_settlements (
  id                       BIGINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  transfer_tx_id           BIGINT,       -- FK added post-insert (circular dep)
  user_id                  UUID          NOT NULL REFERENCES profiles(id),
  created_by               UUID          NOT NULL REFERENCES profiles(id),
  account_id               BIGINT        NOT NULL REFERENCES accounts(id),
  reserved_from_account_id BIGINT        NOT NULL REFERENCES accounts(id),
  total_amount             DECIMAL(15,2) NOT NULL,
  settled_at               TIMESTAMP     DEFAULT NOW(),
  CHECK (account_id <> reserved_from_account_id)
);

-- TRANSACTIONS  (core fact table)
-- user_id    = group owner (inherits from account.user_id — same group)
-- created_by = author (may be different from user_id for member-on-host actions)
CREATE TABLE transactions (
  id                       BIGINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id                  UUID          NOT NULL REFERENCES profiles(id),
  created_by               UUID          NOT NULL REFERENCES profiles(id),
  account_id               BIGINT        NOT NULL REFERENCES accounts(id),
  category_id              BIGINT        REFERENCES categories(id) ON DELETE SET NULL,
  amount                   DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  type                     TEXT          NOT NULL CHECK (type IN ('income','expense','transfer')),
  date                     DATE          NOT NULL,
  note                     TEXT,
  -- account reservation (credit-card OR inter-account debt — flavor inferred from account_id.type)
  reserved_from_account_id BIGINT        REFERENCES accounts(id),     -- owing account
  settlement_id            BIGINT        REFERENCES debt_settlements(id), -- NULL = still unsettled
  -- split tracking (partial settlement)
  parent_tx_id             BIGINT        REFERENCES transactions(id), -- self-ref: remainder row
  -- transfer linking
  transfer_pair_id         BIGINT        REFERENCES transactions(id), -- links 2 transfer rows
  -- settlement linkage: set on transfer rows generated by a settlement payoff
  -- (every leg, incl. the conduit's second leg) so reverseSettlement can delete
  -- them (§7.4.3). Distinct from settlement_id, which marks a settled reservation.
  settlement_transfer_id   BIGINT        REFERENCES debt_settlements(id),
  -- user-controlled ordering within a date group; service assigns Date.now() by default
  sort_index               BIGINT        NOT NULL DEFAULT 0,
  created_at               TIMESTAMP     DEFAULT NOW(),
  CHECK (reserved_from_account_id IS NULL OR reserved_from_account_id <> account_id)
);

ALTER TABLE debt_settlements
  ADD CONSTRAINT fk_transfer_tx
  FOREIGN KEY (transfer_tx_id) REFERENCES transactions(id);

-- TRANSACTION_ITEMS  (rincian — categorical breakdown of one transaction)
-- Items label a single cash event. They can optionally carry per-item reservation
-- (debt to another account). See CLAUDE.md §7.3 and §7.6 for the hybrid invariant:
-- when items exist, the parent's reservation columns are NULL and the breakdown
-- lives entirely in items.
-- created_by mirrors the parent transaction's author at insert time.
CREATE TABLE transaction_items (
  id                       BIGINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  transaction_id           BIGINT        NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_by               UUID          NOT NULL REFERENCES profiles(id),
  category_id              BIGINT        REFERENCES categories(id) ON DELETE SET NULL,
  amount                   DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  note                     TEXT,
  position                 SMALLINT      NOT NULL DEFAULT 0,
  -- per-item reservation (mirrors transactions reserved/settlement columns)
  reserved_from_account_id BIGINT        REFERENCES accounts(id),
  settlement_id            BIGINT        REFERENCES debt_settlements(id),
  parent_item_id           BIGINT        REFERENCES transaction_items(id),
  created_at               TIMESTAMP     DEFAULT NOW()
);

-- TAGS  (optional — schema ready, UI is v2). Tags stay strictly per-user for v1;
-- they are NOT group-shared.
CREATE TABLE tags (
  id      BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name    VARCHAR(50) NOT NULL
);

CREATE TABLE transaction_tags (
  transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id         BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, tag_id)
);

-- ============================================================
-- 2. INDEXES
-- ============================================================
CREATE INDEX idx_tx_user_date              ON transactions(user_id, date DESC);
CREATE INDEX idx_tx_user_date_sort         ON transactions(user_id, date DESC, sort_index DESC);
CREATE INDEX idx_tx_account                ON transactions(account_id);
CREATE INDEX idx_tx_settlement             ON transactions(settlement_id);
CREATE INDEX idx_tx_settlement_transfer    ON transactions(settlement_transfer_id);
CREATE INDEX idx_tx_reserved               ON transactions(reserved_from_account_id);
CREATE INDEX idx_tx_items_tx               ON transaction_items(transaction_id);
CREATE INDEX idx_tx_items_reserved         ON transaction_items(reserved_from_account_id);
CREATE INDEX idx_tx_items_settlement       ON transaction_items(settlement_id);
CREATE INDEX idx_accounts_user             ON accounts(user_id);
CREATE INDEX idx_debt_settlements_user     ON debt_settlements(user_id);
CREATE INDEX idx_group_memberships_member  ON group_memberships(member_user_id);
CREATE INDEX idx_group_invitations_host_status
  ON group_invitations(host_user_id, status);
CREATE INDEX idx_group_invitations_email
  ON group_invitations(LOWER(invitee_email));

-- ============================================================
-- 3. ROW LEVEL SECURITY
-- ------------------------------------------------------------
-- All group-shared tables use is_group_visible(user_id) — see §13.
-- A row is visible/writable when:
--   user_id = auth.uid()  (you are the group owner)  OR
--   you are a member of that user's group via group_memberships.
-- ============================================================
ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE debt_settlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags              ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_tags  ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_invitations ENABLE ROW LEVEL SECURITY;

-- Supabase's default privileges don't always auto-grant on tables added by
-- raw migrations; without explicit GRANT, queries hit "permission denied"
-- before RLS gets a turn. Grant directly.
GRANT SELECT, INSERT, UPDATE, DELETE ON group_memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON group_invitations TO authenticated;

-- Membership helper. SECURITY DEFINER lets it read group_memberships even
-- when invoked from an RLS context that hasn't evaluated membership yet.
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

-- profiles SELECT is widened so group-mates can resolve each other's names
-- (foreign-author annotations on Account Card / Transaction rows). UPDATE
-- stays strictly to the user's own row.
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

CREATE POLICY "profiles_update_own"     ON profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "accounts_group"          ON accounts
  USING (is_group_visible(user_id))
  WITH CHECK (is_group_visible(user_id));

CREATE POLICY "categories_group"        ON categories
  USING (user_id IS NULL OR is_group_visible(user_id))
  WITH CHECK (user_id IS NULL OR is_group_visible(user_id));

CREATE POLICY "transactions_group"      ON transactions
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

CREATE POLICY "debt_settlements_group"  ON debt_settlements
  USING (is_group_visible(user_id))
  WITH CHECK (is_group_visible(user_id));

CREATE POLICY "tags_own"                ON tags              USING (user_id = auth.uid());
CREATE POLICY "tx_tags_own"             ON transaction_tags  USING (
  transaction_id IN (SELECT id FROM transactions WHERE user_id = auth.uid())
);

-- group_memberships: SELECT/DELETE by either party. INSERT only via
-- accept_invitation() RPC (no INSERT policy). UPDATEs not supported.
CREATE POLICY "group_memberships_select" ON group_memberships
  FOR SELECT
  USING (host_user_id = auth.uid() OR member_user_id = auth.uid());

CREATE POLICY "group_memberships_delete" ON group_memberships
  FOR DELETE
  USING (host_user_id = auth.uid() OR member_user_id = auth.uid());

-- group_invitations: host sees their outbound. Invitees never need to see
-- invitations directly — the auto-bind SECURITY DEFINER RPC (§13.5) matches
-- email server-side. (Earlier we had an invitee-side clause reading
-- auth.users, but authenticated has no grant there, so the policy errored.)
-- INSERT only by host. UPDATE to 'revoked' only by host; UPDATE to
-- 'accepted' / 'expired' happens through claim_invitations_for_email().
CREATE POLICY "group_invitations_select" ON group_invitations
  FOR SELECT
  USING (host_user_id = auth.uid());

CREATE POLICY "group_invitations_insert" ON group_invitations
  FOR INSERT
  WITH CHECK (host_user_id = auth.uid());

CREATE POLICY "group_invitations_update_revoke" ON group_invitations
  FOR UPDATE
  USING (host_user_id = auth.uid())
  WITH CHECK (host_user_id = auth.uid() AND status = 'revoked');

-- ============================================================
-- 4. ACCOUNT_BALANCES VIEW
-- ------------------------------------------------------------
-- Always query this view for balances — never the accounts table directly.
-- total_reserved sums two disjoint sources (hybrid invariant):
--   a) parent-level reservations on transactions whose items list is empty
--   b) item-level reservations on transaction_items
-- security_invoker = true so the view follows the calling user's RLS on the
-- underlying accounts table (group-aware visibility).
-- ============================================================
CREATE OR REPLACE VIEW account_balances
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

-- ============================================================
-- 5. TRIGGERS & FUNCTIONS
-- ============================================================

-- Hybrid-invariant: ensure parent reservation columns are NULL whenever the
-- transaction has >= 1 item row. Service layer also enforces this; trigger is
-- the safety net. See CLAUDE.md §7.3.
CREATE OR REPLACE FUNCTION enforce_hybrid_reservation()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM transaction_items WHERE transaction_id = NEW.transaction_id) THEN
    UPDATE transactions
       SET reserved_from_account_id = NULL,
           settlement_id            = NULL
     WHERE id = NEW.transaction_id
       AND (reserved_from_account_id IS NOT NULL OR settlement_id IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hybrid_reservation_after_item
  AFTER INSERT ON transaction_items
  FOR EACH ROW EXECUTE FUNCTION enforce_hybrid_reservation();

-- Auto-create profile row when a new auth.users row appears.
-- Needs SET row_security = off because the profiles table has no INSERT
-- policy (only SELECT + UPDATE — see §13). SECURITY DEFINER alone doesn't
-- bypass RLS unless the function owner has BYPASSRLS, so we set it
-- explicitly at function scope.
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

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- claim_invitations_for_email RPC — see CLAUDE.md §13.5.
-- Looks up the caller's auth.users.email and accepts every matching 'pending'
-- invitation row (creates the membership, flips invitation to 'accepted').
-- Self-invites and rows where membership already exists are silently skipped
-- (the invitation is closed so it doesn't keep showing up). Past-expiry
-- pending rows for the same email are flipped to 'expired' as a side effect.
-- Returns the number of NEW memberships created in this call.
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
    IF v_inv.host_user_id = v_member_id THEN
      UPDATE group_invitations SET status = 'revoked' WHERE id = v_inv.id;
      CONTINUE;
    END IF;

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
