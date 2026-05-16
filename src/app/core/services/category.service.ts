import { Injectable, inject, signal } from '@angular/core';
import { Category, CategoryType } from '../models';
import { AuthService } from './auth.service';
import { SupabaseService } from './supabase.service';

@Injectable({ providedIn: 'root' })
export class CategoryService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  readonly categories = signal<Category[]>([]);

  async loadCategories(): Promise<void> {
    const { data, error } = await this.supabase
      .getClient()
      .from('categories')
      .select('*')
      .order('type', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    this.categories.set((data ?? []) as Category[]);
  }

  getByType(type: CategoryType): Category[] {
    return this.categories().filter((c) => c.type === type);
  }

  async create(data: Omit<Category, 'id' | 'user_id'>): Promise<Category> {
    const userId = this.auth.currentUser()?.id;
    if (!userId) throw new Error('Not authenticated');

    const { data: row, error } = await this.supabase
      .getClient()
      .from('categories')
      .insert({ ...data, user_id: userId })
      .select()
      .single();
    if (error) throw error;

    const created = row as Category;
    this.categories.update((list) =>
      [...list, created].sort(
        (a, b) =>
          a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
      ),
    );
    return created;
  }

  async update(id: number, data: Partial<Category>): Promise<Category> {
    const { data: row, error } = await this.supabase
      .getClient()
      .from('categories')
      .update(data)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    const updated = row as Category;
    this.categories.update((list) =>
      list
        .map((c) => (c.id === id ? updated : c))
        .sort(
          (a, b) =>
            a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
        ),
    );
    return updated;
  }

  async delete(id: number): Promise<void> {
    const { error } = await this.supabase
      .getClient()
      .from('categories')
      .delete()
      .eq('id', id);
    if (error) throw error;
    this.categories.update((list) => list.filter((c) => c.id !== id));
  }
}
