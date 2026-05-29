-- ============================================================
-- Migration 0010 — link settlement-generated transfer rows to their settlement
--
-- reverseSettlement() (CLAUDE.md §7.4.3) must delete every transfer row a
-- settlement created. For a DIRECT settlement the pair is reachable via
-- debt_settlements.transfer_tx_id + its transfer_pair_id, but a CONDUIT
-- settlement (§7.4.2) also writes a second leg (via → creditor) that is linked
-- to nothing. We add an explicit FK that settle()/settleSelected() stamp on
-- ALL transfer rows a settlement creates (2 legs direct, 4 legs conduit).
-- ============================================================

BEGIN;

ALTER TABLE transactions
  ADD COLUMN settlement_transfer_id BIGINT REFERENCES debt_settlements(id);

CREATE INDEX idx_tx_settlement_transfer ON transactions(settlement_transfer_id);

-- Backfill DIRECT settlements only. A direct settlement's credit leg lands on
-- the creditor (in.account_id = ds.account_id); a conduit's first credit leg
-- lands on the `via` account, so we exclude it — the conduit's legs can't be
-- reliably identified from the settlement row and are left unlinked. (Existing
-- conduit settlements therefore can't be auto-reversed; reverse them by hand
-- per CLAUDE.md §7.4.3, or simply re-create them after this migration.)
UPDATE transactions t
   SET settlement_transfer_id = ds.id
  FROM debt_settlements ds
  JOIN transactions o ON o.id = ds.transfer_tx_id
  JOIN transactions i ON i.id = o.transfer_pair_id
 WHERE (t.id = o.id OR t.id = i.id)
   AND i.account_id = ds.account_id;

COMMIT;
