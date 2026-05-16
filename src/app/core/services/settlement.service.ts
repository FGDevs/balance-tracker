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
  }): Promise<DebtSettlement> {
    if (params.payerAccountId === params.reservedFromAccountId) {
      throw new Error('Payer and owing account must differ');
    }
    if (!Number.isFinite(params.paymentAmount) || params.paymentAmount <= 0) {
      throw new Error('Payment amount must be greater than zero');
    }
    const userId = this.auth.currentUser()?.id;
    if (!userId) throw new Error('Not authenticated');
    const client = this.supabase.getClient();

    const { data: sRow, error: sErr } = await client
      .from('debt_settlements')
      .insert({
        account_id: params.payerAccountId,
        reserved_from_account_id: params.reservedFromAccountId,
        total_amount: params.paymentAmount,
      })
      .select()
      .single();
    if (sErr) throw sErr;
    const settlement = sRow as DebtSettlement;

    // Real-money transfer: owing → lender. Two paired transfer rows (out / in).
    const { data: outRow, error: outErr } = await client
      .from('transactions')
      .insert({
        user_id: userId,
        account_id: params.reservedFromAccountId,
        amount: params.paymentAmount,
        type: 'transfer',
        date: params.paymentDate,
        note: 'Debt settlement',
      })
      .select()
      .single();
    if (outErr) throw outErr;
    const outTx = outRow as Transaction;

    const { data: inRow, error: inErr } = await client
      .from('transactions')
      .insert({
        user_id: userId,
        account_id: params.payerAccountId,
        amount: params.paymentAmount,
        type: 'transfer',
        date: params.paymentDate,
        note: 'Debt settlement',
        transfer_pair_id: outTx.id,
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

    const { error: tErr } = await client
      .from('debt_settlements')
      .update({ transfer_tx_id: outTx.id })
      .eq('id', settlement.id);
    if (tErr) throw tErr;

    // Move the real money — this is the only balance mutation in settle().
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
        await this.splitPartial(entry, settlement.id, settledPortion, remainderAmount, userId);
        remaining = 0;
      }
    }

    return { ...settlement, transfer_tx_id: outTx.id };
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

  private async splitPartial(
    entry: ReservationEntry,
    settlementId: number,
    settledPortion: number,
    remainderAmount: number,
    userId: string,
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
        user_id: userId,
        account_id: tx.account_id,
        category_id: tx.category_id ?? null,
        reserved_from_account_id: tx.reserved_from_account_id,
        parent_tx_id: entry.id,
        amount: remainderAmount,
        type: 'expense',
        date: tx.date,
        note: tx.note ?? null,
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
      category_id: original.category_id ?? null,
      amount: remainderAmount,
      note: original.note ?? null,
      position: original.position,
      reserved_from_account_id: original.reserved_from_account_id ?? null,
      parent_item_id: entry.id,
    });
    if (i) throw i;
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
