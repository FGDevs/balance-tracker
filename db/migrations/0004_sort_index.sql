-- ============================================================
-- Migration 0004 — sort_index on transactions
-- See CLAUDE.md §3 (sort rule), §7.4 (settlement remainder copy),
-- §8 TransactionService (moveUp/moveDown), §9 Transaction List (reorder mode).
--
-- Rule: lists sort by (date DESC, sort_index DESC, id DESC).
-- Backfill seeds sort_index with id so existing order is preserved exactly.
-- New rows assign Date.now() at the service layer; imports assign explicit
-- descending values so screenshot top→bottom maps to list top→bottom.
-- ============================================================

BEGIN;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS sort_index BIGINT NOT NULL DEFAULT 0;

UPDATE transactions
   SET sort_index = id
 WHERE sort_index = 0;

CREATE INDEX IF NOT EXISTS idx_tx_user_date_sort
  ON transactions(user_id, date DESC, sort_index DESC);

COMMIT;
