import { Injectable, inject } from '@angular/core';
import {
  DebtSettlement,
  ReservationEntry,
  Transaction,
  TransactionItem,
} from '../models';
import { AuthService } from './auth.service';
import { SupabaseService } from './supabase.service';
import { TransactionService } from './transaction.service';

export interface SettlementPreview {
  fullySettled: ReservationEntry[];
  partialEntry: ReservationEntry | null;
  remainderAmount: number;
  totalCovered: number;
}

@Injectable({ providedIn: 'root' })
export class SettlementService {
  private readonly supabase = inject(SupabaseService);
  private readonly auth = inject(AuthService);
  private readonly transactions = inject(TransactionService);

  async settle(params: {
    payerAccountId: number;
    reservedFromAccountId: number;
    paymentAmount: number;
    paymentDate: string;
    viaAccountId?: number | null;
  }): Promise<DebtSettlement> {
    if (params.payerAccountId === params.reservedFromAccountId) {
      throw new Error('Payer and owing account must differ');
    }
    if (!Number.isFinite(params.paymentAmount) || params.paymentAmount <= 0) {
      throw new Error('Payment amount must be greater than zero');
    }
    const createdBy = this.auth.currentUser()?.id;
    if (!createdBy) throw new Error('Not authenticated');
    const client = this.supabase.getClient();

    // Resolve group owners up-front; lender's owner becomes the settlement's
    // user_id (§13). Transfer-pair rows each take their own account's owner.
    const [lenderOwner, owingOwner] = await Promise.all([
      this.resolveAccountOwner(params.payerAccountId),
      this.resolveAccountOwner(params.reservedFromAccountId),
    ]);

    const { data: sRow, error: sErr } = await client
      .from('debt_settlements')
      .insert({
        user_id: lenderOwner,
        created_by: createdBy,
        account_id: params.payerAccountId,
        reserved_from_account_id: params.reservedFromAccountId,
        total_amount: params.paymentAmount,
      })
      .select()
      .single();
    if (sErr) throw sErr;
    const settlement = sRow as DebtSettlement;

    // Real-money movement: owing → creditor, optionally routed through a
    // conduit (owing → via → creditor) so the conduit's mutasi matches the
    // bank (§7.4). Returns the owing-side debit row id.
    const transferTxId = await this.recordSettlementTransfers({
      settlementId: settlement.id,
      owingId: params.reservedFromAccountId,
      owingOwner,
      creditorId: params.payerAccountId,
      creditorOwner: lenderOwner,
      viaId: params.viaAccountId ?? null,
      amount: params.paymentAmount,
      date: params.paymentDate,
      createdBy,
    });

    const { error: tErr } = await client
      .from('debt_settlements')
      .update({ transfer_tx_id: transferTxId })
      .eq('id', settlement.id);
    if (tErr) throw tErr;

    // Move the real money — the only balance mutation; the conduit nets zero.
    await this.adjustBalance(params.reservedFromAccountId, -params.paymentAmount);
    await this.adjustBalance(params.payerAccountId, params.paymentAmount);

    // FIFO over union of parent-level and item-level unsettled reservations
    // owed by reservedFromAccountId to payerAccountId.
    const entries = await this.fetchUnsettledForLender(
      params.reservedFromAccountId,
      params.payerAccountId,
    );

    let remaining = params.paymentAmount;
    for (const entry of entries) {
      if (remaining <= 0) break;
      if (entry.amount <= remaining) {
        await this.markFullySettled(entry, settlement.id);
        remaining = Number((remaining - entry.amount).toFixed(2));
      } else {
        const settledPortion = remaining;
        const remainderAmount = Number(
          (entry.amount - remaining).toFixed(2),
        );
        await this.splitPartial(
          entry,
          settlement.id,
          settledPortion,
          remainderAmount,
          createdBy,
        );
        remaining = 0;
      }
    }

    return { ...settlement, transfer_tx_id: transferTxId };
  }

