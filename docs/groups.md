# Groups & Sharing

> Full subsystem referenced by `CLAUDE.md §13`. Cross-cutting rules in `CLAUDE.md §3` (`created_by` on every INSERT, no hand-rolled `user_id` filters) summarize what every service must follow; this doc covers the schema, RLS, invite flow, and edge cases.

## Concept

Every authenticated user implicitly owns one **group** (their household). They can invite other users into it by email. Invited members get **full collaboration** rights on the host's data (create / edit / delete on accounts, transactions, transaction items, settlements, categories) — exactly the same surface as the host. A user may simultaneously own their own group AND be a member of one or more other hosts' groups; the UI merges everything they can see and offers a viewer-scope toggle (`Saya` / `Lain` / `Semua`) to filter by the row's author (`created_by`).

There is no role hierarchy in v1 — every member is a full editor. There are no named groups in v1 — each user has one implicit group keyed by their `auth.users.id`. There is no per-account opt-in — everything the host owns is visible to every member.

## Schema

Full DDL lives in `db/schema.sql`. Shape:

```sql
CREATE TABLE group_memberships (
  host_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_user_id, member_user_id),
  CHECK (host_user_id <> member_user_id)
);

CREATE TABLE group_invitations (
  id             bigserial PRIMARY KEY,
  host_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invitee_email  text NOT NULL,
  token          text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','revoked','expired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  accepted_at    timestamptz
);
CREATE INDEX ON group_invitations (host_user_id, status);
CREATE INDEX ON group_invitations (invitee_email);
```

On `accounts`, `categories`, `transactions`, `transaction_items`, `debt_settlements`:

```sql
ALTER TABLE <table> ADD COLUMN created_by uuid REFERENCES auth.users(id);
UPDATE <table> SET created_by = user_id WHERE created_by IS NULL;  -- backfill
ALTER TABLE <table> ALTER COLUMN created_by SET NOT NULL;
```

Note: `transaction_items` doesn't currently have `user_id`. Add `created_by` only (it inherits the group from its parent transaction's `user_id`).

## Column semantics

`user_id` (existing) = **group owner / host**. Identifies which group the row belongs to. For accounts created on a host's behalf by a member, `user_id` is still the host. For a member acting in their own group, `user_id` is the member (since they ARE the host of their own group).

`created_by` (new) = **author**. The user who physically created the row. Distinct from `user_id` whenever a member creates a row in someone else's group.

