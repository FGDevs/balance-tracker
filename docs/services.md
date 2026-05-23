# Service API Contracts

> Canonical signatures live in `src/app/core/services/*.ts` — read those for the latest. This doc is the high-level overview + intent comments referenced by `CLAUDE.md §8`.

## SupabaseService
```typescript
getClient(): SupabaseClient
```

## AuthService
```typescript
currentUser: Signal<User | null>
session:     Signal<Session | null>
signIn(email: string, password: string): Promise<void>
signUp(email: string, password: string, name: string): Promise<void>
signOut(): Promise<void>
```

## AccountService
```typescript
accounts: Signal<AccountBalance[]>          // loaded from account_balances view
loadAccounts(): Promise<void>
getById(id: number): AccountBalance | undefined
create(data: Omit<Account, 'id' | 'user_id' | 'created_at'>): Promise<Account>
update(id: number, data: Partial<Account>): Promise<Account>
softDelete(id: number): Promise<void>       // sets deleted_at = timestamp
```

## TransactionService
```typescript
// settlement_id / parent_item_id are managed internally by the settle flow,
// never user-input; reserved_from_account_id IS user-input per item (CLAUDE.md §7.3, §7.6).
type ItemInput = Omit<TransactionItem,
  'id' | 'transaction_id' | 'created_at' | 'category'
  | 'reserved_from_account' | 'settlement_id' | 'parent_item_id'
>;

getByAccount(accountId: number, page?: number): Promise<Transaction[]>
getRecent(limit: number): Promise<Transaction[]>

// Transaction List calendar — all transactions on a specific local date, sorted
// by (sort_index DESC, id DESC). No pagination (single day is bounded). Honors viewer scope.
getByDate(date: string /* 'YYYY-MM-DD' */): Promise<Transaction[]>

// Transaction List calendar — set of 'YYYY-MM-DD' dates within the given
// 'YYYY-MM' month that have ≥1 visible transaction. Used to render the dot
// indicator under each in-month day cell. Honors viewer scope.
getTransactionDatesForMonth(month: string /* 'YYYY-MM' */): Promise<Set<string>>

// Bulk-apply new sort_index values. The drag-drop reorder UI batches all
// changes locally and calls this once on Save. No-op when updates is empty.
setSortIndices(updates: { id: number; sort_index: number }[]): Promise<void>

// One-shot adjacent swap by `sort_index`. Kept for any future surface that wants
// immediate persistence (current UI uses drag-drop + setSortIndices instead).
// `scope.accountId` restricts neighbor search to rows where `account_id` matches
// (same scoping as getByAccount — payer-side only).
interface ReorderScope { accountId?: number }
moveUp(id: number, scope?: ReorderScope): Promise<void>
moveDown(id: number, scope?: ReorderScope): Promise<void>

// Returns reservation entries — either whole parents (items-absent) or items
// (items-present). Each entry embeds its parent for context (date, account, note).
getUnsettledReservations(reservedFromAccountId: number): Promise<ReservationEntry[]>

// items?: when provided, parent.amount is overwritten with SUM(items.amount) and parent.category_id is forced NULL (CLAUDE.md §7.6).
create(
  data: Omit<Transaction, 'id' | 'user_id' | 'created_at'>,
  items?: ItemInput[],
): Promise<Transaction>

createTransfer(params: {
  fromAccountId: number;
  toAccountId: number;
  amount: number;
  date: string;
  note?: string;
  sortIndex?: number;          // optional; both paired rows share it; defaults to Date.now()
}): Promise<void>

createReservedExpense(params: {
  payerAccountId: number;          // who physically pays (credit card OR non-credit account)
  reservedFromAccountId: number;   // owing account (must be non-credit)
  categoryId?: number;
  amount: number;
  date: string;
  note?: string;
  items?: ItemInput[];             // optional rincian breakdown
}): Promise<Transaction>

// items?: undefined = leave items untouched. items?: array = replace all (and recompute parent.amount + null category).
// items?: null = clear all items.
update(id: number, data: Partial<Transaction>, items?: ItemInput[] | null): Promise<Transaction>

delete(id: number): Promise<void>
getItems(transactionId: number): Promise<TransactionItem[]>

// Calculator page (docs/ui-screens.md): physical-money perspective only — filters by
// account_id (NOT reserved_from_account_id). Returns all types including transfers
// (each transfer pair shows as two rows, one per side; when both sides are in scope
// they net to 0). Caps at 500 rows; the page surfaces a banner when the cap is reached.
getForCalculator(filters: {
  accountIds: number[] | 'all';
  dateFrom: string;   // 'YYYY-MM-DD' inclusive
  dateTo:   string;   // 'YYYY-MM-DD' inclusive
}): Promise<Transaction[]>

// Transaction Import Review (docs/ui-screens.md): returns all transactions on the
// picked import account whose date IN the given set. Caller passes the union of
// `draft.date ± 1` for every draft; page derives per-draft duplicate matches
// client-side from this single fetch. Sorted (date DESC, sort_index DESC, id DESC).
// Honors viewer scope. No pagination — bounded by import size.
getNearbyForImport(params: {
  accountId: number;
  dates: string[];   // 'YYYY-MM-DD'; deduped by caller; empty array → []
}): Promise<Transaction[]>
```

