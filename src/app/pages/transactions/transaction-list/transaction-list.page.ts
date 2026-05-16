import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
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
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/transactions', id, 'edit']);
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
