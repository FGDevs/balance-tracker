# CLAUDE.md — Balance Tracker
> Read this entire file before writing any code, migration, or file.
> This is the single source of truth for project rules and business logic.

> Referenced files (load on demand):
> - **DB schema (DDL, RLS, view, triggers):** `db/schema.sql` — applied migrations in `db/migrations/`
> - **TypeScript models:** `src/app/core/models/index.ts` (canonical — do not duplicate here)
> - **Design recipes + Tailwind config:** `docs/design-system.md`; live config at `tailwind.config.js`, vars at `src/theme/variables.scss`
> - **Setup / bootstrap commands:** `docs/setup.md`

---

## 1. Project Purpose

A **personal finance balance tracker** mobile app. Core goal: know the **actual available balance** of each account at any moment — accounting for money reserved by credit card spending that has not yet been paid off.

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Frontend framework | Angular 17+ (standalone components) |
| Mobile UI | Ionic 7 (restricted set — see §3) + plain HTML styled with Tailwind |
| Styling | Tailwind CSS (no component-level CSS files) |
| State management | Angular Signals (`signal`, `computed`, `effect`) |
| Drag & drop | `@angular/cdk/drag-drop` (used in transaction reorder mode) |
| Backend + DB | Supabase (PostgreSQL + Auth + PostgREST) |
| Native bridge | Capacitor 5 |
| Deployment | Vercel (frontend) |

---

## 3. Absolute Coding Rules

### Angular
- All components are **standalone** — never use NgModules
- Use `inject()` — never constructor injection
- Use **Signals** for all state — never RxJS Subject / BehaviorSubject
- Use signal-based APIs: `input()`, `output()`, `viewChild()`
- Lazy-load all pages via `loadComponent` in the router
- Route guards use `CanActivateFn` (functional form only)
- Use `@for`, `@if`, `@switch` control flow — never `*ngFor`, `*ngIf`
- Every component uses `templateUrl` with a sibling `.html` file — never inline `template:` strings

### Ionic
- Use ONLY these Ionic components — everything else must be plain HTML + Tailwind:
  - `ion-content`
  - `ion-router-outlet`
  - `ion-refresher` (with `ion-refresher-content`)
  - `ion-modal`
  - `ion-infinite-scroll` (with `ion-infinite-scroll-content`)
  - `ion-fab` (with `ion-fab-button`, `ion-fab-list` as needed)
- Do NOT use: `ion-header`, `ion-toolbar`, `ion-title`, `ion-button`, `ion-input`, `ion-item`, `ion-list`, `ion-card`, `ion-label`, `ion-icon`, `ion-segment`, `ion-checkbox`, `ion-toggle`, `ion-select`, `ion-datetime`, `ion-toast`, `ion-alert`, `ion-action-sheet`, etc.
- Build buttons, inputs, selects, headers, lists, cards, toasts, sheets as plain HTML elements styled with Tailwind
- Use `@capacitor/haptics` on every destructive or key action

### Tailwind
- No `styleUrls` or `styles` arrays in any component — Tailwind classes only
- For the allowed Ionic components, theme through Ionic CSS variables rather than Tailwind `bg-*`/`text-*` overrides
- All Tailwind colors are CSS-variable-backed (`var(--color-*)`) — no hardcoded hex
- `src/global.scss` declares `@tailwind base; @tailwind components; @tailwind utilities;` above the Ionic CSS imports

### Supabase
- Single `SupabaseService` wraps the client — never import `createClient` elsewhere
- All DB calls go through service classes — never call supabase directly from components
- Always use Row Level Security — no table readable without RLS policy
- Handle errors explicitly — never silently swallow Supabase errors
- Use Supabase Auth for session — no custom JWT logic

### General
- All money is `DECIMAL(15,2)` in DB and `number` in TypeScript
- Amounts are **always stored as positive** — `type` field determines direction
- Dates stored as `DATE` (`'YYYY-MM-DD'` string) for transactions, not TIMESTAMP
- Use `async/await` — no `.then()/.catch()` chains
- Export all interfaces from `src/app/core/models/index.ts`
- Transaction display queries sort by `(date DESC, sort_index DESC, id DESC)`. `sort_index` defaults to `Date.now()` for manual entries; imports assign explicit descending values; settlement remainders copy the original's `sort_index`. FIFO settlement still orders by `(date ASC, id ASC)` — chronology, not user ordering.

---

## 4. Project Structure

