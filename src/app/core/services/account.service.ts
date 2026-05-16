import { Injectable, inject, signal } from '@angular/core';
import { Account, AccountBalance } from '../models';
import { SupabaseService } from './supabase.service';

@Injectable({ providedIn: 'root' })
export class AccountService {
  private supabase = inject(SupabaseService);

  readonly accounts = signal<AccountBalance[]>([]);

  readonly allAccounts = signal<AccountBalance[]>([]);

  async loadAccounts(): Promise<void> {
    const { data, error } = await this.supabase
      .getClient()
      .from('account_balances')
      .select('*')
      .neq('type', 'credit')
      .order('created_at', { ascending: true });
    if (error) throw error;
    this.accounts.set((data ?? []) as AccountBalance[]);
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
    data: Omit<Account, 'id' | 'user_id' | 'created_at'>,
  ): Promise<Account> {
    const { data: row, error } = await this.supabase
      .getClient()
      .from('accounts')
      .insert(data)
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
