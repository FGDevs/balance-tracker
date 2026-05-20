import { Injectable, inject, signal } from '@angular/core';
import { Account, AccountBalance } from '../models';
import { AuthService } from './auth.service';
import { SupabaseService } from './supabase.service';
import { ViewerScopeService } from './viewer-scope.service';

@Injectable({ providedIn: 'root' })
export class AccountService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private viewerScope = inject(ViewerScopeService);

  readonly accounts = signal<AccountBalance[]>([]);

  readonly allAccounts = signal<AccountBalance[]>([]);

  // §13.6 — loadAccounts honors the Saya/Lain/Semua filter via created_by.
  // loadAllAccounts (used by form pickers) intentionally does NOT, so users
  // can always record on every visible account regardless of scope.
  async loadAccounts(): Promise<void> {
    let q = this.supabase
      .getClient()
      .from('account_balances')
      .select('*')
      .neq('type', 'credit')
      .order('created_at', { ascending: true });
    q = this.applyScope(q);
    const { data, error } = await q;
    if (error) throw error;
    this.accounts.set((data ?? []) as AccountBalance[]);
  }

  // Generic scope application — push-down to Postgres so pagination stays
  // correct (filter happens before LIMIT). Returns the same query builder.
  private applyScope<T extends { eq: Function; neq: Function }>(q: T): T {
    const scope = this.viewerScope.scope();
    const uid = this.auth.currentUser()?.id;
    if (!uid || scope === 'all') return q;
    if (scope === 'mine') return q.eq('created_by', uid);
    return q.neq('created_by', uid);
  }

  async loadAllAccounts(): Promise<void> {
    const { data, error } = await this.supabase
      .getClient()
      .from('account_balances')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;
    this.allAccounts.set((data ?? []) as AccountBalance[]);
  }

  getById(id: number): AccountBalance | undefined {
    return this.accounts().find((a) => a.id === id);
  }

  async create(
    data: Omit<Account, 'id' | 'user_id' | 'created_by' | 'created_at'>,
  ): Promise<Account> {
    const userId = this.auth.currentUser()?.id;
    if (!userId) throw new Error('Not authenticated');
    const { data: row, error } = await this.supabase
      .getClient()
      .from('accounts')
      .insert({ ...data, user_id: userId, created_by: userId })
      .select()
      .single();
    if (error) throw error;
    return row as Account;
  }

  async update(id: number, data: Partial<Account>): Promise<Account> {
    const { data: row, error } = await this.supabase
      .getClient()
      .from('accounts')
      .update(data)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return row as Account;
  }

  async softDelete(id: number): Promise<void> {
    const { error } = await this.supabase
      .getClient()
      .from('accounts')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }
}