```
src/
├── app/
│   ├── core/
│   │   ├── models/index.ts                 # all interfaces exported here
│   │   ├── services/
│   │   │   ├── supabase.service.ts         # Supabase client singleton
│   │   │   ├── auth.service.ts             # login, logout, session signal
│   │   │   ├── account.service.ts          # CRUD + availableBalance
│   │   │   ├── transaction.service.ts      # CRUD + reservation logic
│   │   │   ├── category.service.ts         # CRUD categories
│   │   │   ├── settlement.service.ts       # bulk + partial settlement
│   │   │   └── bank-import.service.ts      # screenshot → extract-transactions edge fn
│   │   └── guards/auth.guard.ts            # CanActivateFn
│   ├── shell/app-shell.component.{ts,html} # bottom tab bar + ion-router-outlet for authed routes
│   ├── pages/
│   │   ├── auth/login/
│   │   ├── dashboard/                      # total + all account cards
│   │   ├── accounts/{account-list,account-detail,account-form}/
│   │   ├── transactions/{transaction-list,transaction-form,transaction-import}/
│   │   ├── settlements/settlement-form/    # bulk pay + partial split UI
│   │   ├── categories/
│   │   ├── calculator/                     # tally selected transactions (filters + sticky total)
│   │   └── profile/                        # name, email, sign out (v1 stub)
│   ├── shared/components/{amount-display,account-card,transaction-item,currency-input}/
│   ├── shared/pipes/currency-format.pipe.ts
│   └── app.routes.ts
├── environments/{environment.ts, environment.prod.ts}  # generated, gitignored
└── theme/variables.scss                    # Ionic CSS vars + design tokens

supabase/
└── functions/extract-transactions/         # Deno edge function, Gemini vision call
```

---

## 5. Database Schema

Full DDL, indexes, RLS policies, the `account_balances` view, and triggers live in **`db/schema.sql`**. Applied migrations are in `db/migrations/`.

Key entry points:
- `account_balances` view — **always query this for balances**, never `accounts` directly. It surfaces `total_reserved` and `available_balance` per the hybrid invariant (§7.3).
- `enforce_hybrid_reservation` trigger — safety net for §7.3; service layer is primary enforcer.
- `handle_new_user` trigger — auto-creates a `profiles` row when an `auth.users` row appears.

---

## 6. TypeScript Models

Canonical definitions live in **`src/app/core/models/index.ts`** — read that file directly. Do not duplicate type definitions in this document.

Key types: `Profile`, `Account`, `AccountBalance` (extends Account with view columns), `Category`, `Transaction`, `TransactionItem`, `ReservationEntry` (parent-or-item union for settlement UI), `DebtSettlement`, `Tag`. All money fields are `number`; all dates on transactions are `'YYYY-MM-DD'` strings.

---

## 7. Business Logic Rules

### 7.1 Balance
- `balance` on accounts = actual real-world balance. Only moves when real money transfers.
- `available_balance` = `balance − SUM(unsettled reservations)`. Computed from the view, never stored.
- Credit account `balance` is always ≤ 0 (negative = debt owed to bank).
- `available_credit` = `credit_limit + balance` (balance is negative, so this is remaining credit).

### 7.2 Transaction Direction
- `amount` always stored **positive**.
- `income`   → `account.balance += amount`
- `expense`  → `account.balance -= amount`
- `transfer` → **two rows** linked via `transfer_pair_id`:
  - Row A: debit source account (`balance -= amount`)
  - Row B: credit destination account (`balance += amount`)

### 7.3 Account Reservation  (covers credit-card AND inter-account debt)
When the account that physically pays an expense differs from the account the expense logically belongs to:
- `account_id`                = payer (who lost the money / took on the debt)
- `reserved_from_account_id` = owing account (whose `available_balance` should drop)
- `settlement_id`            = NULL until paid back

Two flavors, distinguished by `account_id.type` — same DB structure, same view, same settlement algorithm:

**Flavor A — Credit-card reservation:** `payer.type = 'credit'`.
- credit card `balance`   -= amount  (card took on debt; balance grows more negative)
- owing account `balance` unchanged  (no real money moved)
- owing account's `available_balance` decreases via the view

**Flavor B — Inter-account debt:** `payer.type ∈ {cash, bank, savings}` AND `owing.type ∈ {cash, bank, savings}`.
- payer `balance`         -= amount  (real money physically left the payer)
- owing account `balance` unchanged
- owing account's `available_balance` decreases via the view
- payer's `available_balance` reflects only its own real balance — it does NOT get a phantom +amount boost; money is recovered via settlement

Constraints:
- `account_id <> reserved_from_account_id`
- The owing account must not have `type = 'credit'` (you cannot "owe" to a credit card via a reservation; pay it down via Flavor A settlement instead)

**Hybrid invariant — where reservation lives.** Reservation columns (`reserved_from_account_id`, `settlement_id`) exist on **both** `transactions` and `transaction_items`. They are mutually exclusive per transaction:
- When a transaction has **no items**, parent-level columns carry the reservation. The whole cash event has one flavor or no reservation.
- When a transaction has **≥1 item**, parent-level columns MUST be NULL; each item independently sets its own `reserved_from_account_id` (or NULL = pure label). Items within one parent can mix reserved and non-reserved freely. Example: a 100K `belanja` expense with `[70K soap (no reserve), 30K diapers (reserved_from=baby)]` — one bank mutation, one item in debt.

