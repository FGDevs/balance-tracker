# CLAUDE.md — Balance Tracker
> Read this entire file before writing any code, migration, or file.
> This is the single source of truth for project rules and core business logic.

> Referenced files (load on demand):
> - **DB schema (DDL, RLS, view, triggers):** `db/schema.sql` — applied migrations in `db/migrations/`
> - **TypeScript models:** `src/app/core/models/index.ts` (canonical — do not duplicate here)
> - **Service API contracts:** `docs/services.md` — full signatures for every service
> - **UI screens & per-page behavior:** `docs/ui-screens.md` — Dashboard, Account Card, Tab Bar, Profile, Account Detail, Transaction Form/List/Import, Calculator, Settlement Form
> - **Groups & sharing subsystem:** `docs/groups.md` — schema, RLS, invite/auto-bind flow, viewer-scope, cross-group correctness
> - **Setup, env vars, LLM keys:** `docs/setup.md`
> - **Design recipes + tokens + Tailwind config:** `docs/design-system.md`; live config at `tailwind.config.js`, vars at `src/theme/variables.scss`

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
- **Group-shared tables** (`accounts`, `categories`, `transactions`, `transaction_items`, `debt_settlements`) carry both `user_id` (= group owner / host whose group the row belongs to) and `created_by` (= the user who physically created the row). Services set `created_by = auth.uid()` on every INSERT. Existing single-user rows have `created_by = user_id` after backfill. See §13 / `docs/groups.md`.
- Services NEVER hand-roll `eq('user_id', auth.uid())` filters on shared tables — RLS handles cross-user visibility based on group membership. Services may still filter by `created_by` to honor the viewer-scope toggle.

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
│   │   │   ├── bank-import.service.ts      # screenshot → extract-transactions edge fn
│   │   │   ├── group.service.ts            # invitations, memberships, kick/leave
│   │   │   └── viewer-scope.service.ts     # mine/others/all filter signal
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
│   │   ├── statistics/                     # subpage from Dashboard, account + period filters
│   │   └── profile/                        # name, email, sign out, group management
│   ├── shared/components/{amount-display,account-card,transaction-item,currency-input,searchable-select}/
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
- `account_balances` view — **always query this for balances**, never `accounts` directly. It surfaces `total_reserved` and `available_balance` per the hybrid invariant (§7.3). The view inherits group-scoped RLS.
- `enforce_hybrid_reservation` trigger — safety net for §7.3; service layer is primary enforcer.
- `handle_new_user` trigger — auto-creates a `profiles` row when an `auth.users` row appears.
- `group_memberships`, `group_invitations` tables drive sharing — see `docs/groups.md`.
- All shared tables (`accounts`, `categories`, `transactions`, `transaction_items`, `debt_settlements`) carry `created_by uuid REFERENCES auth.users(id)` in addition to `user_id`. RLS allows access when `user_id = auth.uid()` OR `user_id IN (SELECT host_user_id FROM group_memberships WHERE member_user_id = auth.uid())`.

---

## 6. TypeScript Models

Canonical definitions live in **`src/app/core/models/index.ts`** — read that file directly. Do not duplicate type definitions in this document.

Key types: `Profile`, `Account`, `AccountBalance` (extends Account with view columns), `Category`, `Transaction`, `TransactionItem`, `ReservationEntry` (parent-or-item union for settlement UI), `DebtSettlement`, `Tag`, `GroupMembership`, `GroupInvitation`, `ViewerScope`. All money fields are `number`; all dates on transactions are `'YYYY-MM-DD'` strings.

