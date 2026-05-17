export type AccountType = 'cash' | 'bank' | 'credit' | 'savings';
export type TransactionType = 'income' | 'expense' | 'transfer';
export type CategoryType = 'income' | 'expense' | 'transfer';

export interface Profile {
  id: string;
  name: string;
  currency_code: string;
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: number;
  user_id: string;
  name: string;
  type: AccountType;
  balance: number;
  currency_code: string;
  color?: string;
  deleted_at?: string | null;
  credit_limit?: number;
  statement_day?: number;
  payment_due_day?: number;
  created_at: string;
}

export interface AccountBalance extends Account {
  total_reserved: number;
  available_balance: number;
}

export interface Category {
  id: number;
  user_id: string | null;
  name: string;
  type: CategoryType;
  icon?: string;
  color?: string;
  parent_id?: number;
}

export interface Transaction {
  id: number;
  user_id: string;
  account_id: number;
  category_id?: number;       // NULL when items[] is non-empty (see §7.6)
  amount: number;             // equals SUM(items.amount) at create/update time
  type: TransactionType;
  date: string;
  note?: string;
  reserved_from_account_id?: number;
  settlement_id?: number;
  parent_tx_id?: number;
  transfer_pair_id?: number;
  sort_index?: number;          // DB NOT NULL; optional at write time (service defaults to Date.now())
  created_at: string;
  category?: Category;
  account?: Account;
  reserved_from_account?: Account;
  items?: TransactionItem[];
}

export interface TransactionItem {
  id: number;
  transaction_id: number;
  category_id?: number;
  amount: number;
  note?: string;
  position: number;
  // per-item reservation (§7.3 hybrid invariant, §7.6)
  reserved_from_account_id?: number;
  settlement_id?: number;
  parent_item_id?: number;
  created_at: string;
  category?: Category;
  reserved_from_account?: Account;
}

// One unsettled reservation entry — either a parent-level reservation
// (items absent) or an item-level reservation (items present).
export interface ReservationEntry {
  kind: 'parent' | 'item';
  id: number;
  amount: number;
  parent: Transaction;
  category?: Category;
  note?: string;
}

export interface DebtSettlement {
  id: number;
  transfer_tx_id?: number;
  account_id: number;
  reserved_from_account_id: number;
  total_amount: number;
  settled_at: string;
}

export interface Tag {
  id: number;
  user_id: string;
  name: string;
}

// One row extracted from a bank screenshot, awaiting user review (see §9 Transaction Import).
// `note` is prefilled with the LLM's cleaned-up label and is user-editable — it becomes
// the saved transaction's `note` column verbatim. `rawDescription` is the verbatim text
// from the screenshot, kept around as read-only "Asli" reference in the review UI.
// For type='transfer', `transferDirection` is set by the LLM from the screenshot's sign:
//   'out' → money left the picked account (picked = from, user picks `to`)
//   'in'  → money entered the picked account (picked = to,   user picks `from`)
// `transferAccountId` is the user's selection of the other side at review time.
export interface ImportDraft {
  date: string;
  amount: number;
  type: 'income' | 'expense' | 'transfer';
  rawDescription: string;
  note?: string;
  suggestedCategoryId?: number;
  transferDirection?: 'in' | 'out';
  transferAccountId?: number;
  skip: boolean;
}