Item-level reservation obeys the same constraints as parent-level: `item.reserved_from_account_id <> parent.account_id` and the owing account must not be of type `'credit'`. Flavor is still inferred from `parent.account_id.type` — the item only names the owing account.

The `account_balances` view sums both sources into one `total_reserved` per account.

### 7.4 Settlement — Bulk + Partial (FIFO) — same algorithm for both flavors
```
Input: payment_amount, payer_account_id (lender), reserved_from_account_id (owing), payment_date

1. Create debt_settlements row (transfer_tx_id = NULL initially)
2. Create transfer transaction:
     from reserved_from_account_id  →  payer_account_id
     amount = payment_amount, date = payment_date
   Capture the new transaction id.
   This transfer alone moves the real money correctly:
     - Flavor A: owing bank → credit card  (CC balance climbs from -X toward 0)
     - Flavor B: owing account → lender    (lender's real cash is restored)
3. Update debt_settlements.transfer_tx_id = transfer tx id
4. Fetch unsettled reservation ENTRIES — a UNION of two sources:
     a) parent-level (items list is empty):
        SELECT 'parent' AS kind, t.id, t.amount, t.date, t.id AS sort_secondary, 0 AS sort_tertiary
        FROM transactions t
        WHERE t.reserved_from_account_id = <owing>
          AND t.account_id              = <payer / lender>
          AND t.settlement_id           IS NULL
          AND NOT EXISTS (SELECT 1 FROM transaction_items i WHERE i.transaction_id = t.id)
     b) item-level:
        SELECT 'item' AS kind, ti.id, ti.amount, t.date, t.id AS sort_secondary, ti.position AS sort_tertiary
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
        WHERE ti.reserved_from_account_id = <owing>
          AND t.account_id               = <payer / lender>
          AND ti.settlement_id           IS NULL
     ORDER BY date ASC, sort_secondary ASC, sort_tertiary ASC   -- FIFO

5. remaining = payment_amount
6. For each entry in reservations:
     if remaining <= 0: break
     if entry.amount <= remaining:
       set settlement_id on the entry's row (parent OR item)       ← fully settled
       remaining -= entry.amount
     else:
       settled_portion  = remaining
       remainder_amount = entry.amount - remaining
       if entry.kind = 'parent':
         UPDATE transactions
            SET amount = settled_portion, settlement_id = settlement.id
          WHERE id = entry.id
         INSERT new transactions row:
           amount = remainder_amount, parent_tx_id = entry.id, settlement_id = NULL,
           same account_id / reserved_from_account_id / type / date / note / category_id / sort_index
       else:  -- entry.kind = 'item'
         UPDATE transaction_items
            SET amount = settled_portion, settlement_id = settlement.id
          WHERE id = entry.id
         INSERT new transaction_items row:
           amount = remainder_amount, parent_item_id = entry.id, settlement_id = NULL,
           same transaction_id / category_id / note / position / reserved_from_account_id
         -- parent transaction stays as one row — bank-statement consistency
       remaining = 0

NOTE: do NOT additionally adjust accounts.balance after the loop. The transfer in step 2 is the
only real-money movement — applying another debit on top would double-count.

NOTE on parent.amount when splitting items: the parent.amount is unchanged after item splits.
SUM(items.amount) still equals parent.amount because (settled_portion + remainder_amount) == entry.amount.
```

### 7.5 Credit Utilization
```
utilization_pct  = ABS(balance) / credit_limit * 100
available_credit = credit_limit + balance
```

### 7.6 Transaction Items (rincian)

A transaction may carry an optional categorical breakdown via `transaction_items` ("rincian"). Items label one cash event and can optionally carry per-item reservations.

Rules:
- Only `type ∈ {income, expense}` may have items. `transfer` cannot.
- When items exist, the parent's `category_id`, `reserved_from_account_id`, and `settlement_id` are all NULL (§7.3 hybrid invariant). The breakdown — including any debt-routing — lives entirely in items.
- **Invariant at create/update time**: `parent.amount = SUM(items.amount)`. The DB does not enforce this; `TransactionService.create` / `update` validate and coerce it.
- All items have `amount > 0`.
- **Per-item reservation**: each item may set `reserved_from_account_id` (debt-owing account, must be non-credit, must ≠ parent.account_id). NULL = pure label. Items within one parent may mix freely.
- Account balance math operates on `parent.amount` — items do NOT affect `accounts.balance`. The `account_balances` view sums item-level reservations into the owing account's `total_reserved`.
- **Settlement splits at the item level** (§7.4). When a partial payback straddles an item, the item is split into a settled + remainder pair (remainder has `parent_item_id` = original); the parent transaction stays as one row — bank-statement consistency. `SUM(items.amount) = parent.amount` is preserved across item splits.
- For category-and-debt reporting on a transaction with mixed settled/unsettled items, query items directly rather than relying on `parent.amount`.
- **v1 edit limitation**: existing split transaction's items render read-only in the Transaction Form (including per-item reservation). To change items, delete and recreate.