Group-shared types (`Account`, `Category`, `Transaction`, `TransactionItem`, `DebtSettlement`) all carry `created_by: string` (creator's `auth.users.id`) and an optional `created_by_user?: Profile` for hydrated reads. `user_id` on those types continues to mean "group owner / host" (see `docs/groups.md`).

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

See **`docs/services.md`** for full signatures of every service: `SupabaseService`, `AuthService`, `AccountService`, `TransactionService`, `SettlementService`, `CategoryService`, `BankImportService`, `GroupService`, `ViewerScopeService`.

The canonical implementation lives in `src/app/core/services/*.ts` — read those for the latest. The doc is the intent-commented overview.

---

## 9. UI Screens & Key Behavior

See **`docs/ui-screens.md`** for per-page specs (Dashboard, Account Card, Tab Bar, Profile, Account Detail, Transaction Form, Transaction List, Calculator, Transaction Import, Settlement Form).

Universal rule (from §3): only `ion-content`, `ion-router-outlet`, `ion-refresher`, `ion-modal`, `ion-infinite-scroll`, `ion-fab` come from Ionic — everything else is plain HTML + Tailwind.

---

## 10. Environment Config

See **`docs/setup.md`** — full setup, env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`), the `scripts/generate-env.js` workflow, Supabase secrets for LLM vision (`GEMINI_API_KEY`, `GEMINI_MODEL`), and a note on group invitations (no SMTP — auto-bind on login per `docs/groups.md`).

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
- **Groups & Sharing — deferred from v1 scope** (covered in `docs/groups.md`, but with the following parts deferred): role-based permissions (everyone is a full editor), named multi-membership groups (one implicit group per host), per-account or per-category opt-in sharing, audit log of who created/edited what, **automated email/SMTP delivery of invitations** (host shares the invitee's email out of band; auto-bind on login does the rest), invite codes / shareable links.

---

## 12. Design System

Tokens, component recipes, Tailwind config, typography, radii, and the money-display pattern all live in **`docs/design-system.md`**. Live config: `tailwind.config.js`. Live tokens: `src/theme/variables.scss`. Mode: light only for v1.

---

## 13. Groups & Sharing

See **`docs/groups.md`** for the full subsystem: schema additions (`group_memberships`, `group_invitations`, `created_by` column on shared tables), RLS shape, invite/auto-bind flow, viewer-scope filter, cross-group correctness rules, edge cases, implementation phases.

Quick reference for rules in §3 / §7 that depend on it:
- Group-shared tables carry `user_id` (= group owner / host) AND `created_by` (= row creator). Services set `created_by = auth.uid()` on INSERT.
- Services NEVER hand-roll `eq('user_id', auth.uid())` on shared tables — RLS does cross-user visibility. Services MAY filter by `created_by` to honor the viewer-scope toggle.
- `ViewerScopeService.scope: Signal<'mine' | 'others' | 'all'>` — applied as `.eq/.neq('created_by', uid)` in list-fetching services (Account list, Transaction list / recent / by-account / for-calculator).
- For `transactions`: `transaction.user_id` always equals `account.user_id` (hard invariant enforced at INSERT). Transfer pairs may have different `user_id` per row but share `created_by`.

---

## 14. Statistics

Route `/statistics`, lazy-loaded inside `AppShellComponent`. Sub-page — tab bar hidden. Entered via a "Statistik" link on Dashboard (placed in the Accounts section header row, beside "Lihat semua").

### Filters
- **Akun** — single-select via `<app-searchable-select>`. Default `Semua akun`; other options are every non-deleted account the viewer can see (own + foreign-visible, foreign annotated with `· {ownerName}`). Filter applies to `transactions.account_id` (physical-payer perspective, same as Calculator).
- **Periode** — preset pill row: `Bulan ini` (default), `Bulan lalu`, `Custom`. `Custom` reveals two `<input type="date">` (from/to, inclusive both ends). The "Reservasi" section ignores this filter — see below.
- **Penulis** (viewer scope) — same `Saya` / `Lain` / `Semua` pill row as Dashboard, bound to `ViewerScopeService.scope`. Applies to the category breakdown via `created_by` filter. The reservation summary also honors it (entries created by others are filtered out when scope = `Saya`).

### Section 1 — Rincian kategori (expense only)
- Lists categories ranked descending by total expense within the period (and within the selected account if not `Semua`).
- Each row: category color dot + name, count of contributing rows, total, share %.
- **Items handling**: when a transaction has items (`SUM(items.amount) = parent.amount` invariant), each item contributes to its own `category_id`. When no items, the parent's `category_id` is used. Rows with `category_id IS NULL` and no items render under a synthetic "Tanpa kategori" bucket.
- **Settled vs unsettled**: both included. A settled debt was still a real expense at the time it happened.
- **Transfers**: excluded entirely (no category).
- Empty state: cream chip card "Belum ada pengeluaran di periode ini."

### Section 2 — Reservasi & hutang (current state, ignores period filter)
- Headline number: total currently reserved across the viewer-visible scope (matches the dashboard `Hutang aktif` number when account = `Semua`).
- When account = `Semua`: list of owing accounts with `total_reserved > 0`, each row showing `{account name} · Rp {total}` + secondary line `{n} reservasi · tertua {date}`.
- When account = specific: single summary block — `{total_reserved}` for that account (perspective = what this account owes others), count of unsettled entries, oldest unsettled date. Mirrors the Account Detail "Hutang" chip data but expanded.
- Row "tertua" date uses `id-ID` long format. Tapping a row navigates to that owing account's detail page.
- Empty state: cream chip card "Tidak ada hutang aktif."

### Implementation notes
- New service methods on `TransactionService`:
  - `getCategoryBreakdown({ from, to, accountId }): Promise<CategoryBreakdownEntry[]>` — non-transfer rows in `[from, to]`, expands items where present, groups by `category_id`, honors viewer scope via `created_by`.
  - `getReservationSummary({ accountId }): Promise<ReservationSummaryEntry[]>` — UNION of parent-level + item-level unsettled reservations, grouped by `reserved_from_account_id`, returns `{ account, totalReserved, count, oldestDate }[]`. Honors viewer scope.
- New types in `src/app/core/models/index.ts`: `CategoryBreakdownEntry`, `ReservationSummaryEntry`.
- Page uses only `ion-content` + `ion-refresher` from Ionic; everything else plain HTML + Tailwind.
- Money formatted via `currencyFormat` pipe + `AuthService.currency()`.

### Out of scope for this iteration
- Charts (bar/pie/line) — text rows + share % only.
- Balance trend over time — deferred.
- Income breakdown — only expense supported.
- Settled-in-period view — only current-state debt is shown.
- Export.
