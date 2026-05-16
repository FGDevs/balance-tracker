-- ============================================================
-- Migration 0002 — transaction_items (rincian)
-- See CLAUDE.md §5.1 (table), §5.2 (RLS), §7.6 (rules).
--
-- Pure categorical breakdown for one transaction:
--  - parent.amount = SUM(items.amount) at create/update time
--  - items have no balance / settlement effect
--  - only allowed when parent.type IN ('income','expense') (enforced at service layer)
-- ============================================================

CREATE TABLE transaction_items (
  id              BIGINT        PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  transaction_id  BIGINT        NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id     BIGINT        REFERENCES categories(id) ON DELETE SET NULL,
  amount          DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  note            TEXT,
  position        SMALLINT      NOT NULL DEFAULT 0,
  created_at      TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX idx_tx_items_tx ON transaction_items(transaction_id);

ALTER TABLE transaction_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tx_items_own" ON transaction_items USING (
  transaction_id IN (SELECT id FROM transactions WHERE user_id = auth.uid())
);