---

## 8. Service API Contracts

### SupabaseService
```typescript
getClient(): SupabaseClient
```

### AuthService
```typescript
currentUser: Signal<User | null>
session:     Signal<Session | null>
signIn(email: string, password: string): Promise<void>
signUp(email: string, password: string, name: string): Promise<void>
signOut(): Promise<void>
```

### AccountService
```typescript
accounts: Signal<AccountBalance[]>          // loaded from account_balances view
loadAccounts(): Promise<void>
getById(id: number): AccountBalance | undefined
create(data: Omit<Account, 'id' | 'user_id' | 'created_at'>): Promise<Account>
update(id: number, data: Partial<Account>): Promise<Account>
softDelete(id: number): Promise<void>       // sets deleted_at = timestamp
```

### TransactionService
```typescript
// settlement_id / parent_item_id are managed internally by the settle flow,
// never user-input; reserved_from_account_id IS user-input per item (§7.3, §7.6).
type ItemInput = Omit<TransactionItem,
  'id' | 'transaction_id' | 'created_at' | 'category'
  | 'reserved_from_account' | 'settlement_id' | 'parent_item_id'
>;

getByAccount(accountId: number, page?: number): Promise<Transaction[]>
getRecent(limit: number): Promise<Transaction[]>

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

// items?: when provided, parent.amount is overwritten with SUM(items.amount) and parent.category_id is forced NULL (§7.6).
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

// Calculator page (§9): physical-money perspective only — filters by account_id (NOT
// reserved_from_account_id). Excludes transfers (net to 0 within user's accounts).
// Caps at 500 rows; the page surfaces a banner when the cap is reached.
getForCalculator(filters: {
  accountIds: number[] | 'all';
  dateFrom: string;   // 'YYYY-MM-DD' inclusive
  dateTo:   string;   // 'YYYY-MM-DD' inclusive
}): Promise<Transaction[]>
```

### SettlementService
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

### CategoryService
```typescript
categories: Signal<Category[]>             // includes system defaults (user_id = null)
getByType(type: CategoryType): Category[]
create(data: Omit<Category, 'id'>): Promise<Category>
update(id: number, data: Partial<Category>): Promise<Category>
delete(id: number): Promise<void>
```

### BankImportService
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

---

## 9. UI Screens & Key Behavior

> All "cards", "buttons", "headers", "toolbars", "lists", "toggles", "pickers", "CTAs" below are plain HTML + Tailwind. Only `ion-content`, `ion-router-outlet`, `ion-refresher`, `ion-modal`, `ion-infinite-scroll`, `ion-fab` come from Ionic.

### Dashboard
- Sum of `balance` (Aktual saldo) across all active accounts at top — `Tersedia` is intentionally not shown in the UI
- Sub-line "Hutang aktif" chip — sum of `total_reserved` (non-credit accounts owing other accounts) + `ABS(balance)` (credit cards owing the bank); shown only if > 0
- Account cards grid (plain `div` + Tailwind): name, type icon, `balance` large (Aktual), debt chip below if account has debt (see Account Card)
- Credit card cards: add utilization bar (`ABS(balance) / credit_limit`)
- The page does not own a FAB — quick-add lives in the global Tab Bar (see below)

