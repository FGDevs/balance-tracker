import { Injectable, inject } from '@angular/core';
import {
  Account,
  Category,
  CategoryBreakdownEntry,
  ReservationEntry,
  ReservationSummaryEntry,
  Transaction,
  TransactionItem,
} from '../models';
import { AuthService } from './auth.service';
import { SupabaseService } from './supabase.service';
import { ViewerScopeService } from './viewer-scope.service';

// Per-item reservation is user input. settlement_id / parent_item_id are owned
// by the settle flow and never accepted from the caller.
export type TransactionItemInput = Pick<
  TransactionItem,
  'category_id' | 'amount' | 'note' | 'reserved_from_account_id'
> & {
  position?: number;
};

// Restricts moveUp/moveDown neighbor search to the same view the user is in.
// `accountId` matches the Account Detail mutasi list scoping (account_id OR
// reserved_from_account_id). Omit to swap freely across the same date group.
export interface ReorderScope {
  accountId?: number;
}

const TX_ITEM_SELECT =
  '*, category:categories(*), reserved_from_account:accounts!reserved_from_account_id(*)';
const TX_PARENT_SELECT =
  '*, category:categories(*), account:accounts!account_id(*), reserved_from_account:accounts!reserved_from_account_id(*)';
const TX_SELECT = `${TX_PARENT_SELECT}, items:transaction_items(${TX_ITEM_SELECT})`;

