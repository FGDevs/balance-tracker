import { Injectable, signal } from '@angular/core';

// User preference: whether savings accounts contribute to the Dashboard's
// `Saldo` total / debt chip / account grid, and to the "Semua akun" totals on
// Statistik. Defaults to true (existing behavior). Persisted to localStorage so
// the choice survives reloads.

const STORAGE_KEY = 'bt:include-savings';

function readPersisted(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === '0' || raw === 'false') return false;
  } catch {
    // localStorage may be unavailable (SSR, private mode). Fall through.
  }
  return true;
}

@Injectable({ providedIn: 'root' })
export class SavingsVisibilityService {
  readonly include = signal<boolean>(readPersisted());

  set(next: boolean): void {
    this.include.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      // ignore — non-persistence is acceptable
    }
  }

  toggle(): void {
    this.set(!this.include());
  }
}
