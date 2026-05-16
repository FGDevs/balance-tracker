-- Migration: rename cc_settlements -> debt_settlements; unify credit-card and inter-account debt.
-- Run once in the Supabase SQL editor.
-- Safe to run on a DB that already has cc_settlements; idempotent guards included where useful.

BEGIN;

-- 1. Rename the table. Existing FKs on transactions.settlement_id auto-follow the rename.
ALTER TABLE IF EXISTS cc_settlements RENAME TO debt_settlements;

-- 2. Add CHECK constraints (skip if already present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'debt_settlements_distinct_accounts'
  ) THEN
    ALTER TABLE debt_settlements
      ADD CONSTRAINT debt_settlements_distinct_accounts
      CHECK (account_id <> reserved_from_account_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_distinct_payer_owing'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_distinct_payer_owing
      CHECK (
        reserved_from_account_id IS NULL
        OR reserved_from_account_id <> account_id
      );
  END IF;
END $$;

-- 3. Replace the RLS policy on the renamed table.
DROP POLICY IF EXISTS "settlements_own" ON debt_settlements;
CREATE POLICY "settlements_own" ON debt_settlements
  USING (
    account_id IN (SELECT id FROM accounts WHERE user_id = auth.uid())
  );

-- 4. Ensure RLS is enabled (idempotent).
ALTER TABLE debt_settlements ENABLE ROW LEVEL SECURITY;

COMMIT;
