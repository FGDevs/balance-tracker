import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDragHandle,
  CdkDropList,
} from '@angular/cdk/drag-drop';
import {
  IonContent,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonRefresher,
  IonRefresherContent,
  InfiniteScrollCustomEvent,
  RefresherCustomEvent,
} from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { TransactionService } from '../../../core/services/transaction.service';
import { Transaction } from '../../../core/models';
import { CurrencyFormatPipe } from '../../../shared/pipes/currency-format.pipe';

interface DateGroup {
  date: string;
  label: string;
  items: Transaction[];
}

@Component({
  selector: 'app-transaction-list',
  standalone: true,
  imports: [
    CurrencyFormatPipe,
    CdkDrag,
    CdkDragHandle,
    CdkDropList,
    IonContent,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonRefresher,
    IonRefresherContent,
  ],
  templateUrl: './transaction-list.page.html',
})
export class TransactionListPage {
  private readonly transactionService = inject(TransactionService);
  private readonly router = inject(Router);

  readonly loading = signal(false);
  readonly transactions = signal<Transaction[]>([]);
  readonly page = signal(0);
  readonly hasMore = signal(true);
  readonly errorMessage = signal<string | null>(null);

  private readonly _expandedIds = signal<ReadonlySet<number>>(new Set());
  readonly expandedIds = this._expandedIds.asReadonly();

  readonly reorderMode = signal(false);
  readonly originalSnapshot = signal<Transaction[] | null>(null);
  readonly saving = signal(false);

  readonly isDirty = computed(() => {
    const orig = this.originalSnapshot();
    if (!orig) return false;
    const curr = this.transactions();
    if (orig.length !== curr.length) return true;
    return orig.some((t, i) => t.id !== curr[i]?.id);
  });

  readonly groupedTransactions = computed<DateGroup[]>(() => {
    const groups: DateGroup[] = [];
    let current: DateGroup | null = null;
    for (const tx of this.transactions()) {
      if (!current || current.date !== tx.date) {
        current = { date: tx.date, label: this.formatGroupDate(tx.date), items: [] };
        groups.push(current);
      }
      current.items.push(tx);
    }
    return groups;
  });

  readonly editionLabel = computed(() => {
    const d = new Date();
    const date = new Intl.DateTimeFormat('id-ID', {
      day: '2-digit',
      month: '2-digit',
    }).format(d);
    const day = new Intl.DateTimeFormat('id-ID', { weekday: 'long' })
      .format(d)
      .toUpperCase();
    return `Edisi ${date} · ${day}`;
  });

  constructor() {
    void this.loadFirstPage();
  }

  ionViewWillEnter(): void {
    void this.loadFirstPage();
  }