  // Selection-driven settlement (§7.4.1). The caller passes the exact entries
  // to mark settled — no FIFO, no partial split. paymentAmount is derived from
  // SUM(entries.amount). Shares the transfer-pair + balance-adjust skeleton
  // with settle(); diverges only at the entry-marking step.
  async settleSelected(params: {
    payerAccountId: number;
    reservedFromAccountId: number;
    entries: ReservationEntry[];
    paymentDate: string;
    viaAccountId?: number | null;
  }): Promise<DebtSettlement> {
    if (params.payerAccountId === params.reservedFromAccountId) {
      throw new Error('Payer and owing account must differ');
    }
    if (params.entries.length === 0) {
      throw new Error('Pilih minimal satu hutang');
    }
    for (const entry of params.entries) {
      if (entry.parent.account_id !== params.payerAccountId) {
        throw new Error('Hutang yang dipilih bukan ke akun ini');
      }
    }
    const paymentAmount = Number(
      params.entries.reduce((sum, e) => sum + e.amount, 0).toFixed(2),
    );
    if (paymentAmount <= 0) {
      throw new Error('Total hutang yang dipilih harus lebih dari nol');
    }
    const createdBy = this.auth.currentUser()?.id;
    if (!createdBy) throw new Error('Not authenticated');
    const client = this.supabase.getClient();

    const [lenderOwner, owingOwner] = await Promise.all([
      this.resolveAccountOwner(params.payerAccountId),
      this.resolveAccountOwner(params.reservedFromAccountId),
    ]);

    const { data: sRow, error: sErr } = await client
      .from('debt_settlements')
      .insert({
        user_id: lenderOwner,
        created_by: createdBy,
        account_id: params.payerAccountId,
        reserved_from_account_id: params.reservedFromAccountId,
        total_amount: paymentAmount,
      })
      .select()
      .single();
    if (sErr) throw sErr;
    const settlement = sRow as DebtSettlement;

    const transferTxId = await this.recordSettlementTransfers({
      settlementId: settlement.id,
      owingId: params.reservedFromAccountId,
      owingOwner,
      creditorId: params.payerAccountId,
      creditorOwner: lenderOwner,
      viaId: params.viaAccountId ?? null,
      amount: paymentAmount,
      date: params.paymentDate,
      createdBy,
    });

    const { error: tErr } = await client
      .from('debt_settlements')
      .update({ transfer_tx_id: transferTxId })
      .eq('id', settlement.id);
    if (tErr) throw tErr;

    await this.adjustBalance(params.reservedFromAccountId, -paymentAmount);
    await this.adjustBalance(params.payerAccountId, paymentAmount);

    for (const entry of params.entries) {
      await this.markFullySettled(entry, settlement.id);
    }

    return { ...settlement, transfer_tx_id: transferTxId };
  }