@Injectable({ providedIn: 'root' })
export class TransactionService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private viewerScope = inject(ViewerScopeService);

  static readonly PAGE_SIZE = 20;
  static readonly CALCULATOR_CAP = 500;

  async getByAccount(accountId: number, page = 0): Promise<Transaction[]> {
    const from = page * TransactionService.PAGE_SIZE;
    const to = from + TransactionService.PAGE_SIZE - 1;
    const { data, error } = await this.supabase
      .getClient()
      .from('transactions')
      .select(TX_SELECT)
      .eq('account_id', accountId)
      .order('date', { ascending: false })
      .order('sort_index', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return this.normalize((data ?? []) as Transaction[]);
  }

  async getAll(page = 0): Promise<Transaction[]> {
    const from = page * TransactionService.PAGE_SIZE;
    const to = from + TransactionService.PAGE_SIZE - 1;
    let q = this.supabase
      .getClient()
      .from('transactions')
      .select(TX_SELECT)
      .order('date', { ascending: false })
      .order('sort_index', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
    q = this.applyScope(q);
    const { data, error } = await q;
    if (error) throw error;
    return this.normalize((data ?? []) as Transaction[]);
  }

  // Transaction List calendar — all transactions on a specific local date,
  // sorted by (sort_index DESC, id DESC). No pagination (single day is bounded).
  // Honors viewer scope.
  async getByDate(date: string): Promise<Transaction[]> {
    let q = this.supabase
      .getClient()
      .from('transactions')
      .select(TX_SELECT)
      .eq('date', date)
      .order('sort_index', { ascending: false })
      .order('id', { ascending: false });
    q = this.applyScope(q);
    const { data, error } = await q;
    if (error) throw error;
    return this.normalize((data ?? []) as Transaction[]);
  }

  // Transaction List calendar — set of 'YYYY-MM-DD' dates within the given
  // 'YYYY-MM' month that have ≥1 visible transaction. Drives the dot indicator.
  // Honors viewer scope.
  async getTransactionDatesForMonth(month: string): Promise<Set<string>> {
    const [y, m] = month.split('-').map(Number);
    if (!y || !m || m < 1 || m > 12) {
      throw new Error(`Invalid month '${month}', expected 'YYYY-MM'`);
    }
    const from = `${month}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${month}-${String(lastDay).padStart(2, '0')}`;
    let q = this.supabase
      .getClient()
      .from('transactions')
      .select('date')
      .gte('date', from)
      .lte('date', to);
    q = this.applyScope(q);
    const { data, error } = await q;
    if (error) throw error;
    const set = new Set<string>();
    for (const row of (data ?? []) as Array<{ date: string }>) {
      set.add(row.date);
    }
    return set;
  }

  async getRecent(limit: number): Promise<Transaction[]> {
    let q = this.supabase
      .getClient()
      .from('transactions')
      .select(TX_SELECT)
      .order('date', { ascending: false })
      .order('sort_index', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    q = this.applyScope(q);
    const { data, error } = await q;
    if (error) throw error;
    return this.normalize((data ?? []) as Transaction[]);
  }

  async getById(id: number): Promise<Transaction | null> {
    const { data, error } = await this.supabase
      .getClient()
      .from('transactions')
      .select(TX_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return this.normalize([data as Transaction])[0];
  }

  async getUnsettledReservations(
    reservedFromAccountId: number,
  ): Promise<ReservationEntry[]> {
    const client = this.supabase.getClient();

    // Parent-level reservations — only valid when items are absent (§7.3 hybrid).
    const { data: parentRows, error: parentErr } = await client
      .from('transactions')
      .select(TX_SELECT)
      .eq('reserved_from_account_id', reservedFromAccountId)
      .is('settlement_id', null)
      .order('date', { ascending: true })
      .order('id', { ascending: true });
    if (parentErr) throw parentErr;
    const parents = this.normalize((parentRows ?? []) as Transaction[]).filter(
      (p) => !p.items || p.items.length === 0,
    );

    // Item-level reservations with their parent transaction embedded for context.
    const { data: itemRows, error: itemErr } = await client
      .from('transaction_items')
      .select(`${TX_ITEM_SELECT}, parent:transactions!transaction_id(${TX_PARENT_SELECT})`)
      .eq('reserved_from_account_id', reservedFromAccountId)
      .is('settlement_id', null);
    if (itemErr) throw itemErr;
    const items = (itemRows ?? []) as Array<
      TransactionItem & { parent: Transaction }
    >;

    const entries: ReservationEntry[] = [
      ...parents.map<ReservationEntry>((p) => ({
        kind: 'parent' as const,
        id: p.id,
        amount: p.amount,
        parent: p,
        category: p.category,
        note: p.note,
      })),
      ...items.map<ReservationEntry>((it) => ({
        kind: 'item' as const,
        id: it.id,
        amount: it.amount,
        parent: it.parent,
        category: it.category,
        note: it.note,
      })),
    ];

    entries.sort((a, b) => {
      if (a.parent.date !== b.parent.date)
        return a.parent.date < b.parent.date ? -1 : 1;
      if (a.parent.id !== b.parent.id) return a.parent.id - b.parent.id;
      return a.id - b.id;
    });
    return entries;
  }

  // Transaction Import Review — fetches existing transactions on the picked
  // import account for the given set of dates (caller passes union of
  // draft.date ± 1). Page derives per-draft duplicate matches client-side.
  // Sorted (date DESC, sort_index DESC, id DESC). Honors viewer scope.
  async getNearbyForImport(params: {
    accountId: number;
    dates: string[];
  }): Promise<Transaction[]> {
    if (params.dates.length === 0) return [];
    const unique = Array.from(new Set(params.dates));
    let q = this.supabase
      .getClient()
      .from('transactions')
      .select(TX_SELECT)
      .eq('account_id', params.accountId)
      .in('date', unique)
      .order('date', { ascending: false })
      .order('sort_index', { ascending: false })
      .order('id', { ascending: false });
    q = this.applyScope(q);
    const { data, error } = await q;
    if (error) throw error;
    return this.normalize((data ?? []) as Transaction[]);
  }

  async getForCalculator(filters: {
    accountIds: number[] | 'all';
    dateFrom: string;
    dateTo: string;
  }): Promise<Transaction[]> {
    let q = this.supabase
      .getClient()
      .from('transactions')
      .select(TX_SELECT)
      .gte('date', filters.dateFrom)
      .lte('date', filters.dateTo)
      .order('date', { ascending: false })
      .order('sort_index', { ascending: false })
      .order('id', { ascending: false })
      .limit(TransactionService.CALCULATOR_CAP);
    if (filters.accountIds !== 'all') {
      if (filters.accountIds.length === 0) return [];
      q = q.in('account_id', filters.accountIds);
    }
    q = this.applyScope(q);
    const { data, error } = await q;
    if (error) throw error;
    return this.normalize((data ?? []) as Transaction[]);
  }

  // §14 Statistics — expense breakdown by category for a date range, optionally
  // scoped to one payer account. Item-level rows contribute under their own
  // category; parent-level rows (no items) contribute under parent.category_id.
  // Honors viewer scope via created_by on parents (items inherit author).
  async getCategoryBreakdown(opts: {
    from: string;
    to: string;
    accountId?: number | null;
  }): Promise<CategoryBreakdownEntry[]> {
    let q = this.supabase
      .getClient()
      .from('transactions')
      .select(TX_SELECT)
      .eq('type', 'expense')
      .gte('date', opts.from)
      .lte('date', opts.to);
    if (opts.accountId != null) q = q.eq('account_id', opts.accountId);
    q = this.applyScope(q);
    const { data, error } = await q;
    if (error) throw error;
    const txs = this.normalize((data ?? []) as Transaction[]);

    type Bucket = { category: Category | null; total: number; count: number };
    const buckets = new Map<number | 'none', Bucket>();
    const add = (
      categoryId: number | null | undefined,
      category: Category | undefined,
      amount: number,
    ) => {
      const key = categoryId == null ? 'none' : categoryId;
      const existing = buckets.get(key);
      if (existing) {
        existing.total += amount;
        existing.count += 1;
      } else {
        buckets.set(key, {
          category: category ?? null,
          total: amount,
          count: 1,
        });
      }
    };

    for (const tx of txs) {
      if (tx.items && tx.items.length > 0) {
        for (const item of tx.items) {
          add(item.category_id, item.category, Number(item.amount));
        }
      } else {
        add(tx.category_id, tx.category, Number(tx.amount));
      }
    }

    const totalAll = Array.from(buckets.values()).reduce(
      (s, b) => s + b.total,
      0,
    );
    return Array.from(buckets.values())
      .map<CategoryBreakdownEntry>((b) => ({
        category: b.category,
        total: Number(b.total.toFixed(2)),
        count: b.count,
        share: totalAll > 0 ? b.total / totalAll : 0,
      }))
      .sort((a, b) => b.total - a.total);
  }

  // §14 Statistics — current-state reservation summary, ignores any period.
  // Groups unsettled parent-level + item-level reservations by owing account.
  // When accountId is set, returns at most one entry (for that account).
  // Honors viewer scope via created_by.
  async getReservationSummary(opts: {
    accountId?: number | null;
  }): Promise<ReservationSummaryEntry[]> {
    const client = this.supabase.getClient();

    let parentQ = client
      .from('transactions')
      .select(
        'id, amount, date, reserved_from_account:accounts!reserved_from_account_id(*)',
      )
      .not('reserved_from_account_id', 'is', null)
      .is('settlement_id', null);
    if (opts.accountId != null) {
      parentQ = parentQ.eq('reserved_from_account_id', opts.accountId);
    }
    parentQ = this.applyScope(parentQ);
    const { data: parentRows, error: parentErr } = await parentQ;
    if (parentErr) throw parentErr;

    let itemQ = client
      .from('transaction_items')
      .select(
        'id, amount, reserved_from_account:accounts!reserved_from_account_id(*), parent:transactions!transaction_id(date)',
      )
      .not('reserved_from_account_id', 'is', null)
      .is('settlement_id', null);
    if (opts.accountId != null) {
      itemQ = itemQ.eq('reserved_from_account_id', opts.accountId);
    }
    itemQ = this.applyScope(itemQ);
    const { data: itemRows, error: itemErr } = await itemQ;
    if (itemErr) throw itemErr;

    type Acc = {
      account: Account;
      totalReserved: number;
      count: number;
      oldestDate: string;
    };
    const byAccount = new Map<number, Acc>();
    const add = (acc: Account, amount: number, date: string) => {
      const existing = byAccount.get(acc.id);
      if (existing) {
        existing.totalReserved += amount;
        existing.count += 1;
        if (date < existing.oldestDate) existing.oldestDate = date;
      } else {
        byAccount.set(acc.id, {
          account: acc,
          totalReserved: amount,
          count: 1,
          oldestDate: date,
        });
      }
    };

    for (const row of (parentRows ?? []) as unknown as Array<{
      amount: number;
      date: string;
      reserved_from_account: Account | null;
    }>) {
      if (!row.reserved_from_account) continue;
      add(row.reserved_from_account, Number(row.amount), row.date);
    }
    for (const row of (itemRows ?? []) as unknown as Array<{
      amount: number;
      reserved_from_account: Account | null;
      parent: { date: string } | null;
    }>) {
      if (!row.reserved_from_account || !row.parent) continue;
      add(row.reserved_from_account, Number(row.amount), row.parent.date);
    }

    return Array.from(byAccount.values())
      .map<ReservationSummaryEntry>((a) => ({
        account: a.account,
        totalReserved: Number(a.totalReserved.toFixed(2)),
        count: a.count,
        oldestDate: a.oldestDate,
      }))
      .sort((a, b) => b.totalReserved - a.totalReserved);
  }

  async getItems(transactionId: number): Promise<TransactionItem[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('transaction_items')
      .select('*, category:categories(*)')
      .eq('transaction_id', transactionId)
      .order('position', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    return (data ?? []) as TransactionItem[];
  }

  async create(
    data: Omit<Transaction, 'id' | 'user_id' | 'created_by' | 'created_at'>,
    items?: TransactionItemInput[],
  ): Promise<Transaction> {
    const createdBy = this.requireUserId();
    const ownerId = await this.resolveAccountOwner(data.account_id);
    const hasItems = !!items && items.length > 0;
    if (hasItems) await this.validateItemReservations(items!, data.account_id);
    const { amount, categoryId } = this.applyItemsToParent(data, items);

    const stripped = this.stripJoins(data);
    const reservedFrom = hasItems
      ? null
      : stripped.reserved_from_account_id ?? null;

    const { data: row, error } = await this.supabase
      .getClient()
      .from('transactions')
      .insert({
        ...stripped,
        user_id: ownerId,
        created_by: createdBy,
        amount,
        category_id: categoryId,
        reserved_from_account_id: reservedFrom,
        sort_index: stripped.sort_index ?? Date.now(),
      })
      .select()
      .single();
    if (error) throw error;
    const tx = row as Transaction;

    if (hasItems) {
      await this.insertItems(tx.id, items!, createdBy);
    }

    if (tx.type === 'income') {
      await this.adjustBalance(tx.account_id, tx.amount);
    } else if (tx.type === 'expense' && !tx.reserved_from_account_id) {
      // Real-bank-statement consistency: parent.amount always debits the payer
      // when there is no parent-level reservation. Item-level reservation does
      // not change this — the bank mutation row is one event.
      await this.adjustBalance(tx.account_id, -tx.amount);
    }
    return tx;
  }

  async createTransfer(params: {
    fromAccountId: number;
    toAccountId: number;
    amount: number;
    date: string;
    note?: string;
    sortIndex?: number;
  }): Promise<void> {
    if (params.fromAccountId === params.toAccountId) {
      throw new Error('Source and destination must differ');
    }
    const createdBy = this.requireUserId();
    const [fromOwner, toOwner] = await Promise.all([
      this.resolveAccountOwner(params.fromAccountId),
      this.resolveAccountOwner(params.toAccountId),
    ]);
    const client = this.supabase.getClient();

    const baseSort = params.sortIndex ?? Date.now();
    const { data: outRow, error: outErr } = await client
      .from('transactions')
      .insert({
        user_id: fromOwner,
        created_by: createdBy,
        account_id: params.fromAccountId,
        amount: params.amount,
        type: 'transfer',
        date: params.date,
        note: params.note ?? null,
        sort_index: baseSort,
      })
      .select()
      .single();
    if (outErr) throw outErr;

    const { data: inRow, error: inErr } = await client
      .from('transactions')
      .insert({
        user_id: toOwner,
        created_by: createdBy,
        account_id: params.toAccountId,
        amount: params.amount,
        type: 'transfer',
        date: params.date,
        note: params.note ?? null,
        transfer_pair_id: (outRow as Transaction).id,
        sort_index: baseSort,
      })
      .select()
      .single();
    if (inErr) throw inErr;

    const { error: linkErr } = await client
      .from('transactions')
      .update({ transfer_pair_id: (inRow as Transaction).id })
      .eq('id', (outRow as Transaction).id);
    if (linkErr) throw linkErr;

    await this.adjustBalance(params.fromAccountId, -params.amount);
    await this.adjustBalance(params.toAccountId, params.amount);
  }

  async createReservedExpense(params: {
    payerAccountId: number;
    reservedFromAccountId: number;
    categoryId?: number;
    amount: number;
    date: string;
    note?: string;
    items?: TransactionItemInput[];
  }): Promise<Transaction> {
    if (params.payerAccountId === params.reservedFromAccountId) {
      throw new Error('Payer and owing account must differ');
    }
    const client = this.supabase.getClient();
    const { data: owing, error: owingErr } = await client
      .from('accounts')
      .select('type')
      .eq('id', params.reservedFromAccountId)
      .single();
    if (owingErr) throw owingErr;
    if ((owing as { type: string }).type === 'credit') {
      throw new Error('Owing account cannot be a credit card');
    }

    const createdBy = this.requireUserId();
    const payerOwner = await this.resolveAccountOwner(params.payerAccountId);
    const hasItems = !!params.items && params.items.length > 0;

    if (hasItems) {
      // Hybrid invariant (§7.3): items present → parent-level reservation MUST
      // be NULL. Auto-promote the requested reservedFromAccountId onto any item
      // that doesn't already specify its own. The parent row is inserted with
      // NULL reservation; per-item reservation drives the view's total_reserved.
      const promoted = params.items!.map((item) => ({
        ...item,
        reserved_from_account_id:
          item.reserved_from_account_id ?? params.reservedFromAccountId,
      }));
      this.validateItems(promoted);
      await this.validateItemReservations(promoted, params.payerAccountId);
      const amount = this.sumItems(promoted);

      const { data: row, error } = await client
        .from('transactions')
        .insert({
          user_id: payerOwner,
          created_by: createdBy,
          account_id: params.payerAccountId,
          reserved_from_account_id: null,
          category_id: null,
          amount,
          type: 'expense',
          date: params.date,
          note: params.note ?? null,
          sort_index: Date.now(),
        })
        .select()
        .single();
      if (error) throw error;
      const tx = row as Transaction;
      await this.insertItems(tx.id, promoted, createdBy);
      await this.adjustBalance(params.payerAccountId, -amount);
      return tx;
    }

    // Parent-level reservation path (no items)
    const { data: row, error } = await client
      .from('transactions')
      .insert({
        user_id: payerOwner,
        created_by: createdBy,
        account_id: params.payerAccountId,
        reserved_from_account_id: params.reservedFromAccountId,
        category_id: params.categoryId ?? null,
        amount: params.amount,
        type: 'expense',
        date: params.date,
        note: params.note ?? null,
        sort_index: Date.now(),
      })
      .select()
      .single();
    if (error) throw error;
    const tx = row as Transaction;
    await this.adjustBalance(params.payerAccountId, -params.amount);
    return tx;
  }

  async update(
    id: number,
    data: Partial<Transaction>,
    items?: TransactionItemInput[] | null,
  ): Promise<Transaction> {
    const client = this.supabase.getClient();

    let patch = this.stripJoins(data);

    if (items !== undefined) {
      // Replace-or-clear semantics:
      //   items === null      → remove all items, leave parent as-is
      //   items: []           → also clears
      //   items: non-empty[]  → replace, recompute parent amount + null category
      await client.from('transaction_items').delete().eq('transaction_id', id);

      if (items && items.length > 0) {
        const existing = await this.getById(id);
        if (!existing) throw new Error('Transaction not found');
        this.validateItems(items);
        await this.validateItemReservations(items, existing.account_id);
        await this.insertItems(id, items, this.requireUserId());
        patch = {
          ...patch,
          amount: this.sumItems(items),
          category_id: null as unknown as number | undefined,
          // Hybrid invariant: items present → parent-level reservation NULL.
          reserved_from_account_id: null as unknown as number | undefined,
          settlement_id: null as unknown as number | undefined,
        };
      }
    }

    const { data: row, error } = await client
      .from('transactions')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return row as Transaction;
  }

  // Bulk update sort_index for a set of rows. Used by the drag-drop reorder UI
  // on Save, where local ordering is computed in the page and then committed in
  // one shot. No-op when the updates array is empty.
  async setSortIndices(
    updates: { id: number; sort_index: number }[],
  ): Promise<void> {
    if (updates.length === 0) return;
    const client = this.supabase.getClient();
    await Promise.all(
      updates.map(({ id, sort_index }) =>
        client.from('transactions').update({ sort_index }).eq('id', id),
      ),
    );
  }

  async moveUp(id: number, scope?: ReorderScope): Promise<void> {
    await this.swapAdjacent(id, 'up', scope);
  }

  async moveDown(id: number, scope?: ReorderScope): Promise<void> {
    await this.swapAdjacent(id, 'down', scope);
  }

  // Swap sort_index with the next/prev row in the same date group. No-op at edges.
  // Scope restricts the neighbor search to the same view the user is looking at;
  // currently supports `accountId` for the Account Detail mutasi list (matches
  // account_id only, same as getByAccount).
  private async swapAdjacent(
    id: number,
    dir: 'up' | 'down',
    scope?: ReorderScope,
  ): Promise<void> {
    const target = await this.getById(id);
    if (!target) return;
    const client = this.supabase.getClient();
    let q = client
      .from('transactions')
      .select('id, sort_index')
      .eq('date', target.date)
      .neq('id', id);
    if (scope?.accountId != null) {
      q = q.eq('account_id', scope.accountId);
    }
    const neighbor = dir === 'up'
      ? await q
          .gt('sort_index', target.sort_index)
          .order('sort_index', { ascending: true })
          .order('id', { ascending: true })
          .limit(1)
          .maybeSingle()
      : await q
          .lt('sort_index', target.sort_index)
          .order('sort_index', { ascending: false })
          .order('id', { ascending: false })
          .limit(1)
          .maybeSingle();
    if (neighbor.error) throw neighbor.error;
    const other = neighbor.data as { id: number; sort_index: number } | null;
    if (!other) return; // already at the edge
    const { error: e1 } = await client
      .from('transactions')
      .update({ sort_index: other.sort_index })
      .eq('id', target.id);
    if (e1) throw e1;
    const { error: e2 } = await client
      .from('transactions')
      .update({ sort_index: target.sort_index })
      .eq('id', other.id);
    if (e2) throw e2;
  }

  async delete(id: number): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) return;
    const client = this.supabase.getClient();

    if (existing.type === 'transfer' && existing.transfer_pair_id) {
      const pair = await this.getById(existing.transfer_pair_id);
      const { error: pairErr } = await client
        .from('transactions')
        .delete()
        .eq('id', existing.transfer_pair_id);
      if (pairErr) throw pairErr;
      if (pair) {
        const sign = pair.type === 'transfer' ? -1 : 0;
        await this.adjustBalance(pair.account_id, sign * pair.amount);
      }
    }

    const { error } = await client
      .from('transactions')
      .delete()
      .eq('id', id);
    if (error) throw error;

    if (existing.type === 'income') {
      await this.adjustBalance(existing.account_id, -existing.amount);
    } else if (existing.type === 'expense' && !existing.reserved_from_account_id) {
      await this.adjustBalance(existing.account_id, existing.amount);
    } else if (existing.type === 'expense' && existing.reserved_from_account_id) {
      await this.adjustBalance(existing.account_id, existing.amount);
    } else if (existing.type === 'transfer') {
      await this.adjustBalance(existing.account_id, existing.amount);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private applyItemsToParent(
    data: Omit<Transaction, 'id' | 'user_id' | 'created_by' | 'created_at'>,
    items: TransactionItemInput[] | undefined,
  ): { amount: number; categoryId: number | null } {
    if (!items || items.length === 0) {
      return {
        amount: data.amount,
        categoryId: data.category_id ?? null,
      };
    }
    if (data.type === 'transfer') {
      throw new Error('Transfers cannot have rincian');
    }
    this.validateItems(items);
    return {
      amount: this.sumItems(items),
      categoryId: null,
    };
  }

  private validateItems(items: TransactionItemInput[]): void {
    if (items.length === 0) throw new Error('Rincian harus berisi minimal 1 baris');
    for (const item of items) {
      if (!item.amount || item.amount <= 0) {
        throw new Error('Setiap rincian wajib diisi nominalnya (> 0)');
      }
    }
  }

  private sumItems(items: TransactionItemInput[]): number {
    const total = items.reduce((s, i) => s + Number(i.amount), 0);
    return Number(total.toFixed(2));
  }

  private async insertItems(
    transactionId: number,
    items: TransactionItemInput[],
    createdBy: string,
  ): Promise<void> {
    const rows = items.map((item, idx) => ({
      transaction_id: transactionId,
      created_by: createdBy,
      category_id: item.category_id ?? null,
      amount: item.amount,
      note: item.note ?? null,
      position: item.position ?? idx,
      reserved_from_account_id: item.reserved_from_account_id ?? null,
    }));
    const { error } = await this.supabase
      .getClient()
      .from('transaction_items')
      .insert(rows);
    if (error) throw error;
  }

  // §13.6 — push the Saya/Lain/Semua filter down to Postgres so pagination
  // stays correct. NOT applied to getByAccount: account-detail's mutasi list
  // surfaces every transaction on the account regardless of author, per the
  // "bank-statement integrity comes first" rule.
  private applyScope<T extends { eq: Function; neq: Function }>(q: T): T {
    const scope = this.viewerScope.scope();
    const uid = this.auth.currentUser()?.id;
    if (!uid || scope === 'all') return q;
    if (scope === 'mine') return q.eq('created_by', uid);
    return q.neq('created_by', uid);
  }

  // Resolves a transaction's group owner (= accounts.user_id) given an
  // account id. Required before INSERT/UPDATE so the row lands in the
  // correct group regardless of who's authoring it (§13).
  private async resolveAccountOwner(accountId: number): Promise<string> {
    const { data, error } = await this.supabase
      .getClient()
      .from('accounts')
      .select('user_id')
      .eq('id', accountId)
      .single();
    if (error) throw error;
    return (data as { user_id: string }).user_id;
  }

  // Async validation of per-item reservation:
  //  - reserved_from_account_id != parent.account_id
  //  - owing account is not type 'credit'
  private async validateItemReservations(
    items: TransactionItemInput[],
    parentAccountId: number,
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        items
          .map((i) => i.reserved_from_account_id)
          .filter((x): x is number => x != null),
      ),
    );
    if (ids.length === 0) return;
    if (ids.includes(parentAccountId)) {
      throw new Error('Rincian tidak bisa hutang ke akun pembayar sendiri');
    }
    const { data, error } = await this.supabase
      .getClient()
      .from('accounts')
      .select('id, type')
      .in('id', ids);
    if (error) throw error;
    const byId = new Map<number, string>(
      ((data ?? []) as Array<{ id: number; type: string }>).map((r) => [
        r.id,
        r.type,
      ]),
    );
    for (const id of ids) {
      const type = byId.get(id);
      if (!type) throw new Error('Akun rincian tidak ditemukan');
      if (type === 'credit') {
        throw new Error('Akun pemilik hutang rincian tidak boleh kartu kredit');
      }
    }
  }

  private normalize(txs: Transaction[]): Transaction[] {
    for (const tx of txs) {
      if (tx.items && tx.items.length > 1) {
        tx.items.sort((a, b) => a.position - b.position || a.id - b.id);
      }
    }
    return txs;
  }

  private async adjustBalance(accountId: number, delta: number): Promise<void> {
    if (delta === 0) return;
    const client = this.supabase.getClient();
    const { data: account, error: readErr } = await client
      .from('accounts')
      .select('balance')
      .eq('id', accountId)
      .single();
    if (readErr) throw readErr;
    const current = Number((account as { balance: number }).balance);
    const next = Number((current + delta).toFixed(2));
    const { error: writeErr } = await client
      .from('accounts')
      .update({ balance: next })
      .eq('id', accountId);
    if (writeErr) throw writeErr;
  }

  private requireUserId(): string {
    const id = this.auth.currentUser()?.id;
    if (!id) throw new Error('Not authenticated');
    return id;
  }

  private stripJoins<T extends Partial<Transaction>>(data: T): Partial<Transaction> {
    const { category, account, reserved_from_account, items, ...rest } =
      data as Transaction;
    return rest;
  }
}
