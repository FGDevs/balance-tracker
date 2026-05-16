import { Injectable, inject, signal } from '@angular/core';
import { Session, User } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';
import { Router } from '@angular/router';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private router = inject(Router);
  private supabase = inject(SupabaseService);

  readonly currentUser = signal<User | null>(null);
  readonly session = signal<Session | null>(null);

  constructor() {
    const client = this.supabase.getClient();
    client.auth.onAuthStateChange((event, session) => {
      this.session.set(session);
      this.currentUser.set(session?.user ?? null);

      if (event === 'SIGNED_IN' && this.router.url.startsWith('/login')) {
        this.router.navigate(['/dashboard']);
      } else if (event === 'SIGNED_OUT') {
        this.router.navigate(['/login']);
      }
    });
    this.bootstrapSession();
  }

  private async bootstrapSession(): Promise<void> {
    const { data, error } = await this.supabase.getClient().auth.getSession();
    if (error) throw error;
    this.session.set(data.session);
    this.currentUser.set(data.session?.user ?? null);
  }

  async signIn(email: string, password: string): Promise<void> {
    const { data, error } = await this.supabase
      .getClient()
      .auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async signUp(email: string, password: string, name: string): Promise<void> {
    const { error } = await this.supabase.getClient().auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    const { error } = await this.supabase.getClient().auth.signOut();
    if (error) throw error;
  }
}