  // Fully undoes one settle()/settleSelected() call (§7.4.3) — the inverse of
  // §7.4, in order: re-merge any partial split, un-stamp every settled entry,
  // reverse the money movement, then delete the transfer legs + the settlement
  // row. Client-orchestrated like settle() (not a single DB transaction).
  // Reverse newest-first: if a later settlement consumed this one's remainder,
  // that remainder is left in place.
  async reverseSettlement(settlementId: number): Promise<void> {
    const client = this.supabase.getClient();

    const { data: sRow, error: sErr } = await client
      .from('debt_settlements')
      .select('*')
      .eq('id', settlementId)
      .maybeSingle();
    if (sErr) throw sErr;
    if (!sRow) throw new Error('Pelunasan tidak ditemukan');
    const settlement = sRow as DebtSettlement;

    // 1. Re-merge the straddling partial split (if any) back into its original,
    //    then drop the remainder. Must run BEFORE un-stamping — originals are
    //    found via settlement_id. At most one split exists per settlement.
    await this.remergeSplit('transactions', 'parent_tx_id', settlementId);
    await this.remergeSplit('transaction_items', 'parent_item_id', settlementId);

    // 2. Un-stamp every settled entry → the debts become unsettled again.
    const { error: txErr } = await client
      .from('transactions')
      .update({ settlement_id: null })
      .eq('settlement_id', settlementId);
    if (txErr) throw txErr;
    const { error: itemErr } = await client
      .from('transaction_items')
      .update({ settlement_id: null })
      .eq('settlement_id', settlementId);
    if (itemErr) throw itemErr;

    // 3. Reverse the real-money movement (mirror of §7.4 step 2): owing gets
    //    its money back, creditor gives it back. A conduit's legs cancelled, so
    //    only owing + creditor move regardless of viaAccountId.
    await this.adjustBalance(
      settlement.reserved_from_account_id,
      settlement.total_amount,
    );
    await this.adjustBalance(settlement.account_id, -settlement.total_amount);

    // 4. Delete the transfer legs, then the settlement row. Detach
    //    transfer_tx_id first so deleting the legs doesn't trip the FK.
    const { error: detachErr } = await client
      .from('debt_settlements')
      .update({ transfer_tx_id: null })
      .eq('id', settlementId);
    if (detachErr) throw detachErr;
    const { error: delTxErr } = await client
      .from('transactions')
      .delete()
      .eq('settlement_transfer_id', settlementId);
    if (delTxErr) throw delTxErr;
    const { error: delSErr } = await client
      .from('debt_settlements')
      .delete()
      .eq('id', settlementId);
    if (delSErr) throw delSErr;
  }

  // Inverse of splitPartial: for the settlement's straddling entry, add the
  // unsettled remainder's amount back into the original (settled) row and
  // delete the remainder. Generic over parent (transactions/parent_tx_id) and
  // item (transaction_items/parent_item_id) kinds.
  private async remergeSplit(
    table: 'transactions' | 'transaction_items',
    parentCol: 'parent_tx_id' | 'parent_item_id',
    settlementId: number,
  ): Promise<void> {
    const client = this.supabase.getClient();
    const { data: origRows, error: origErr } = await client
      .from(table)
      .select('id, amount')
      .eq('settlement_id', settlementId);
    if (origErr) throw origErr;
    const originals = (origRows ?? []) as Array<{ id: number; amount: number }>;
    if (originals.length === 0) return;

    const { data: remRows, error: remErr } = await client
      .from(table)
      .select(`id, amount, ${parentCol}`)
      .in(parentCol, originals.map((o) => o.id))
      .is('settlement_id', null);
    if (remErr) throw remErr;
    const remainders = (remRows ?? []) as Array<
      { id: number; amount: number } & Record<string, number>
    >;

    for (const rem of remainders) {
      const orig = originals.find((o) => o.id === rem[parentCol]);
      if (!orig) continue;
      const merged = Number(
        (Number(orig.amount) + Number(rem.amount)).toFixed(2),
      );
      const { error: uErr } = await client
        .from(table)
        .update({ amount: merged })
        .eq('id', orig.id);
      if (uErr) throw uErr;
      const { error: dErr } = await client
        .from(table)
        .delete()
        .eq('id', rem.id);
      if (dErr) throw dErr;
    }
  }

  async previewSettlement(params: {
    payerAccountId: number;
    reservedFromAccountId: number;
    paymentAmount: number;
  }): Promise<SettlementPreview> {
    const entries = await this.fetchUnsettledForLender(
      params.reservedFromAccountId,
      params.payerAccountId,
    );

    const fullySettled: ReservationEntry[] = [];
    let partialEntry: ReservationEntry | null = null;
    let remainderAmount = 0;
    let remaining = params.paymentAmount;
    let totalCovered = 0;

    for (const entry of entries) {
      if (remaining <= 0) break;
      if (entry.amount <= remaining) {
        fullySettled.push(entry);
        totalCovered = Number((totalCovered + entry.amount).toFixed(2));
        remaining = Number((remaining - entry.amount).toFixed(2));
      } else {
        partialEntry = entry;
        remainderAmount = Number((entry.amount - remaining).toFixed(2));
        totalCovered = Number((totalCovered + remaining).toFixed(2));
        remaining = 0;
      }
    }

    return { fullySettled, partialEntry, remainderAmount, totalCovered };
  }

