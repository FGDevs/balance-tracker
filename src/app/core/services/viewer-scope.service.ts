import { Injectable, signal } from '@angular/core';
import { ViewerScope } from '../models';

// CLAUDE.md §13.6 — single source of truth for the "Saya / Lain / Semua"
// author filter on Dashboard, Transactions list, Calculator. Defaults to
// 'all' and is persisted to localStorage so the choice survives reloads.

const STORAGE_KEY = 'viewerScope';
const VALID: ReadonlySet<ViewerScope> = new Set<ViewerScope>([
  'mine',
  'others',
  'all',
]);

function readPersisted(): ViewerScope {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && VALID.has(raw as ViewerScope)) return raw as ViewerScope;
  } catch {
    // localStorage may be unavailable (SSR, private mode). Fall through.
  }
  return 'all';
}

@Injectable({ providedIn: 'root' })
export class ViewerScopeService {
  readonly scope = signal<ViewerScope>(readPersisted());

  set(next: ViewerScope): void {
    if (!VALID.has(next)) return;
    this.scope.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — non-persistence is acceptable
    }
  }
}