## SettlementService
```typescript
settle(params: {
  payerAccountId: number;          // lender / payee
  reservedFromAccountId: number;   // owing account
  paymentAmount: number;
  paymentDate: string;
}): Promise<DebtSettlement>

// Returns preview without writing to DB — use in settlement UI.
// Entries may be parent-kind or item-kind; the partial entry (if any) is whichever
// straddles the payment cutoff in FIFO order.
previewSettlement(params: {
  payerAccountId: number;
  reservedFromAccountId: number;
  paymentAmount: number;
}): Promise<{
  fullySettled: ReservationEntry[];
  partialEntry: ReservationEntry | null;
  remainderAmount: number;
  totalCovered: number;
}>
```

## CategoryService
```typescript
categories: Signal<Category[]>             // includes system defaults (user_id = null)
getByType(type: CategoryType): Category[]
create(data: Omit<Category, 'id'>): Promise<Category>
update(id: number, data: Partial<Category>): Promise<Category>
delete(id: number): Promise<void>
```

## BankImportService
```typescript
// One row extracted from a screenshot, awaiting user review.
// `note` is prefilled with the LLM's cleaned-up label and is the only editable note
// surface on the row — it lands verbatim in the saved transaction's `note` column.
// `rawDescription` is the verbatim screenshot text, surfaced read-only as "Asli".
// type='transfer' covers rows between the user's own accounts. The LLM infers
// `transferDirection` from the screenshot's +/- sign; the user picks the
// other-side account (`transferAccountId`) at review time.
export interface ImportDraft {
  date: string;                          // 'YYYY-MM-DD' (LLM resolves "Hari ini"/"Kemarin")
  amount: number;                        // positive
  type: 'income' | 'expense' | 'transfer';
  rawDescription: string;                // verbatim from the screenshot, read-only
  note: string;                          // editable; prefilled with LLM-cleaned label
  suggestedCategoryId?: number;          // best-fit (income/expense only)
  transferDirection?: 'in' | 'out';      // transfer only: 'out' = picked account is source
  transferAccountId?: number;            // transfer only: user picks at review
  skip: boolean;                         // user can untick rows on review (defaults false)
}

extract(params: {
  imageBlob: Blob;              // user upload; client compresses to <=1600px JPEG q80
  accountId: number;            // target account (picked before upload)
}): Promise<ImportDraft[]>

commit(params: {
  accountId: number;
  drafts: ImportDraft[];        // already user-edited; skip:true rows are filtered out
}): Promise<void>               // income/expense → TransactionService.create; transfer → createTransfer
```
The `extract-transactions` edge function is the only thing that touches the Gemini API. It returns `ImportDraft[]` with `suggestedCategoryId` resolved against the user's category list (server fetches categories with the user's JWT) and `transferDirection` set for transfer rows. Client never sees the LLM API key.

## GroupService
```typescript
// Membership rows: { host_user_id, member_user_id, joined_at, host?: Profile, member?: Profile }
myMemberships:   Signal<GroupMembership[]>   // groups I'm a member of (host info hydrated)
myMembers:       Signal<GroupMembership[]>   // members of MY group (member info hydrated)
pendingOutbound: Signal<GroupInvitation[]>   // invitations I sent that are still pending

loadAll(): Promise<void>
invite(email: string): Promise<GroupInvitation>     // creates a 'pending' invitation row (no email/link)
revoke(invitationId: number): Promise<void>          // host-only; flips status to 'revoked'
claimPendingInvitations(): Promise<number>           // calls claim_invitations_for_email RPC; returns # newly joined
kickMember(memberUserId: string): Promise<void>      // host removes a member from their group
leaveGroup(hostUserId: string): Promise<void>        // member leaves a host's group
```

Self-invites (`invitee_email === current user's email`) and duplicate pending invites for the same `(host, email)` throw at the service layer before reaching the DB.

`claimPendingInvitations()` is invoked on every authenticated app bootstrap by `AppShellComponent` so a freshly signed-in member auto-joins any host's group that pre-named their email. No tokens, no links. See `docs/groups.md` for the full flow.

## ViewerScopeService
```typescript
type ViewerScope = 'mine' | 'others' | 'all';

scope: Signal<ViewerScope>     // default 'all'; persisted to localStorage under 'viewerScope'
set(scope: ViewerScope): void
```

All list-fetching services read `ViewerScopeService.scope()` and apply:
- `'mine'`   → `.eq('created_by', auth.uid())`
- `'others'` → `.neq('created_by', auth.uid())`
- `'all'`    → no filter

Applies to: `AccountService.loadAccounts`, `TransactionService.getAll` / `getByAccount` / `getRecent` / `getByDate` / `getTransactionDatesForMonth` / `getForCalculator` / `getNearbyForImport`. The mutasi list on Account Detail (already scoped to `account_id`) ignores this filter — the page surfaces *all* mutations of that account regardless of who created them.