  // ── internal ────────────────────────────────────────────────────────────

  // Same union/sort as TransactionService.getUnsettledReservations, but
  // additionally constrained to a specific lender (payer) — settle() must
  // only touch reservations owed to the account being paid.
  private async fetchUnsettledForLender(
    owingId: number,
    lenderId: number,
  ): Promise<ReservationEntry[]> {
    const all = await this.transactions.getUnsettledReservations(owingId);
    return all.filter((e) => e.parent.account_id === lenderId);
  }

  private async markFullySettled(
    entry: ReservationEntry,
    settlementId: number,
  ): Promise<void> {
    const client = this.supabase.getClient();
    const table = entry.kind === 'parent' ? 'transactions' : 'transaction_items';
    const { error } = await client
      .from(table)
      .update({ settlement_id: settlementId })
      .eq('id', entry.id);
    if (error) throw error;
  }

  // userId here is the *author* of this settlement run (the caller). The
  // remainder row INHERITS the original's group ownership (user_id) and
  // reservation columns — only created_by reflects who split it.
  private async splitPartial(
    entry: ReservationEntry,
    settlementId: number,
    settledPortion: number,
    remainderAmount: number,
    createdBy: string,
  ): Promise<void> {
    const client = this.supabase.getClient();
    if (entry.kind === 'parent') {
      const tx = entry.parent;
      const { error: u } = await client
        .from('transactions')
        .update({ amount: settledPortion, settlement_id: settlementId })
        .eq('id', entry.id);
      if (u) throw u;
      const { error: i } = await client.from('transactions').insert({
        user_id: tx.user_id,
        created_by: createdBy,
        account_id: tx.account_id,
        category_id: tx.category_id ?? null,
        reserved_from_account_id: tx.reserved_from_account_id,
        parent_tx_id: entry.id,
        amount: remainderAmount,
        type: 'expense',
        date: tx.date,
        note: tx.note ?? null,
        sort_index: tx.sort_index,
      });
      if (i) throw i;
      return;
    }

    // Item-level partial split. Parent transaction is untouched — bank-statement
    // consistency: one cash event remains one row.
    const { data: itemRow, error: readErr } = await client
      .from('transaction_items')
      .select('*')
      .eq('id', entry.id)
      .single();
    if (readErr) throw readErr;
    const original = itemRow as TransactionItem;

    const { error: u } = await client
      .from('transaction_items')
      .update({ amount: settledPortion, settlement_id: settlementId })
      .eq('id', entry.id);
    if (u) throw u;

    const { error: i } = await client.from('transaction_items').insert({
      transaction_id: original.transaction_id,
      created_by: createdBy,
      category_id: original.category_id ?? null,
      amount: remainderAmount,
      note: original.note ?? null,
      position: original.position,
      reserved_from_account_id: original.reserved_from_account_id ?? null,
      parent_item_id: entry.id,
    });
    if (i) throw i;
  }

