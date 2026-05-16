-- ============================================================
-- Migration 0003 — per-item reservation (rincian-level debt)
-- See CLAUDE.md §5.1 (DDL), §5.3 (view), §7.3 (hybrid invariant),
-- §7.4 (settlement FIFO), §7.6 (rules).
--
-- Hybrid rule:
--   - When a transaction has NO items: parent-level reservation columns apply (existing behavior).
--   - When a transaction has >=1 items: parent-level reservation columns are FORCED NULL;
--     each item independently carries reserved_from_account_id / settlement_id.
-- ============================================================

BEGIN;

-- 1. Schema: per-item reservation columns + self-ref for split-by-partial-settle.
ALTER TABLE transaction_items
  ADD COLUMN IF NOT EXISTS reserved_from_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS settlement_id            BIGINT REFERENCES debt_settlements(id),
  ADD COLUMN IF NOT EXISTS parent_item_id           BIGINT REFERENCES transaction_items(id);

CREATE INDEX IF NOT EXISTS idx_tx_items_reserved
  ON transaction_items(reserved_from_account_id);
CREATE INDEX IF NOT EXISTS idx_tx_items_settlement
  ON transaction_items(settlement_id);

-- 2. Trigger: when an item is inserted for a transaction that currently carries
--    parent-level reservation, clear the parent's columns. This is the safety net
--    behind the service-layer enforcement of the hybrid invariant.
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

DROP TRIGGER IF EXISTS trg_hybrid_reservation_after_item ON transaction_items;
CREATE TRIGGER trg_hybrid_reservation_after_item
  AFTER INSERT ON transaction_items
  FOR EACH ROW EXECUTE FUNCTION enforce_hybrid_reservation();

-- 3. Replace the account_balances view: total_reserved now sums TWO disjoint sources.
DROP VIEW IF EXISTS account_balances;

CREATE VIEW account_balances AS
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

COMMIT;