### Account Card
- Big number: `balance` labeled "Aktual"
- Below: `Hutang Rp X` coral-tinted chip when this account owes money
  - Non-credit account: chip amount = `total_reserved` (what this account owes other accounts)
  - Credit account: chip amount = `ABS(balance)` (what's owed to the bank)
  - Hide chip when zero
- `available_balance` is computed in the view but not displayed on the card; it remains available to services/logic that need to answer "can this account afford X?"

### Tab Bar (mobile shell)
- Plain HTML floating pill bar fixed at the bottom safe area (`pb-[max(1rem,env(safe-area-inset-bottom))]`); `bg-card`, `rounded-full`, `shadow`, `max-w-md` centered
- Five slots, left → right: **Dashboard · Accounts · ⊕ Center FAB · Transactions · Profile**
- The center FAB is accent-orange and protrudes ~24px above the bar; tap → `/transactions/new`, long-press (450ms) → expands a vertical fab list with four pills, ordered top→bottom: Kategori, Kalkulator, Impor, Transaksi (closest to the FAB = most frequent; Impor sits adjacent to Transaksi because it's a transaction-creation shortcut). The plus glyph rotates 45° (→ ×) when the menu is open.
- Active tab uses `text-ink` + a 4px accent dot below the icon; inactive tabs are `text-ink-muted`
- The bar lives in `AppShellComponent`, which wraps every authed route via Angular nested routing (`{ path: '', component: AppShellComponent, canActivate: [authGuard], children: [...] }`). The login route is outside the shell and never shows the bar.
- The bar is only shown on top-level routes (`/dashboard`, `/accounts`, `/transactions`, `/profile`). Sub-pages (account-detail, *-form, settlement-form, categories) hide the bar so forms get full screen.
- Top-level pages must reserve bottom padding (≈`pb-32`) so scrolled content clears the bar.

### Profile
- Hero band (chocolate, rounded-b-3xl) with edition eyebrow + Fraunces greeting "Halo, [Nama]."
- Identity card with rows for Nama and Email
- Sign-out button (full-width, `bg-card`, `text-chip-coral-ink`) → `AuthService.signOut()` → `onAuthStateChange` redirects to `/login`
- v1 only — currency selector, name editing, etc. are out of scope

### Account Detail
- Show `balance` prominently labeled "Aktual"
- Show `Hutang` chip below if this account has debt (same rule as Account Card)
- If credit account: show `available_credit` and utilization %
- "Pending reservations" collapsible section listing unsettled reservation **entries** (`ReservationEntry[]`, see §8) against this account. Each entry renders with its amount + category + parent context: for `kind='parent'` entries the row reads like `<category> · <amount>` / secondary `<parent.account.name> · <date>`; for `kind='item'` entries the row reads `<item.category> · <item.amount>` / secondary `dari <parent.account.name> · <date>` so the user sees that this item lives inside a larger cash event.
- "Settle Debt" CTA button (plain `button` + Tailwind) if `total_reserved > 0`. The CTA opens the Settlement Form pre-filled for this account as the owing party.
- "Mutasi" list mirrors a real bank-statement view: only rows where `transactions.account_id = thisAccount` (this account physically paid or received). Reservation rows where this account is the *owing* party (`reserved_from_account_id = thisAccount`, parent- or item-level) are intentionally excluded from Mutasi — they surface only in the "Pending reservations" dropdown above. Uses `ion-infinite-scroll` (20 per page); rows are plain HTML + Tailwind.
- Rows are grouped by `date` with the same cream-tinted divider band as Transaction List ("Hari ini" / "Kemarin" / `weekday · long-date`). The row's secondary line drops the date (covered by the divider) — only `note` is shown below the title.
- A pill filter row above the Mutasi list toggles which mutations are shown: `Semua` (default), `Tanpa reservasi`, `Reservasi`. The filter is purely client-side over already-fetched pages. Because the list is scoped to `account_id = thisAccount`, the "Reservasi" filter here surfaces lender-side rows — i.e. cases where this account paid the money and another account owes it back. A row counts as "Reservasi" when `transactions.reserved_from_account_id` is set OR any of its items has `reserved_from_account_id` set; "Tanpa reservasi" is the complement.
- The filter row is hidden when the loaded mutation set is empty OR when no row in the loaded set has any reservation.
- Mutasi rows reuse the same `reservasi` / `parsial reservasi` chip rule from Transaction List.
- "Catat transaksi" CTA — full-width accent-orange button rendered directly below the balance broadsheet card. Navigates to `/transactions/new?account=<id>` so the transaction form opens with this account pre-filled. Always visible.
- **Reorder mode**: a small "Atur urutan" pill sits at the right end of the Mutasi section header (shown only when the list is non-empty). Tapping it forces `mutasiFilter = 'Semua'` (so visible order matches underlying order), hides the filter pills, and enters drag-drop reorder mode via `@angular/cdk/drag-drop` — header swaps to **Batal** + **Simpan**, each row reveals a drag handle to the right of the amount, and date groups become independent `cdkDropList`s (drags locked to y-axis, no cross-date moves). Drops update only page-local state; Simpan reassigns `sort_index` within each dirty date group using that group's existing slot values and persists via `TransactionService.setSortIndices`, then reloads. Because the page only loads transactions matching this account, the slot reuse never touches rows on other accounts on the same date.

### Transaction Form
- Full-page route (`/transactions/new`, `/transactions/:id/edit`); the tab bar is hidden so the form gets full screen
- Form body is plain HTML + Tailwind; only `ion-content` and `ion-modal` (delete confirm sheet) come from Ionic
- Fields: amount, type, date, category, account, note (all plain `input`/`select`/`button`); date uses `<input type="date">` (no `ion-datetime`)
- If `type = expense`:
  - Toggle (plain `input[type=checkbox]` styled with Tailwind): "Pay from another account?"
  - If toggled ON: show account selector listing every account ≠ payer (and not of type `credit`)
  - Primary account picker stays as `account_id` (payer); the selected secondary account becomes `reserved_from_account_id`
  - Flavor (credit-card vs inter-account debt) is inferred from `account_id.type` — no separate UI control
- If `type = transfer`: show from-account and to-account pickers
- **Default account via query param** — `?account=<id>` pre-fills both `accountId` (income/expense payer) and `fromAccountId` (transfer source) so opening the form from an Account Detail page lands with that account already selected regardless of the type the user picks. Only applies on `/transactions/new` (no effect in edit mode) and silently ignored if the id does not match a loaded account.
- **Exit navigation** — on a successful create, edit, or delete the form calls `Location.back()` so the user returns to whichever page launched the form (Account Detail, Transaction List, etc.). Same pattern as the Cancel/Back button — no special-case routing to `/transactions`.
- **Rincian (split) editor** — `expense` and `income` only:
  - Default state is single-amount + single-category. Below the Category picker a ghost button `+ Pecah jadi rincian` toggles split mode.
  - In split mode: the single Amount + Category collapse; instead a list of item rows appears, each with `[Rp amount input] [category select] [× remove]` and per-item `[ ] Hutang ke akun: __select__` + `[note input]`. A `+ Tambah rincian` button appends an empty row. The auto-summed `Total` is shown read-only above the items.
  - **Per-item reservation** (split mode): each item has its own "Hutang ke akun" toggle. When ON, an account selector appears listing every non-credit account ≠ parent.account. The parent-level "Pay from another account" toggle is HIDDEN while split mode is active — items own that decision per-row.
  - Validation in split mode: at least 1 item, every item amount > 0, every item category required. For any item with reservation ON, owing account must be selected, ≠ parent.account, and not of type `credit`.
  - `Lepas rincian` button exits split mode (items collapse back into the single amount + first item's category; per-item reservations are discarded — the parent-level toggle takes over again).
  - The Pecah toggle is disabled when `type = transfer`.
  - **Edit mode of an existing split transaction**: items render read-only including per-item reservation (v1 limitation per §7.6). User can still edit date and note.

### Transaction List
- Top-level route (`/transactions`); tab bar visible
- Editorial chocolate hero with eyebrow + Fraunces title; flat list of transaction rows below in `bg-card rounded-2xl shadow-card` style
- Rows are grouped by `date`. Each group is preceded by a cream-tinted full-width divider band (`bg-chip-cream-bg text-chip-cream-ink`) showing the weekday + date in `id-ID` long format (e.g. "Senin · 11 Mei 2026"). Today's group is labeled "Hari ini"; yesterday's is "Kemarin"; older dates use the full format. Dividers are derived client-side from the merged paginated list, so a group may grow as more pages load.
- Pull-to-refresh via `ion-refresher`; pagination via `ion-infinite-scroll` (20 per page)
- Each row: category/label on the left, amount on the right (color-coded by direction). The row's secondary line shows account · note only — no date (the group divider covers that). Split transactions display a `{n} rincian` chip beside the amount.
- **Reorder mode**: the hero has an "Atur urutan" pill. While inactive, the list behaves normally. Tapping it enters reorder mode: the pill is replaced by **Batal** + **Simpan** buttons, the rincian chip is hidden, and each row reveals a drag-handle (`⋮⋮` grip) on the right via `@angular/cdk/drag-drop`. Each date group is its own `cdkDropList`; drags are locked to the y-axis and can't cross date groups. Drops mutate page-local state only — Simpan computes new `sort_index` values per dirty date group (reusing that group's existing slot values, sorted descending, assigned to the new row order) and persists everything in one `setSortIndices` call before reloading. Batal restores the snapshot taken on entry. Simpan is disabled until an actual reorder has happened. Tapping a row no longer navigates to edit while in reorder mode.
- **Reservation chips on the row** (mutually exclusive): `reservasi` (amber) when *all* items reserved OR parent-level reservation set; `parsial reservasi` (amber, distinct text) when *some-but-not-all* items reserved. No chip when nothing is reserved.
- Tapping the rincian chip toggles an inline expand panel showing each item's category + amount + (if reserved) `→ <owing account>` coral hint + note. Tapping anywhere else on the row navigates to `/transactions/:id/edit`.

### Calculator
- Route `/calculator`, lazy-loaded inside `AppShellComponent`. Tab bar hidden (sub-page). Opened from the FAB long-press menu (Kalkulator pill).
- Read-only tally tool: pick a set of transactions; the page shows the directional net.
- **Filters**
  - **Akun** — pill row, multi-select. `Semua` is the default and is mutually exclusive with individual selections (selecting any account clears `Semua`; selecting `Semua` clears the others). Lists every non-deleted account including credit cards. Filter applies to `account_id` only (physical-money perspective). Reservations on the owing-side account are NOT included when filtering by the owing account — only when filtering by the payer.
  - **Tanggal** — preset pill row: `Bulan ini` (default), `Bulan lalu`, `30 hari`, `Custom`. `Custom` reveals two `<input type="date">` for from/to. Inclusive on both ends.
- **List** — transfers excluded entirely (they net to 0 within the user's accounts). Each row is a plain HTML button: checkbox + category/type label + date + account + sign-prefixed amount. Tapping anywhere on the row toggles selection. A `Pilih semua` toggle above the list selects/deselects all currently-visible rows.
- **Selection model** — `Set<number>` of transaction ids. Selection is cleared whenever any filter (account or date) changes — explicit reset, no hidden state. Selection is ephemeral; navigating away clears it.
- **Sticky bottom bar** — fixed at the bottom safe area, only when the filtered list is non-empty. Shows: count `{n} dipilih`, breakdown `Masuk Rp Y · Keluar Rp Z`, and the headline `Net Rp X` colored green when > 0, coral when < 0, ink when = 0. Net = `SUM(income) − SUM(expense)` over selected rows. Includes a `Bersihkan` ghost button when count > 0.
- **Cap** — `getForCalculator` returns up to 500 rows. When the cap is reached, an amber banner above the list reads "Hasil dipotong di 500 — persempit filter."
- **Empty / loading** — same vocabulary as other list pages (cream chip icon for empty, spinner for loading).

### Transaction Import
- Route `/transactions/import`, sub-page (tab bar hidden). Lazy-loaded.
- **Entry points**: (a) header CTA on Transaction List ("Impor dari screenshot"); (b) Impor pill in the FAB long-press menu.
- **Step 1 — Pick account**: plain account-picker listing all non-deleted accounts. Required before file picker is shown.
- **Step 2 — Upload**: plain `<input type="file" accept="image/*" capture="environment">` (lets mobile choose camera or gallery). Client compresses to ≤1600px wide, JPEG quality 80, using browser-native canvas — no extra library.
- **Step 3 — Extracting**: full-screen spinner with cream chip; calls `BankImportService.extract()`. Errors surface as a banner (Gemini quota, parse failure, etc.) with a "Coba lagi" button.
- **Step 4 — Review**: list of draft rows. Each row is a plain HTML card with editable fields: date (`<input type="date">`), amount, type toggle (Masuk/Keluar/Transfer), Catatan (text input prefilled with the LLM-cleaned label — this is the only note surface; it writes verbatim to the saved transaction's `note`), `[ ] Lewati` checkbox. The original screenshot text is shown read-only as "Asli". Income/expense rows show a category select prefilled with `suggestedCategoryId`. Transfer rows show a direction toggle (Keluar ke / Masuk dari, prefilled from `transferDirection`) and an "Akun tujuan/asal" select listing all accounts ≠ the picked import account; commit is blocked until every non-skipped transfer row has its other-side account chosen. A "Pilih semua / Lewati semua" toggle is at the top.
- **Step 5 — Commit**: sticky bottom bar "Simpan {n} transaksi" → calls `commit()` → on success, navigates to `/transactions` and shows a transient cream toast `{n} transaksi diimpor`. Income/expense rows go through `TransactionService.create`; transfer rows go through `TransactionService.createTransfer` (which writes both paired rows and links them via `transfer_pair_id`). Each draft is assigned an explicit `sort_index = anchor - i` (anchor = `Date.now()` at commit start) so the screenshot's top→bottom order maps to the list's top→bottom within the date group; transfers pass the same value through `createTransfer.sortIndex` so both paired rows share it.
- **Dedup**: not enforced in v1. Re-uploading the same screenshot inserts duplicate rows.
- **Splits / per-item reservation**: not supported in import — every imported row is a single-amount transaction. User can edit afterwards via the normal Transaction Form to split.

### Settlement Form
- Rendered inside `ion-modal`
- Step 1: pick the lender (payer) account — any account that has unsettled reservations naming it as `account_id`
- Step 2: pick the owing account from those with unsettled reservations to that lender; show the unsettled transaction list + total
- Step 3: amount input (defaults to full total, can be reduced)
- Show live preview: which transactions will be fully vs partially settled
- Confirm → runs `SettlementService.settle()`

---

## 10. Environment Config

Supabase credentials are injected at build time. They are **never** committed.

- `.env.example` — template, checked in.
- `.env` — local secrets, **gitignored**. Copy from `.env.example`.
- `scripts/generate-env.js` — reads `process.env` (loading `.env` via dotenv when present), validates `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set, and writes both `src/environments/environment.ts` and `environment.prod.ts`.
- `src/environments/environment.ts` and `environment.prod.ts` — **gitignored**, regenerated on every build/serve. Do not hand-edit.

Workflow:
- **Local dev** — `npm install` (one time), then `npm start`. The `prestart` hook runs the generator from `.env`.
- **CI / Vercel** — set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as project env vars. `prebuild` runs the generator before `ng build`.
- **Manual regen** — `npm run generate-env`.
- The generator exits non-zero if either var is missing — failing the build loudly is intentional.

`SupabaseService` imports `environment` from `src/environments/environment` and exposes a singleton `SupabaseClient` via `getClient()`. No component or other service may call `createClient` directly.

### LLM Vision (bank-screenshot import)

The `extract-transactions` edge function is the only consumer of the LLM API. All keys live in Supabase secrets, never in the Angular bundle.

Required Supabase secrets:
- `GEMINI_API_KEY` — from Google AI Studio. Free tier works out-of-box (~1,500 image requests/day, 15/min). Paid tier = enable billing on the same Google Cloud project; no code or key change needed.
- `GEMINI_MODEL` — defaults to `gemini-2.5-flash`. Swap by command: `supabase secrets set GEMINI_MODEL=gemini-2.5-pro` (or any other Gemini vision-capable model). The edge function reads this env var on every request, so changes take effect without redeploy.

The edge function's contract:
- Accepts `{ image: base64, accountId }` via authenticated POST (JWT in `Authorization` header).
- Server fetches the user's category list (RLS scopes it automatically) so prompts include only valid category ids.
- Calls Gemini with a structured-output schema matching `ImportDraft[]` minus `skip` (defaults to false on the client).
- Prompt includes today's date (so "Hari ini"/"Kemarin" resolves) and the user's category list (so `suggestedCategoryId` lands on an existing id, not a hallucinated one).
- Returns `ImportDraft[]` or a structured error (`quota_exceeded` / `parse_failed` / `unsupported_image`).

**Privacy note**: Gemini's free tier may use submitted images to improve Google models. Paid tier (any billing-enabled project) does not. For real bank screenshots, switch to paid before going beyond personal dev use.

---

## 11. Out of Scope for v1

Do not generate code for these unless explicitly requested:

- Budgets / spending limits per category
- Recurring / scheduled transactions
- Multi-currency exchange rate conversion
- Receipt image uploads (Supabase Storage)
- Push notifications / payment due reminders
- Tags UI (schema exists, feature is v2)
- Export to CSV / PDF
- Charts / spending reports

---

## 12. Design System (Warm Brown / Cream)

Component recipes, the canonical Tailwind config, and the full color-token block live in **`docs/design-system.md`**. Live config: `tailwind.config.js`. Live tokens: `src/theme/variables.scss`.

### Visual Identity
- Mood: warm, editorial, soft — chocolate hero, cream body, white cards, orange/amber accents.
- Inspiration: cookbook/journal aesthetic — generous whitespace, rounded everything.
- Mode: light only for v1 (no dark mode toggle).

### Typography
- **Display** (serif, italic for emphasis): `'Fraunces'`, fallback `Georgia, serif` → page hero titles, large account-balance numbers, account names on cards.
- **Body** (sans-serif): `'Plus Jakarta Sans'`, fallback `system-ui, sans-serif` → all UI text, buttons, inputs, labels.
- **Label** (tracked-wide uppercase): body sans, `text-xs tracking-[0.18em] uppercase font-semibold` → small section eyebrows ("BEKAL KANTOR", "5 HARI KERJA").
- Both fonts loaded from Google Fonts via `<link>` in `index.html`.

### Radius & Shadow
- `rounded-full` — pills, chips, segment tabs, FAB.
- `rounded-2xl` (16px) — cards, modal sheets, banner.
- `rounded-xl` (12px) — inputs, buttons.
- `rounded-b-3xl` — hero section bottom edge (soft transition into cream body).
- Card shadow: `shadow-card` → `0 2px 12px -4px rgba(61,36,24,0.08)` (registered as Tailwind shadow).
- No hard borders on cards — separation comes from shadow + bg contrast.

### Money Display Pattern
Accounts lead with `Aktual` and surface debt as a chip when present:
```html
<p class="text-xs tracking-[0.18em] uppercase text-ink-muted">Aktual</p>
<p class="font-display text-3xl text-ink">Rp 1.500.000</p>
<!-- Only when debt > 0 -->
<span class="inline-flex items-center gap-1.5 rounded-full bg-chip-coral-bg text-chip-coral-ink
             text-xs font-semibold px-3 py-1.5 mt-2">
  Hutang Rp 250.000
</span>
```
Negative / over-budget uses `text-chip-coral-ink`; positive growth uses `text-chip-green-ink`. Five canonical chip variants: `green` (success), `coral` (warn/spend), `sky` (info), `amber` (highlight), `cream` (neutral).
