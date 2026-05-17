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

-- ACCOUNTS
CREATE TABLE accounts (
  id                BIGINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id           UUID          NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
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
CREATE TABLE categories (
  id        BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id   UUID        REFERENCES profiles(id) ON DELETE CASCADE,  -- NULL = system default
  name      VARCHAR(80) NOT NULL,
  type      TEXT        NOT NULL CHECK (type IN ('income','expense','transfer')),
  icon      VARCHAR(50),
  color     VARCHAR(7),
  parent_id BIGINT      REFERENCES categories(id) ON DELETE SET NULL
);

-- DEBT_SETTLEMENTS  (created before transactions — FK added after)
-- Covers BOTH credit-card settlements AND inter-account debt settlements.
-- account_id               = lender / payee (who is owed and gets paid back)
-- reserved_from_account_id = owing account (whose available_balance was reduced)
CREATE TABLE debt_settlements (
  id                       BIGINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  transfer_tx_id           BIGINT,       -- FK added post-insert (circular dep)
  account_id               BIGINT        NOT NULL REFERENCES accounts(id),
  reserved_from_account_id BIGINT        NOT NULL REFERENCES accounts(id),
  total_amount             DECIMAL(15,2) NOT NULL,
  settled_at               TIMESTAMP     DEFAULT NOW(),
  CHECK (account_id <> reserved_from_account_id)
);

-- TRANSACTIONS  (core fact table)
CREATE TABLE transactions (
  id                       BIGINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id                  UUID          NOT NULL REFERENCES profiles(id),
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
CREATE TABLE transaction_items (
  id                       BIGINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  transaction_id           BIGINT        NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
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

-- TAGS  (optional — schema ready, UI is v2)
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
CREATE INDEX idx_tx_user_date        ON transactions(user_id, date DESC);
CREATE INDEX idx_tx_user_date_sort   ON transactions(user_id, date DESC, sort_index DESC);
CREATE INDEX idx_tx_account          ON transactions(account_id);
CREATE INDEX idx_tx_settlement       ON transactions(settlement_id);
CREATE INDEX idx_tx_reserved         ON transactions(reserved_from_account_id);
CREATE INDEX idx_tx_items_tx         ON transaction_items(transaction_id);
CREATE INDEX idx_tx_items_reserved   ON transaction_items(reserved_from_account_id);
CREATE INDEX idx_tx_items_settlement ON transaction_items(settlement_id);
CREATE INDEX idx_accounts_user       ON accounts(user_id);

-- ============================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE debt_settlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags              ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_tags  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_own"            ON profiles          USING (id = auth.uid());
CREATE POLICY "accounts_own"            ON accounts          USING (user_id = auth.uid());
CREATE POLICY "categories_own_system"   ON categories        USING (user_id = auth.uid() OR user_id IS NULL);
CREATE POLICY "transactions_own"        ON transactions      USING (user_id = auth.uid());
CREATE POLICY "tx_items_own"            ON transaction_items USING (
  transaction_id IN (SELECT id FROM transactions WHERE user_id = auth.uid())
);
CREATE POLICY "settlements_own"         ON debt_settlements  USING (
  account_id IN (SELECT id FROM accounts WHERE user_id = auth.uid())
);
CREATE POLICY "tags_own"                ON tags              USING (user_id = auth.uid());
CREATE POLICY "tx_tags_own"             ON transaction_tags  USING (
  transaction_id IN (SELECT id FROM transactions WHERE user_id = auth.uid())
);

-- ============================================================
-- 4. ACCOUNT_BALANCES VIEW
-- ------------------------------------------------------------
-- Always query this view for balances — never the accounts table directly.
-- total_reserved sums two disjoint sources (hybrid invariant):
--   a) parent-level reservations on transactions whose items list is empty
--   b) item-level reservations on transaction_items
-- ============================================================
CREATE OR REPLACE VIEW account_balances AS
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
-- 5. TRIGGERS
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
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', 'User'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
