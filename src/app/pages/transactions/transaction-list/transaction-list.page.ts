import { Component, computed, effect, inject, signal } from '@angular/core';
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
import { AuthService } from '../../../core/services/auth.service';
import { GroupService } from '../../../core/services/group.service';
import { TransactionService } from '../../../core/services/transaction.service';
import { ViewerScopeService } from '../../../core/services/viewer-scope.service';
import { Transaction, ViewerScope } from '../../../core/models';
import { CurrencyFormatPipe } from '../../../shared/pipes/currency-format.pipe';

interface DateGroup {
  date: string;
  label: string;
  items: Transaction[];
}

interface CalendarCell {
  iso: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
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
  private readonly auth = inject(AuthService);
  private readonly groups = inject(GroupService);
  private readonly viewerScope = inject(ViewerScopeService);

  readonly scope = this.viewerScope.scope;

  readonly scopeOptions: { value: ViewerScope; label: string }[] = [
    { value: 'all', label: 'Semua' },
    { value: 'mine', label: 'Saya' },
    { value: 'others', label: 'Lain' },
  ];

  // Foreign-author name for a row. Null when tx was created by the current
  // user (annotation hidden) or when the creator's profile isn't loaded yet.
  authorNameOf(tx: Transaction): string | null {
    const me = this.auth.currentUser()?.id;
    if (!me || tx.created_by === me) return null;
    return this.groups.nameFor(tx.created_by);
  }

  setScope(next: ViewerScope): void {
    if (this.scope() === next) return;
    this.viewerScope.set(next);
  }

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

  // ── Calendar state ──────────────────────────────────────────────────────
  private readonly today = this.localIsoToday();
  readonly selectedDate = signal<string | null>(this.today);
  readonly viewedMonth = signal<{ year: number; month: number }>(
    this.parseMonth(this.today),
  );
  readonly monthDots = signal<ReadonlySet<string>>(new Set());
  readonly pickerOpen = signal(false);
  readonly pickerYear = signal<number>(this.parseMonth(this.today).year);

  readonly weekdays = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
  readonly monthShortNames = Array.from({ length: 12 }, (_, i) =>
    new Intl.DateTimeFormat('id-ID', { month: 'short' }).format(
      new Date(2000, i, 1),
    ),
  );

  readonly monthLabel = computed(() => {
    const { year, month } = this.viewedMonth();
    return new Intl.DateTimeFormat('id-ID', {
      month: 'long',
      year: 'numeric',
    }).format(new Date(year, month, 1));
  });

  readonly calendarCells = computed<CalendarCell[]>(() => {
    const { year, month } = this.viewedMonth();
    const first = new Date(year, month, 1);
    const dowMon0 = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - dowMon0);
    const todayIso = this.today;
    const cells: CalendarCell[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = this.toIso(d);
      cells.push({
        iso,
        day: d.getDate(),
        inMonth: d.getMonth() === month,
        isToday: iso === todayIso,
      });
    }
    return cells;
  });

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
    void this.reloadList();
    void this.reloadDots();
    // Reload list on scope or selected-date change. Skip first run — constructor
    // already kicked it off.
    let firstListRun = true;
    effect(() => {
      this.scope();
      this.selectedDate();
      if (firstListRun) {
        firstListRun = false;
        return;
      }
      void this.reloadList();
    });
    // Reload dots on scope or viewed-month change. Skip first run.
    let firstDotsRun = true;
    effect(() => {
      this.scope();
      this.viewedMonth();
      if (firstDotsRun) {
        firstDotsRun = false;
        return;
      }
      void this.reloadDots();
    });
  }

  ionViewWillEnter(): void {
    void this.reloadList();
    void this.reloadDots();
  }

  async onRefresh(event: RefresherCustomEvent): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    try {
      await Promise.all([this.reloadList(), this.reloadDots()]);
    } finally {
      event.target.complete();
    }
  }

  async onInfinite(event: InfiniteScrollCustomEvent): Promise<void> {
    try {
      // Date-filtered view is bounded — no pagination.
      if (this.selectedDate()) {
        this.hasMore.set(false);
        return;
      }
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

  // ── Calendar interactions ───────────────────────────────────────────────
  prevMonth(): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    this.viewedMonth.update(({ year, month }) => {
      const d = new Date(year, month - 1, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  nextMonth(): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    this.viewedMonth.update(({ year, month }) => {
      const d = new Date(year, month + 1, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  togglePicker(): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    if (!this.pickerOpen()) {
      this.pickerYear.set(this.viewedMonth().year);
    }
    this.pickerOpen.update((v) => !v);
  }

  prevYear(): void {
    this.pickerYear.update((y) => y - 1);
  }

  nextYear(): void {
    this.pickerYear.update((y) => y + 1);
  }

  pickMonth(month: number): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    this.viewedMonth.set({ year: this.pickerYear(), month });
    this.pickerOpen.set(false);
  }

  async selectDate(cell: CalendarCell): Promise<void> {
    if (!cell.inMonth) return;
    if (this.selectedDate() === cell.iso) return;
    await Haptics.impact({ style: ImpactStyle.Light });
    this.selectedDate.set(cell.iso);
  }

  async clearSelection(): Promise<void> {
    if (this.selectedDate() === null) return;
    await Haptics.impact({ style: ImpactStyle.Light });
    this.selectedDate.set(null);
  }

  cellClasses(cell: CalendarCell): string {
    const base =
      'relative flex items-center justify-center w-full aspect-square text-xs tabular-nums rounded-full transition';
    if (!cell.inMonth) {
      return `${base} text-ink-muted/30`;
    }
    const isSelected = this.selectedDate() === cell.iso;
    if (isSelected) {
      return `${base} bg-accent text-on-dark font-semibold`;
    }
    if (cell.isToday) {
      return `${base} text-ink ring-1 ring-accent-warm`;
    }
    return `${base} text-ink hover:bg-app active:scale-95`;
  }

  hasDot(cell: CalendarCell): boolean {
    return cell.inMonth && this.monthDots().has(cell.iso);
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
      await this.reloadList();
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

  private async reloadList(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.page.set(0);
    try {
      const date = this.selectedDate();
      if (date) {
        const rows = await this.transactionService.getByDate(date);
        this.transactions.set(rows);
        this.hasMore.set(false);
      } else {
        const rows = await this.transactionService.getAll(0);
        this.transactions.set(rows);
        this.hasMore.set(rows.length === TransactionService.PAGE_SIZE);
      }
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal memuat transaksi',
      );
    } finally {
      this.loading.set(false);
    }
  }

  private async reloadDots(): Promise<void> {
    try {
      const { year, month } = this.viewedMonth();
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;
      const set = await this.transactionService.getTransactionDatesForMonth(key);
      this.monthDots.set(set);
    } catch {
      // Dots are decorative — swallow load errors so the page still renders.
      this.monthDots.set(new Set());
    }
  }

  private localIsoToday(): string {
    return this.toIso(new Date());
  }

  private toIso(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private parseMonth(iso: string): { year: number; month: number } {
    const [y, m] = iso.split('-').map(Number);
    return { year: y, month: m - 1 };
  }
}
