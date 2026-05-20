# UI Screens & Key Behavior

> Per-page specs referenced by `CLAUDE.md §9`. All "cards", "buttons", "headers", "toolbars", "lists", "toggles", "pickers", "CTAs" below are plain HTML + Tailwind. Only `ion-content`, `ion-router-outlet`, `ion-refresher`, `ion-modal`, `ion-infinite-scroll`, `ion-fab` come from Ionic.

## Dashboard
- Sum of `balance` (Aktual saldo) across all active accounts at top — `Tersedia` is intentionally not shown in the UI
- Sub-line "Hutang aktif" chip — sum of `total_reserved` (non-credit accounts owing other accounts) + `ABS(balance)` (credit cards owing the bank); shown only if > 0
- Account cards grid (plain `div` + Tailwind): name, type icon, `balance` large (Aktual), debt chip below if account has debt (see Account Card)
- Credit card cards: add utilization bar (`ABS(balance) / credit_limit`)
- The page does not own a FAB — quick-add lives in the global Tab Bar (see below)
- **Viewer scope toggle** — a small pill row (`Saya` / `Lain` / `Semua`) sits in the hero, bound to `ViewerScopeService.scope`. The hero totals and the account grid both honor it. See `docs/groups.md`.

## Account Card
- Big number: `balance` labeled "Aktual"
- Below: `Hutang Rp X` coral-tinted chip — **non-credit accounts only**, when `total_reserved > 0`. Chip amount = `total_reserved` (what this account owes other accounts). Hide when zero. Credit cards never show this chip: the negative `balance` already communicates the debt owed to the bank.
- **Shortfall popover** — when `balance < total_reserved` (saldo can't cover outstanding debt), the Hutang chip becomes a button and gets a small pulsing coral dot appended inside it. Tapping the chip opens a cream "margin-note" popover anchored below it (Fraunces italic "Kurang" eyebrow + display-weight amount `total_reserved − balance` + one-line explanation). Tap outside or re-tap the chip to dismiss. Not applicable to credit cards. When shortfall is zero the chip stays as a non-interactive `<span>`.
- **Foreign-owner chip** — when `account.user_id !== auth.uid()` (account belongs to a group host, not the current user), render a small cream chip (`bg-chip-cream-bg text-chip-cream-ink`) with a user icon + the host's display name. Placed inline beside the type label. Hidden when the account is your own. See `docs/groups.md`.
- `available_balance` is computed in the view but not displayed on the card; it remains available to services/logic that need to answer "can this account afford X?"

## Tab Bar (mobile shell)
- Plain HTML floating pill bar fixed at the bottom safe area (`pb-[max(1rem,env(safe-area-inset-bottom))]`); `bg-card`, `rounded-full`, `shadow`, `max-w-md` centered
- Five slots, left → right: **Dashboard · Accounts · ⊕ Center FAB · Transactions · Profile**
- The center FAB is accent-orange and protrudes ~24px above the bar; tap → `/transactions/new`, long-press (450ms) → expands a vertical fab list with four pills, ordered top→bottom: Kategori, Kalkulator, Impor, Transaksi (closest to the FAB = most frequent; Impor sits adjacent to Transaksi because it's a transaction-creation shortcut). The plus glyph rotates 45° (→ ×) when the menu is open.
- Active tab uses `text-ink` + a 4px accent dot below the icon; inactive tabs are `text-ink-muted`
- The bar lives in `AppShellComponent`, which wraps every authed route via Angular nested routing (`{ path: '', component: AppShellComponent, canActivate: [authGuard], children: [...] }`). The login route is outside the shell and never shows the bar.
- The bar is only shown on top-level routes (`/dashboard`, `/accounts`, `/transactions`, `/profile`). Sub-pages (account-detail, *-form, settlement-form, categories) hide the bar so forms get full screen.
- Top-level pages must reserve bottom padding (≈`pb-32`) so scrolled content clears the bar.

## Profile
- Hero band (chocolate, rounded-b-3xl) with edition eyebrow + Fraunces greeting "Halo, [Nama]."
- Identity card with rows for Nama and Email
- **Anggota grup** card — lists members of YOUR group (each row shows name + email + Keluarkan button that calls `GroupService.kickMember`). Shown only when `GroupService.myMembers().length > 0`.
- **Grup yang Anda ikuti** card — lists hosts whose group you're a member of (each row shows host's name + email + Keluar button that calls `GroupService.leaveGroup`). Shown only when `GroupService.myMemberships().length > 0`.
- **Undangan tertunda** card — lists outbound invitations with status='pending' (email + created date + Batalkan button calling `GroupService.revoke`). Shown only when `GroupService.pendingOutbound().length > 0`.
- **Undang anggota** CTA — opens an `ion-modal` with an email input + `Kirim undangan` button. Calls `GroupService.invite(email)`. Errors surface as a coral chip in the modal (self-invite, already-invited, invalid email).
- Sign-out button (full-width, `bg-card`, `text-chip-coral-ink`) → `AuthService.signOut()` → `onAuthStateChange` redirects to `/login`
- v1 only — currency selector, name editing, etc. are out of scope

## Account Detail
- Show `balance` prominently labeled "Aktual"
- **Foreign-owner chip** — when `account.user_id !== auth.uid()`, render the same cream chip (user icon + host name) under the account name in the hero. Hidden for own accounts. See `docs/groups.md`.
- Show `Hutang` chip below — **non-credit accounts only**, when `total_reserved > 0`. Hidden for credit cards (the negative balance already shows it).
- Mirror the Account Card's **shortfall popover** behavior: when `balance < total_reserved`, the Hutang chip becomes a button with a small pulsing coral dot, and tapping it opens the cream "margin-note" popover with the `Kurang Rp X` detail. Tap outside or re-tap to dismiss.
- If credit account: show `available_credit` and utilization %
- "Pending reservations" collapsible section listing unsettled reservation **entries** (`ReservationEntry[]`, see `docs/services.md`) against this account. Each entry renders with its amount + category + parent context: for `kind='parent'` entries the row reads like `<category> · <amount>` / secondary `<parent.account.name> · <date>`; for `kind='item'` entries the row reads `<item.category> · <item.amount>` / secondary `dari <parent.account.name> · <date>` so the user sees that this item lives inside a larger cash event.
- "Settle Debt" CTA button (plain `button` + Tailwind) if `total_reserved > 0`. The CTA opens the Settlement Form pre-filled for this account as the owing party.
- "Mutasi" list mirrors a real bank-statement view: only rows where `transactions.account_id = thisAccount` (this account physically paid or received). Reservation rows where this account is the *owing* party (`reserved_from_account_id = thisAccount`, parent- or item-level) are intentionally excluded from Mutasi — they surface only in the "Pending reservations" dropdown above. Uses `ion-infinite-scroll` (20 per page); rows are plain HTML + Tailwind.
- Rows are grouped by `date` with the same cream-tinted divider band as Transaction List ("Hari ini" / "Kemarin" / `weekday · long-date`). The row's secondary line drops the date (covered by the divider) — only `note` is shown below the title.
- A pill filter row above the Mutasi list toggles which mutations are shown: `Semua` (default), `Tanpa reservasi`, `Reservasi`. The filter is purely client-side over already-fetched pages. Because the list is scoped to `account_id = thisAccount`, the "Reservasi" filter here surfaces lender-side rows — i.e. cases where this account paid the money and another account owes it back. A row counts as "Reservasi" when `transactions.reserved_from_account_id` is set OR any of its items has `reserved_from_account_id` set; "Tanpa reservasi" is the complement.
- The filter row is hidden when the loaded mutation set is empty OR when no row in the loaded set has any reservation.
- Mutasi rows reuse the same `reservasi` / `parsial reservasi` chip rule from Transaction List.
- "Catat transaksi" CTA — full-width accent-orange button rendered directly below the balance broadsheet card. Navigates to `/transactions/new?account=<id>` so the transaction form opens with this account pre-filled. Always visible.
- **Reorder mode**: a small "Atur urutan" pill sits at the right end of the Mutasi section header (shown only when the list is non-empty). Tapping it forces `mutasiFilter = 'Semua'` (so visible order matches underlying order), hides the filter pills, and enters drag-drop reorder mode via `@angular/cdk/drag-drop` — header swaps to **Batal** + **Simpan**, each row reveals a drag handle to the right of the amount, and date groups become independent `cdkDropList`s (drags locked to y-axis, no cross-date moves). Drops update only page-local state; Simpan reassigns `sort_index` within each dirty date group using that group's existing slot values and persists via `TransactionService.setSortIndices`, then reloads. Because the page only loads transactions matching this account, the slot reuse never touches rows on other accounts on the same date.

## Transaction Form
- Full-page route (`/transactions/new`, `/transactions/:id/edit`); the tab bar is hidden so the form gets full screen
- Form body is plain HTML + Tailwind; `ion-content`, `ion-modal` (delete confirm sheet), plus `ion-modal` indirectly via `SearchableSelectComponent` (used for every category / account picker)
- Fields: amount (plain `input`), type (plain pill buttons), date (`<input type="date">`, no `ion-datetime`), category + account (`<app-searchable-select>` — bottom-sheet modal with search), note (plain `input`)
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
  - **Edit mode of an existing split transaction**: items render read-only including per-item reservation (v1 limitation per `CLAUDE.md §7.6`). User can still edit date and note.

## Transaction List
- Top-level route (`/transactions`); tab bar visible
- Editorial chocolate hero with eyebrow + Fraunces title; flat list of transaction rows below in `bg-card rounded-2xl shadow-card` style
- **Viewer scope toggle** in the hero (same `Saya` / `Lain` / `Semua` pill row as Dashboard). Service-layer filter via `ViewerScopeService` — see `docs/groups.md`. Foreign-author rows render a cream chip (user icon + `{creatorName}`) on the right side beneath the amount, when `tx.created_by !== auth.uid()`.
- Rows are grouped by `date`. Each group is preceded by a cream-tinted full-width divider band (`bg-chip-cream-bg text-chip-cream-ink`) showing the weekday + date in `id-ID` long format (e.g. "Senin · 11 Mei 2026"). Today's group is labeled "Hari ini"; yesterday's is "Kemarin"; older dates use the full format. Dividers are derived client-side from the merged paginated list, so a group may grow as more pages load.
- Pull-to-refresh via `ion-refresher`; pagination via `ion-infinite-scroll` (20 per page)
- Each row: category/label on the left, amount on the right (color-coded by direction). The row's secondary line shows account · note only — no date (the group divider covers that). Split transactions display a `{n} rincian` chip beside the amount.
- **Reorder mode**: the hero has an "Atur urutan" pill. While inactive, the list behaves normally. Tapping it enters reorder mode: the pill is replaced by **Batal** + **Simpan** buttons, the rincian chip is hidden, and each row reveals a drag-handle (`⋮⋮` grip) on the right via `@angular/cdk/drag-drop`. Each date group is its own `cdkDropList`; drags are locked to the y-axis and can't cross date groups. Drops mutate page-local state only — Simpan computes new `sort_index` values per dirty date group (reusing that group's existing slot values, sorted descending, assigned to the new row order) and persists everything in one `setSortIndices` call before reloading. Batal restores the snapshot taken on entry. Simpan is disabled until an actual reorder has happened. Tapping a row no longer navigates to edit while in reorder mode.
- **Reservation chips on the row** (mutually exclusive): `reservasi` (amber) when *all* items reserved OR parent-level reservation set; `parsial reservasi` (amber, distinct text) when *some-but-not-all* items reserved. No chip when nothing is reserved.
- Tapping the rincian chip toggles an inline expand panel showing each item's category + amount + (if reserved) `→ <owing account>` coral hint + note. Tapping anywhere else on the row navigates to `/transactions/:id/edit`.
- **Calendar strip** between the hero and the rows. Plain HTML + Tailwind — no Ionic calendar component.
  - Header row: `‹` prev-month button · month+year label (tappable) · `›` next-month button. Arrows step one calendar month; label tap opens an inline picker panel below the strip with a 12-month chip grid (Jan–Des) + a year stepper (`‹ year ›`). Picking a month closes the panel.
  - Weekday header row: `Sen Sel Rab Kam Jum Sab Min` (id-ID, Monday-first).
  - 6-week fixed grid of date cells. Leading/trailing cells from adjacent months are dimmed and not selectable. Today gets an accent-warm ring; the selected date gets a filled accent pill.
  - **Dot indicator**: each in-month date with ≥1 visible transaction renders a small dot under the day number. Dot color is a neutral accent — does not encode type. Loaded once per month-view via `TransactionService.getTransactionDatesForMonth`.
  - **Selection**: default is today (today's month, today selected) so the list pre-filters to today on first paint. Tapping another date re-fetches the list via `TransactionService.getByDate`. Tapping the currently-selected date is a no-op. A `Semua tanggal` ghost button below the grid clears selection and restores the original paged feed.
  - Changing viewer scope reloads both the dot set and the date-filtered list.
  - **Reorder mode**: calendar is hidden while reorder mode is active (drag-and-drop semantics already disable cross-date moves).
  - Pagination: when a specific date is selected, `ion-infinite-scroll` is disabled (a single day fits in one fetch). When `Semua tanggal` is active, paging works as before.

## Calculator
- Route `/calculator`, lazy-loaded inside `AppShellComponent`. Tab bar hidden (sub-page). Opened from the FAB long-press menu (Kalkulator pill).
- Read-only tally tool: pick a set of transactions; the page shows the directional net.
- **Filters**
  - **Akun** — pill row, multi-select. `Semua` is the default and is mutually exclusive with individual selections (selecting any account clears `Semua`; selecting `Semua` clears the others). Lists every non-deleted account including credit cards (own AND foreign group-visible accounts; foreign ones show the `· {ownerName}` annotation). Filter applies to `account_id` only (physical-money perspective). Reservations on the owing-side account are NOT included when filtering by the owing account — only when filtering by the payer.
  - **Tanggal** — preset pill row: `Bulan ini` (default), `Bulan lalu`, `30 hari`, `Custom`. `Custom` reveals two `<input type="date">` for from/to. Inclusive on both ends.
  - **Penulis** (viewer scope) — same `Saya` / `Lain` / `Semua` pill row as Dashboard, bound to `ViewerScopeService.scope`. Applies via `getForCalculator` server-side filter.
- **List** — includes income, expense, AND transfers. Each transfer row shows a sky `masuk`/`keluar` chip indicating its side (incoming when `transfer_pair_id < id`, outgoing otherwise). Each row is a plain HTML button: checkbox + category/type label + date + account + sign-prefixed amount. Tapping anywhere on the row toggles selection. A `Pilih semua` toggle above the list selects/deselects all currently-visible rows. When `Semua` accounts is active, both sides of an internal transfer appear in the list; selecting both nets to zero in the bottom bar.
- **Selection model** — `Set<number>` of transaction ids. Selection is cleared whenever any filter (account or date) changes — explicit reset, no hidden state. Selection is ephemeral; navigating away clears it.
- **Sticky bottom bar** — fixed at the bottom safe area, only when the filtered list is non-empty. Shows: count `{n} dipilih`, breakdown `Masuk Rp Y · Keluar Rp Z`, and the headline `Net Rp X` colored green when > 0, coral when < 0, ink when = 0. `Masuk` sums income amounts + incoming-transfer amounts; `Keluar` sums expense amounts + outgoing-transfer amounts. Net = Masuk − Keluar over selected rows. Includes a `Bersihkan` ghost button when count > 0.
- **Cap** — `getForCalculator` returns up to 500 rows. When the cap is reached, an amber banner above the list reads "Hasil dipotong di 500 — persempit filter."
- **Empty / loading** — same vocabulary as other list pages (cream chip icon for empty, spinner for loading).

## Transaction Import
- Route `/transactions/import`, sub-page (tab bar hidden). Lazy-loaded.
- **Entry points**: (a) header CTA on Transaction List ("Impor dari screenshot"); (b) Impor pill in the FAB long-press menu.
- **Step 1 — Pick account**: plain account-picker listing all non-deleted accounts. Required before file picker is shown.
- **Step 2 — Upload**: plain `<input type="file" accept="image/*" capture="environment">` (lets mobile choose camera or gallery). Client compresses to ≤1600px wide, JPEG quality 80, using browser-native canvas — no extra library.
- **Step 3 — Extracting**: full-screen spinner with cream chip; calls `BankImportService.extract()`. Errors surface as a banner (Gemini quota, parse failure, etc.) with a "Coba lagi" button.
- **Step 4 — Review**: list of draft rows. Each row is a plain HTML card with editable fields: date (`<input type="date">`), amount, type toggle (Masuk/Keluar/Transfer), Catatan (text input prefilled with the LLM-cleaned label — this is the only note surface; it writes verbatim to the saved transaction's `note`), `[ ] Lewati` checkbox. The original screenshot text is shown read-only as "Asli". Income/expense rows show an `<app-searchable-select>` (compact, with clear-option) prefilled with `suggestedCategoryId`. Transfer rows show a direction toggle (Keluar ke / Masuk dari, prefilled from `transferDirection`) and an `<app-searchable-select>` for "Akun tujuan/asal" listing all accounts ≠ the picked import account; commit is blocked until every non-skipped transfer row has its other-side account chosen. A "Pilih semua / Lewati semua" toggle is at the top.
- **Step 5 — Commit**: sticky bottom bar "Simpan {n} transaksi" → calls `commit()` → on success, navigates to `/transactions` and shows a transient cream toast `{n} transaksi diimpor`. Income/expense rows go through `TransactionService.create`; transfer rows go through `TransactionService.createTransfer` (which writes both paired rows and links them via `transfer_pair_id`). Each draft is assigned an explicit `sort_index = anchor - i` (anchor = `Date.now()` at commit start) so the screenshot's top→bottom order maps to the list's top→bottom within the date group; transfers pass the same value through `createTransfer.sortIndex` so both paired rows share it.
- **Dedup**: not enforced in v1. Re-uploading the same screenshot inserts duplicate rows.
- **Splits / per-item reservation**: not supported in import — every imported row is a single-amount transaction. User can edit afterwards via the normal Transaction Form to split.

## Settlement Form
- Rendered inside `ion-modal`
- Step 1: pick the lender (payer) account — any account that has unsettled reservations naming it as `account_id`
- Step 2: pick the owing account from those with unsettled reservations to that lender; show the unsettled transaction list + total
- Step 3: amount input (defaults to full total, can be reduced)
- Show live preview: which transactions will be fully vs partially settled
- **Shortfall info** under the amount input (between Step 3 input and the date field). Single chip, evaluated in priority order:
  1. **Balance shortage (coral)** — when `paymentAmount > owingAccount.balance`, reads `Saldo {owingName} hanya Rp X. Bayar segini akan membuat saldo minus Rp Y.` This wins because going negative is a stronger concern than partial settlement.
  2. **Debt shortfall (amber)** — when balance is sufficient *and* `paymentAmount < totalUnsettled`, reads `Kurang Rp X untuk lunasi semua hutang akun ini.`
  3. **All clear (green)** — when balance is sufficient *and* `paymentAmount ≥ totalUnsettled`, reads `Cukup untuk lunas semua hutang.`

  The preview card's `Hutang setelah ini` line also colors amber when > 0 to reinforce remaining debt visually. Neither chip blocks submission — the user can still settle into a negative balance if they intend to top up later.
- Confirm → runs `SettlementService.settle()`