  async onRefresh(event: RefresherCustomEvent): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    try {
      await this.loadFirstPage();
    } finally {
      event.target.complete();
    }
  }

  async onInfinite(event: InfiniteScrollCustomEvent): Promise<void> {
    try {
      const next = this.page() + 1;
      const rows = await this.transactionService.getAll(next);
      this.transactions.update((curr) => [...curr, ...rows]);
      this.page.set(next);
      this.hasMore.set(rows.length === TransactionService.PAGE_SIZE);
    } finally {
      await event.target.complete();
    }
  }

  async onRowClick(id: number): Promise<void> {
    if (this.reorderMode()) return; // chevrons own taps in reorder mode
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/transactions', id, 'edit']);
  }

  async onImportClick(): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/transactions/import']);
  }

  enterReorderMode(): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    this._expandedIds.set(new Set()); // collapse rincian panels
    this.originalSnapshot.set(this.transactions());
    this.reorderMode.set(true);
  }

  cancelReorder(): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    const snap = this.originalSnapshot();
    if (snap) this.transactions.set(snap);
    this.originalSnapshot.set(null);
    this.reorderMode.set(false);
  }

  async saveReorder(): Promise<void> {
    if (this.saving()) return;
    if (!this.isDirty()) {
      this.cancelReorder();
      return;
    }
    this.saving.set(true);
    this.errorMessage.set(null);
    await Haptics.impact({ style: ImpactStyle.Medium });
    try {
      const updates = this.computeSortUpdates();
      await this.transactionService.setSortIndices(updates);
      this.originalSnapshot.set(null);
      this.reorderMode.set(false);
      await this.loadFirstPage();
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menyimpan urutan',
      );
    } finally {
      this.saving.set(false);
    }
  }

  // For each date group in the current order, reuse the existing sort_index
  // values (sorted descending) as the slot pool and assign them to rows in
  // their new positions. Only emits updates for rows whose sort_index changed.
  private computeSortUpdates(): { id: number; sort_index: number }[] {
    const updates: { id: number; sort_index: number }[] = [];
    const byDate = new Map<string, Transaction[]>();
    for (const tx of this.transactions()) {
      const arr = byDate.get(tx.date) ?? [];
      arr.push(tx);
      byDate.set(tx.date, arr);
    }
    for (const rows of byDate.values()) {
      const slots = rows
        .map((r) => r.sort_index ?? 0)
        .sort((a, b) => b - a);
      rows.forEach((row, i) => {
        const next = slots[i];
        if (next !== (row.sort_index ?? 0)) {
          updates.push({ id: row.id, sort_index: next });
        }
      });
    }
    return updates;
  }

  onDrop(event: CdkDragDrop<Transaction[]>, date: string): void {
    if (event.previousIndex === event.currentIndex) return;
    void Haptics.impact({ style: ImpactStyle.Light });
    this.transactions.update((list) => {
      const next = [...list];
      const flatIndices: number[] = [];
      for (let i = 0; i < next.length; i++) {
        if (next[i].date === date) flatIndices.push(i);
      }
      const fromFlat = flatIndices[event.previousIndex];
      const toFlat = flatIndices[event.currentIndex];
      if (fromFlat == null || toFlat == null) return list;
      const [moved] = next.splice(fromFlat, 1);
      next.splice(toFlat, 0, moved);
      return next;
    });
  }

  toggleExpand(id: number, event: Event): void {
    event.stopPropagation();
    void Haptics.impact({ style: ImpactStyle.Light });
    const next = new Set(this._expandedIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this._expandedIds.set(next);
  }

  isSplit(tx: Transaction): boolean {
    return !!tx.items && tx.items.length > 0;
  }

  isExpanded(id: number): boolean {
    return this._expandedIds().has(id);
  }

  signFor(tx: Transaction): string {
    if (tx.type === 'income') return '+';
    if (tx.type === 'expense') return '−';
    return this.isTransferIncoming(tx) ? '+' : '−';
  }

  amountToneClass(tx: Transaction): string {
    if (tx.type === 'income') return 'text-chip-green-ink';
    if (tx.type === 'expense') return 'text-chip-coral-ink';
    return this.isTransferIncoming(tx)
      ? 'text-chip-sky-ink'
      : 'text-ink-soft';
  }

  labelFor(tx: Transaction): string {
    if (tx.type === 'transfer') return 'Transfer';
    if (tx.type === 'income') return 'Pemasukan';
    return 'Pengeluaran';
  }

  isTransferIncoming(tx: Transaction): boolean {
    return (
      tx.type === 'transfer' &&
      tx.transfer_pair_id !== undefined &&
      tx.transfer_pair_id !== null &&
      tx.transfer_pair_id < tx.id
    );
  }

  private formatGroupDate(date: string): string {
    const d = new Date(date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round(
      (today.getTime() - d.getTime()) / 86_400_000,
    );
    if (diffDays === 0) return 'Hari ini';
    if (diffDays === 1) return 'Kemarin';
    const weekday = new Intl.DateTimeFormat('id-ID', { weekday: 'long' }).format(d);
    const full = new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d);
    return `${weekday} · ${full}`;
  }

  private async loadFirstPage(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.page.set(0);
    try {
      const rows = await this.transactionService.getAll(0);
      this.transactions.set(rows);
      this.hasMore.set(rows.length === TransactionService.PAGE_SIZE);
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal memuat transaksi',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