For transactions: `transaction.user_id` always equals `account.user_id` (the row inherits its account's group). This is a hard invariant — services enforce it at INSERT time.

For transfers: the two paired rows can have DIFFERENT `user_id` (one per side's account). Both rows share `created_by` (the user who initiated the transfer). The pair is still mutual via `transfer_pair_id`.

## RLS

On every group-shared table (`accounts`, `categories`, `transactions`, `transaction_items`, `debt_settlements`), replace the existing single-user policy with:

```sql
USING (
  user_id = auth.uid()
  OR user_id IN (
    SELECT host_user_id FROM group_memberships WHERE member_user_id = auth.uid()
  )
)
WITH CHECK (same)
```

`transaction_items` derives its access through `transactions.user_id` — its policy joins on the parent transaction.

For `account_balances` view: re-create with `SECURITY INVOKER` so it inherits the underlying `accounts` policy automatically.

For `group_memberships`:
- SELECT: `host_user_id = auth.uid() OR member_user_id = auth.uid()`
- INSERT: only via the `claim_invitations_for_email` RPC (no direct INSERT policy)
- DELETE: `host_user_id = auth.uid() OR member_user_id = auth.uid()` (kick or leave)
- UPDATE: forbidden

For `group_invitations`:
- SELECT: `host_user_id = auth.uid() OR invitee_email = (SELECT email FROM auth.users WHERE id = auth.uid())`
- INSERT: `host_user_id = auth.uid()`
- UPDATE: status → `'revoked'` requires `host_user_id = auth.uid()`; status → `'accepted'` / `'expired'` only via `claim_invitations_for_email` RPC

## Invite flow — auto-bind on login

No email is sent and no link is clicked. The invitation is a row that says "host H wants user with email E in their group"; once a user with that email signs in, the app auto-claims the row.

1. Host calls `GroupService.invite(email)`.
   - Service checks: `email !== own auth email` and no existing pending invite for `(host, email)`.
   - INSERT into `group_invitations` with `status='pending'`, `expires_at = now() + interval '30 days'`. `token` stays NULL (column kept for forward compat; no longer generated).
   - Host shares the invitee's email out of band (verbal, chat, etc.) — they just need to make sure the invitee will sign in with that exact address.
2. Whenever the app boots into an authenticated session (`AppShellComponent` init), it calls `GroupService.claimPendingInvitations()`.
3. That hits the `claim_invitations_for_email()` Postgres RPC, which (SECURITY DEFINER, single transaction):
   - Reads `auth.users.email` for `auth.uid()`.
   - For every `group_invitations` row where `status='pending'` AND `LOWER(invitee_email) = LOWER(<user_email>)` AND not expired:
     - If `host_user_id = auth.uid()`: skip and mark the row `'revoked'` (cleanup of stale self-rows that shouldn't have existed).
     - Else if a membership already exists: mark `'accepted'` and move on.
     - Else: `INSERT INTO group_memberships(host, member)` and mark the invitation `'accepted'`.
   - Past-expiry pending rows for this email are flipped to `'expired'` as a side effect.
   - Returns the number of NEW memberships created.
4. Frontend reloads accounts/transactions if the return value > 0; the new group's data appears.

## Viewer-scope filter

`ViewerScopeService.scope: Signal<'mine' | 'others' | 'all'>` is the single source of truth. Persisted to `localStorage` key `viewerScope`.

Service-side application (push-down to Postgres for correct pagination):

```typescript
function applyScope<T extends PostgrestFilterBuilder<...>>(
  q: T, scope: ViewerScope, uid: string
): T {
  if (scope === 'mine')   return q.eq('created_by', uid);
  if (scope === 'others') return q.neq('created_by', uid);
  return q;
}
```

Applied in: `AccountService.loadAccounts` (filters which accounts surface in lists), `TransactionService.getAll` / `getByAccount` / `getRecent` / `getForCalculator`.

`AccountService.loadAllAccounts` (used by form pickers) does NOT apply the filter — pickers must always show every visible account so the user can record on a foreign account regardless of scope.

The mutasi list on Account Detail also ignores the filter — bank-statement integrity comes first; user can see all activity on that account.

## Cross-group correctness

- **Transfers**: `TransactionService.createTransfer` sets each row's `user_id` to its account's owner. `created_by` is the caller. Both rows are visible to all groups via the existing RLS (one via host A's group, one via host B's group). Deleting either row deletes the pair (existing FK cascade unchanged).
- **Settlements**: `SettlementService.settle` creates a `debt_settlements` row with `user_id = lender.user_id` (the lender owns the settlement record) and `created_by = auth.uid()`. The transfer it creates follows the cross-group rules above. The unsettled-reservation FIFO scan reads from both groups equally — RLS handles it.
- **Categories**: a member creating a transaction on host A's account picks from the merged category list (own + host A's). The selected `category_id` may point to either group's category — that's fine, RLS still grants read access for both.
- **Account-detail "Catat transaksi"** on a foreign account: form pre-fills `account=<foreignAccountId>`. On submit, `transaction.user_id = foreignAccount.user_id`, `created_by = auth.uid()`. Settled normally.

## UI surface summary

| Surface | Change |
|---|---|
| Dashboard hero | viewer-scope pill row |
| Transaction List hero | viewer-scope pill row |
| Calculator hero | viewer-scope pill row (3rd filter group: `Penulis`) |
| Account Card | cream owner chip (icon + host name) when foreign |
| Account Detail | cream owner chip (icon + host name) in hero when foreign |
| Transaction row | cream author chip (icon + creator name) near amount when foreign |
| Profile | members, memberships, pending invites, Undang anggota CTA |
| `AppShellComponent` init | calls `GroupService.claimPendingInvitations()` once per session |

## Edge cases / invariants

- Self-invite blocked at service layer (before DB).
- Re-invite while a pending invitation exists for same `(host, email)` blocked at service layer.
- Re-invite after revoke is allowed (new row).
- A revoked invitation cannot be re-activated; create a fresh one.
- A member who leaves can be re-invited; old membership row is gone, fresh sign-in creates a new one via auto-bind.
- Invitee changes their auth email AFTER being invited: the old pending invitation no longer matches, so they won't auto-join. Host must invite the new email.
- Deleting a host's account (`auth.users` row) cascades and drops every membership and invitation. The host's data is also deleted by existing `ON DELETE CASCADE` on `accounts.user_id` etc.
- **Kicking a member** (DELETE on `group_memberships`) is the supported "discard a member" operation: their authored data stays in the host's group (`user_id` unchanged, `created_by` still points to them), they lose all read/write access via RLS, and from the host's view the foreign-author chip on those rows disappears because `profiles_select_groupmates` no longer exposes the ex-member's profile.
- **Fully deleting a member's `auth.users` row currently fails** when they've ever authored a row in another host's group. The cascade chain (`auth.users → profiles`) hits `transactions.created_by` (and the same column on `accounts` / `categories` / `transaction_items` / `debt_settlements`), which migration 0005 declared with default `NO ACTION`. Postgres rolls back the deletion. Same applies to `debt_settlements.user_id`. Workaround for v1: only ever "discard" members via the kick flow (preserves authored data and works correctly). To enable full account deletion later, switch the five `created_by` FKs to `ON DELETE SET NULL` (and relax the NOT NULL) so authored data survives the author's deletion with a NULL attribution.

## Implementation phases

1. **Schema + RLS**: tables, columns, policies, view refresh, backfill, `accept_invitation` RPC. Verifiable in isolation via SQL.
2. **GroupService + auto-bind on login + Profile UI**: host can create invitation rows; `AppShellComponent` calls `claimPendingInvitations()` on init so a signed-in member auto-joins matching groups. No list filters yet — host's data simply starts appearing for members.
3. **ViewerScopeService + pill toggles + service-layer scope plumbing + foreign-author annotations**: filtering live.
4. **Cross-group correctness pass**: transfers/settlements/calculator behave correctly with foreign accounts, account-detail "Catat transaksi" on foreign account, manual QA matrix.
