import { Component, computed, effect, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { IonContent } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { AccountService } from '../../core/services/account.service';
import { TransactionService } from '../../core/services/transaction.service';
import { ViewerScopeService } from '../../core/services/viewer-scope.service';
import { Transaction, ViewerScope } from '../../core/models';
import { CurrencyFormatPipe } from '../../shared/pipes/currency-format.pipe';

type DatePreset = 'this-month' | 'last-month' | 'last-30' | 'custom';

interface PresetDef {
  value: DatePreset;
  label: string;
}

const PRESETS: PresetDef[] = [
  { value: 'this-month', label: 'Bulan ini' },
  { value: 'last-month', label: 'Bulan lalu' },
  { value: 'last-30', label: '30 hari' },
  { value: 'custom', label: 'Custom' },
];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function presetRange(preset: DatePreset, today = new Date()): {
  from: string;
  to: string;
} {
  const t = new Date(today);
  const yyyy = t.getFullYear();
  const mm = t.getMonth();
  switch (preset) {
    case 'this-month': {
      const from = new Date(yyyy, mm, 1);
      const to = new Date(yyyy, mm + 1, 0);
      return { from: ymd(from), to: ymd(to) };
    }
    case 'last-month': {
      const from = new Date(yyyy, mm - 1, 1);
      const to = new Date(yyyy, mm, 0);
      return { from: ymd(from), to: ymd(to) };
    }
    case 'last-30': {
      const to = new Date(t);
      const from = new Date(t);
      from.setDate(from.getDate() - 29);
      return { from: ymd(from), to: ymd(to) };
    }
    case 'custom':
      return { from: ymd(t), to: ymd(t) };
  }
}

@Component({
  selector: 'app-calculator',
  standalone: true,
  imports: [IonContent, CurrencyFormatPipe],
  templateUrl: './calculator.page.html',
})
export class CalculatorPage {
  private readonly accountService = inject(AccountService);
  private readonly transactionService = inject(TransactionService);
  private readonly viewerScope = inject(ViewerScopeService);
  private readonly location = inject(Location);

  readonly presets = PRESETS;

  readonly scope = this.viewerScope.scope;

  readonly scopeOptions: { value: ViewerScope; label: string }[] = [
    { value: 'all', label: 'Semua' },
    { value: 'mine', label: 'Saya' },
    { value: 'others', label: 'Lain' },
  ];

  readonly accounts = computed(() => this.accountService.allAccounts());

  readonly accountFilter = signal<'all' | number[]>('all');
  readonly datePreset = signal<DatePreset>('this-month');

  private readonly initialRange = presetRange('this-month');
  readonly dateFrom = signal<string>(this.initialRange.from);
  readonly dateTo = signal<string>(this.initialRange.to);

  readonly transactions = signal<Transaction[]>([]);
  readonly selectedIds = signal<Set<number>>(new Set());
  readonly loading = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);
  readonly capReached = computed(
    () => this.transactions().length >= TransactionService.CALCULATOR_CAP,
  );

  readonly currency = computed(
    () => this.accounts()[0]?.currency_code ?? 'IDR',
  );

  readonly selectedTxs = computed(() => {
    const sel = this.selectedIds();
    return this.transactions().filter((t) => sel.has(t.id));
  });

  // Direction of money for THIS row from the account's perspective:
  //   income / incoming-transfer → "in"  (counts as Masuk, +)
  //   expense / outgoing-transfer → "out" (counts as Keluar, −)
  // Transfer side identified by transfer_pair_id < id (out row inserted first,
  // so the in row gets the higher id), matching the Transaction List renderer.
  isIncoming(tx: Transaction): boolean {
    if (tx.type === 'income') return true;
    if (tx.type === 'transfer') {
      return (
        tx.transfer_pair_id != null && tx.transfer_pair_id < tx.id
      );
    }
    return false;
  }

  readonly totalIncome = computed(() =>
    this.selectedTxs()
      .filter((t) => this.isIncoming(t))
      .reduce((sum, t) => sum + t.amount, 0),
  );

  readonly totalExpense = computed(() =>
    this.selectedTxs()
      .filter((t) => !this.isIncoming(t))
      .reduce((sum, t) => sum + t.amount, 0),
  );

  readonly net = computed(() => this.totalIncome() - this.totalExpense());

  readonly netSign = computed<'pos' | 'neg' | 'zero'>(() => {
    const n = this.net();
    if (n > 0) return 'pos';
    if (n < 0) return 'neg';
    return 'zero';
  });

  readonly allVisibleSelected = computed(() => {
    const txs = this.transactions();
    if (txs.length === 0) return false;
    const sel = this.selectedIds();
    return txs.every((t) => sel.has(t.id));
  });

  constructor() {
    void this.bootstrap();
    // §13.6 — scope changes count as a filter change: clear the selection
    // (consistent with date/account changes) and refetch.
    let firstScopeRun = true;
    effect(() => {
      const _ = this.scope();
      if (firstScopeRun) {
        firstScopeRun = false;
        return;
      }
      this.clearSelection();
      void this.fetch();
    });
  }

  async setScope(next: ViewerScope): Promise<void> {
    if (this.scope() === next) return;
    await Haptics.impact({ style: ImpactStyle.Light });
    this.viewerScope.set(next);
  }

  private async bootstrap(): Promise<void> {
    if (this.accounts().length === 0) {
      try {
        await this.accountService.loadAllAccounts();
      } catch {
        // surfaced as part of the fetch below if it fails
      }
    }
    await this.fetch();
  }

  goBack(): void {
    this.location.back();
  }

  // ── Account filter ──────────────────────────────────────────────────────

  isAllAccounts(): boolean {
    return this.accountFilter() === 'all';
  }

  isAccountSelected(id: number): boolean {
    const f = this.accountFilter();
    return f !== 'all' && f.includes(id);
  }

  async pickAllAccounts(): Promise<void> {
    if (this.isAllAccounts()) return;
    await Haptics.impact({ style: ImpactStyle.Light });
    this.accountFilter.set('all');
    this.clearSelection();
    await this.fetch();
  }

  async toggleAccount(id: number): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    const current = this.accountFilter();
    let next: number[];
    if (current === 'all') {
      next = [id];
    } else if (current.includes(id)) {
      next = current.filter((x) => x !== id);
    } else {
      next = [...current, id];
    }
    this.accountFilter.set(next.length === 0 ? 'all' : next);
    this.clearSelection();
    await this.fetch();
  }

  // ── Date filter ─────────────────────────────────────────────────────────

  async pickPreset(p: DatePreset): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.datePreset.set(p);
    if (p !== 'custom') {
      const r = presetRange(p);
      this.dateFrom.set(r.from);
      this.dateTo.set(r.to);
    }
    this.clearSelection();
    await this.fetch();
  }

  async onDateFromChange(value: string): Promise<void> {
    if (!value) return;
    this.dateFrom.set(value);
    this.clearSelection();
    await this.fetch();
  }

  async onDateToChange(value: string): Promise<void> {
    if (!value) return;
    this.dateTo.set(value);
    this.clearSelection();
    await this.fetch();
  }

  // ── Selection ────────────────────────────────────────────────────────────

  isSelected(id: number): boolean {
    return this.selectedIds().has(id);
  }

  toggleRow(id: number): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    this.selectedIds.update((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  toggleSelectAll(): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    if (this.allVisibleSelected()) {
      this.selectedIds.set(new Set());
    } else {
      this.selectedIds.set(new Set(this.transactions().map((t) => t.id)));
    }
  }

  async clearAllSelection(): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.selectedIds.set(new Set());
  }

  private clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  // ── Fetching ─────────────────────────────────────────────────────────────

  private async fetch(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const rows = await this.transactionService.getForCalculator({
        accountIds: this.accountFilter(),
        dateFrom: this.dateFrom(),
        dateTo: this.dateTo(),
      });
      this.transactions.set(rows);
    } catch (err) {
      this.transactions.set([]);
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal memuat transaksi',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