  // Records the real-money movement for a settlement and returns the owing-side
  // debit tx id (→ debt_settlements.transfer_tx_id). When `viaId` is a distinct
  // third account, routes owing→via→creditor as two transfer pairs so the
  // conduit's mutasi matches the bank (§7.4); otherwise a single owing→creditor
  // pair. Balance net is identical either way (the conduit nets zero).
  private async recordSettlementTransfers(params: {
    settlementId: number;
    owingId: number;
    owingOwner: string;
    creditorId: number;
    creditorOwner: string;
    viaId: number | null;
    amount: number;
    date: string;
    createdBy: string;
  }): Promise<number> {
    const baseSort = Date.now();
    const useVia =
      params.viaId != null &&
      params.viaId !== params.owingId &&
      params.viaId !== params.creditorId;

    if (!useVia) {
      return this.createTransferPair({
        settlementId: params.settlementId,
        fromId: params.owingId,
        fromOwner: params.owingOwner,
        toId: params.creditorId,
        toOwner: params.creditorOwner,
        amount: params.amount,
        date: params.date,
        createdBy: params.createdBy,
        sortIndex: baseSort,
      });
    }

    const viaId = params.viaId as number;
    const viaOwner = await this.resolveAccountOwner(viaId);
    // Leg 1: owing → via (owing-side debit; the settlement's anchor row).
    const leg1OutId = await this.createTransferPair({
      settlementId: params.settlementId,
      fromId: params.owingId,
      fromOwner: params.owingOwner,
      toId: viaId,
      toOwner: viaOwner,
      amount: params.amount,
      date: params.date,
      createdBy: params.createdBy,
      sortIndex: baseSort,
    });
    // Leg 2: via → creditor (lower sort so on the conduit it lands just above
    // leg 1's incoming row — newest-first reads "paid creditor" then "received").
    await this.createTransferPair({
      settlementId: params.settlementId,
      fromId: viaId,
      fromOwner: viaOwner,
      toId: params.creditorId,
      toOwner: params.creditorOwner,
      amount: params.amount,
      date: params.date,
      createdBy: params.createdBy,
      sortIndex: baseSort - 1,
    });
    return leg1OutId;
  }

  // One transfer = two paired rows (out debit / in credit) linked via
  // transfer_pair_id. Both rows are stamped with settlement_transfer_id so
  // reverseSettlement can delete every leg later (§7.4.3). Returns the out
  // (debit) row id.
  private async createTransferPair(params: {
    settlementId: number;
    fromId: number;
    fromOwner: string;
    toId: number;
    toOwner: string;
    amount: number;
    date: string;
    createdBy: string;
    sortIndex: number;
  }): Promise<number> {
    const client = this.supabase.getClient();
    const { data: outRow, error: outErr } = await client
      .from('transactions')
      .insert({
        user_id: params.fromOwner,
        created_by: params.createdBy,
        account_id: params.fromId,
        amount: params.amount,
        type: 'transfer',
        date: params.date,
        note: 'Debt settlement',
        settlement_transfer_id: params.settlementId,
        sort_index: params.sortIndex,
      })
      .select()
      .single();
    if (outErr) throw outErr;
    const outTx = outRow as Transaction;

    const { data: inRow, error: inErr } = await client
      .from('transactions')
      .insert({
        user_id: params.toOwner,
        created_by: params.createdBy,
        account_id: params.toId,
        amount: params.amount,
        type: 'transfer',
        date: params.date,
        note: 'Debt settlement',
        transfer_pair_id: outTx.id,
        settlement_transfer_id: params.settlementId,
        sort_index: params.sortIndex,
      })
      .select()
      .single();
    if (inErr) throw inErr;
    const inTx = inRow as Transaction;

    const { error: linkErr } = await client
      .from('transactions')
      .update({ transfer_pair_id: inTx.id })
      .eq('id', outTx.id);
    if (linkErr) throw linkErr;

    return outTx.id;
  }

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

  private async adjustBalance(accountId: number, delta: number): Promise<void> {
    if (delta === 0) return;
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('accounts')
      .select('balance')
      .eq('id', accountId)
      .single();
    if (error) throw error;
    const current = Number((data as { balance: number }).balance);
    const next = Number((current + delta).toFixed(2));
    const { error: writeErr } = await client
      .from('accounts')
      .update({ balance: next })
      .eq('id', accountId);
    if (writeErr) throw writeErr;
  }
}
