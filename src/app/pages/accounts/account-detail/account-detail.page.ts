import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Location } from '@angular/common';
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
  IonModal,
  IonRefresher,
  IonRefresherContent,
} from '@ionic/angular/standalone';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { AccountService } from '../../../core/services/account.service';
import { AuthService } from '../../../core/services/auth.service';
import { GroupService } from '../../../core/services/group.service';
import { SettlementService } from '../../../core/services/settlement.service';
import { TransactionService } from '../../../core/services/transaction.service';
import { AccountType, ReservationEntry, Transaction } from '../../../core/models';
import { CurrencyFormatPipe } from '../../../shared/pipes/currency-format.pipe';

const TYPE_LABEL: Record<AccountType, string> = {
  cash: 'Tunai',
  bank: 'Bank',
  credit: 'Kartu Kredit',
  savings: 'Tabungan',
};

type MutasiFilter = 'all' | 'non-reserved' | 'reserved';

interface DateGroup {
  date: string;
  label: string;
  items: Transaction[];
}

@Component({
  selector: 'app-account-detail',
  standalone: true,
  imports: [
    CdkDrag,
    CdkDragHandle,
    CdkDropList,
    IonContent,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonModal,
    IonRefresher,
    IonRefresherContent,
    CurrencyFormatPipe,
  ],
  templateUrl: './account-detail.page.html',
})
export class AccountDetailPage {
  private readonly accountService = inject(AccountService);
  private readonly transactionService = inject(TransactionService);
  private readonly settlementService = inject(SettlementService);
  private readonly auth = inject(AuthService);
  private readonly groups = inject(GroupService);
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  readonly id = input.required<string>();
  readonly accountId = computed(() => Number(this.id()));

  readonly loading = signal(false);
  readonly txLoading = signal(false);
  readonly unsettledLoading = signal(false);
  readonly reservationsOpen = signal(false);
  readonly deleting = signal(false);
  readonly showDeleteConfirm = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly transactions = signal<Transaction[]>([]);
  readonly unsettled = signal<ReservationEntry[]>([]);
  readonly page = signal(0);
  readonly hasMore = signal(true);
  readonly mutasiFilter = signal<MutasiFilter>('all');
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

  readonly hasAnyReserved = computed(() =>
    this.transactions().some((tx) => tx.reserved_from_account_id != null),
  );

  readonly filteredTransactions = computed(() => {
    const f = this.mutasiFilter();
    const rows = this.transactions();
    if (f === 'all') return rows;
    if (f === 'reserved')
      return rows.filter((tx) => tx.reserved_from_account_id != null);
    return rows.filter((tx) => tx.reserved_from_account_id == null);
  });

  readonly groupedTransactions = computed<DateGroup[]>(() => {
    const groups: DateGroup[] = [];
    let current: DateGroup | null = null;
    for (const tx of this.filteredTransactions()) {
      if (!current || current.date !== tx.date) {
        current = {
          date: tx.date,
          label: this.formatGroupDate(tx.date),
          items: [],
        };
        groups.push(current);
      }
      current.items.push(tx);
    }
    return groups;
  });

  readonly account = computed(() => {
    const id = this.accountId();
    return (
      this.accountService.allAccounts().find((a) => a.id === id) ??
      this.accountService.accounts().find((a) => a.id === id)
    );
  });

  readonly typeLabel = computed(() => {
    const a = this.account();
    return a ? TYPE_LABEL[a.type] : '';
  });

  // §13 — foreign-owner chip. When this account belongs to a group host
  // (not the current user), surface the host's display name. Null otherwise.
  readonly foreignOwnerName = computed(() => {
    const a = this.account();
    const me = this.auth.currentUser()?.id;
    if (!a || !me || a.user_id === me) return null;
    return this.groups.nameFor(a.user_id);
  });

  // Author chip for a tx row. Null when current user is the author (so the
  // chip is hidden on own rows). Used by the mutasi list.
  authorNameOf(tx: Transaction): string | null {
    const me = this.auth.currentUser()?.id;
    if (!me || tx.created_by === me) return null;
    return this.groups.nameFor(tx.created_by);
  }

  // Hutang chip — non-credit accounts only. Credit cards surface debt via
  // their negative `balance`, so the chip would duplicate.
  readonly debtAmount = computed(() => {
    const a = this.account();
    if (!a || a.type === 'credit') return 0;
    return a.total_reserved > 0 ? a.total_reserved : 0;
  });

  // Saldo shortfall — positive when this non-credit account's balance can't
  // cover its total_reserved debt. Surfaces how much top-up is needed.
  readonly shortfallAmount = computed(() => {
    const a = this.account();
    if (!a || a.type === 'credit') return 0;
    const gap = a.total_reserved - a.balance;
    return gap > 0 ? gap : 0;
  });

  readonly shortfallPopoverOpen = signal(false);

  toggleShortfallPopover(event: Event): void {
    event.stopPropagation();
    this.shortfallPopoverOpen.update((v) => !v);
  }

  closeShortfallPopover(): void {
    this.shortfallPopoverOpen.set(false);
  }

  readonly availableCredit = computed(() => {
    const a = this.account();
    if (!a || a.type !== 'credit' || !a.credit_limit) return 0;
    return a.credit_limit + a.balance;
  });

  readonly utilizationPct = computed(() => {
    const a = this.account();
    if (!a || a.type !== 'credit' || !a.credit_limit) return 0;
    return Math.round(
      Math.min(Math.abs(a.balance) / a.credit_limit, 1) * 100,
    );
  });

  readonly utilizationLevel = computed(() => {
    const pct = this.utilizationPct();
    if (pct >= 90) return 'high' as const;
    if (pct >= 50) return 'mid' as const;
    return 'low' as const;
  });

  constructor() {
    effect(() => {
      const id = this.accountId();
      if (!Number.isFinite(id)) return;
      void this.bootstrap(id);
    });
  }

  goBack(): void {
    this.location.back();
  }

  private async bootstrap(id: number): Promise<void> {
    if (!this.account()) {
      this.loading.set(true);
      try {
        await this.accountService.loadAllAccounts();
      } finally {
        this.loading.set(false);
      }
    }
    await Promise.all([this.loadFirstPage(id), this.loadUnsettled(id)]);
  }

  private async loadFirstPage(id: number): Promise<void> {
    this.txLoading.set(true);
    this.page.set(0);
    try {
      const rows = await this.transactionService.getByAccount(id, 0);
      this.transactions.set(rows);
      this.hasMore.set(rows.length === TransactionService.PAGE_SIZE);
    } finally {
      this.txLoading.set(false);
    }
  }

  private async loadUnsettled(id: number): Promise<void> {
    const a = this.account();
    if (!a || a.total_reserved <= 0) {
      this.unsettled.set([]);
      return;
    }
    this.unsettledLoading.set(true);
    try {
      const rows = await this.transactionService.getUnsettledReservations(id);
      this.unsettled.set(rows);
    } finally {
      this.unsettledLoading.set(false);
    }
  }

  async onRefresh(event: CustomEvent): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    try {
      await this.accountService.loadAllAccounts();
      await Promise.all([
        this.loadFirstPage(this.accountId()),
        this.loadUnsettled(this.accountId()),
      ]);
    } finally {
      (event.target as HTMLIonRefresherElement).complete();
    }
  }

  async onInfinite(event: CustomEvent): Promise<void> {
    const target = event.target as HTMLIonInfiniteScrollElement;
    try {
      const next = this.page() + 1;
      const rows = await this.transactionService.getByAccount(
        this.accountId(),
        next,
      );
      this.transactions.update((curr) => [...curr, ...rows]);
      this.page.set(next);
      this.hasMore.set(rows.length === TransactionService.PAGE_SIZE);
    } finally {
      await target.complete();
    }
  }

  toggleReservations(): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    this.reservationsOpen.update((v) => !v);
  }

  setMutasiFilter(filter: MutasiFilter): void {
    if (this.mutasiFilter() === filter) return;
    void Haptics.impact({ style: ImpactStyle.Light });
    this.mutasiFilter.set(filter);
  }

  isTransferIncoming(tx: Transaction): boolean {
    return (
      tx.type === 'transfer' &&
      tx.transfer_pair_id != null &&
      tx.transfer_pair_id < tx.id
    );
  }

  mutasiPillClass(filter: MutasiFilter): string {
    const base =
      'rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition active:scale-95';
    return this.mutasiFilter() === filter
      ? `${base} bg-ink text-on-dark`
      : `${base} bg-transparent text-ink border border-ink/15`;
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
    const weekday = new Intl.DateTimeFormat('id-ID', {
      weekday: 'long',
    }).format(d);
    const full = new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d);
    return `${weekday} · ${full}`;
  }

  async onSettleDebt(): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Medium });
    void this.router.navigate(['/settlements/new'], {
      queryParams: { reservedFrom: this.accountId() },
    });
  }

  readonly catatMenuOpen = signal(false);
  private catatLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  private catatLongPressFired = false;

  catatItemDelay(index: number): string {
    return this.catatMenuOpen()
      ? `${(1 - index) * 55}ms`
      : `${index * 35}ms`;
  }

  onCatatPress(): void {
    this.catatLongPressFired = false;
    this.clearCatatLongPressTimer();
    this.catatLongPressTimer = setTimeout(() => {
      this.catatLongPressTimer = null;
      this.catatLongPressFired = true;
      void Haptics.impact({ style: ImpactStyle.Medium });
      this.catatMenuOpen.set(true);
    }, 450);
  }

  onCatatRelease(): void {
    this.clearCatatLongPressTimer();
  }

  private clearCatatLongPressTimer(): void {
    if (this.catatLongPressTimer !== null) {
      clearTimeout(this.catatLongPressTimer);
      this.catatLongPressTimer = null;
    }
  }

  onCatatClick(): void {
    if (this.catatLongPressFired) {
      this.catatLongPressFired = false;
      return;
    }
    if (this.catatMenuOpen()) {
      this.catatMenuOpen.set(false);
      return;
    }
    void this.onCreateTransaction();
  }

  closeCatatMenu(): void {
    this.catatMenuOpen.set(false);
  }

  async onCreateTransaction(): Promise<void> {
    this.catatMenuOpen.set(false);
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/transactions/new'], {
      queryParams: { account: this.accountId() },
    });
  }

  async onImportTransaction(): Promise<void> {
    this.catatMenuOpen.set(false);
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/transactions/import'], {
      queryParams: { account: this.accountId() },
    });
  }

  onTransactionClick(id: number): void {
    if (this.reorderMode()) return; // chevrons own taps in reorder mode
    void this.router.navigate(['/transactions', id, 'edit']);
  }

  // A settlement-generated transfer leg. These must never be edited/deleted via
  // the normal Transaction Form (it doesn't understand settlements) — tapping
  // one offers to reverse the whole settlement instead (§7.4.3).
  isSettlementTransfer(tx: Transaction): boolean {
    return tx.type === 'transfer' && tx.settlement_transfer_id != null;
  }

  onMutasiRowClick(tx: Transaction): void {
    if (this.reorderMode()) return;
    if (this.isSettlementTransfer(tx)) {
      this.openReverseConfirm(tx);
      return;
    }
    void this.router.navigate(['/transactions', tx.id, 'edit']);
  }

  // ── reverse settlement ─────────────────────────────────────────────────────
  readonly showReverseConfirm = signal(false);
  readonly reversing = signal(false);
  readonly reverseTarget = signal<Transaction | null>(null);

  openReverseConfirm(tx: Transaction): void {
    void Haptics.impact({ style: ImpactStyle.Medium });
    this.reverseTarget.set(tx);
    this.showReverseConfirm.set(true);
  }

  closeReverseConfirm(): void {
    if (this.reversing()) return;
    this.showReverseConfirm.set(false);
    this.reverseTarget.set(null);
  }

  async onConfirmReverse(): Promise<void> {
    const settlementId = this.reverseTarget()?.settlement_transfer_id;
    if (settlementId == null) {
      this.closeReverseConfirm();
      return;
    }
    this.reversing.set(true);
    this.errorMessage.set(null);
    try {
      await this.settlementService.reverseSettlement(settlementId);
      await Haptics.notification({ type: NotificationType.Success });
      this.showReverseConfirm.set(false);
      this.reverseTarget.set(null);
      await this.accountService.loadAllAccounts();
      await Promise.all([
        this.loadFirstPage(this.accountId()),
        this.loadUnsettled(this.accountId()),
      ]);
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal membatalkan pelunasan',
      );
    } finally {
      this.reversing.set(false);
    }
  }

  enterReorderMode(): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    // Force "Semua" so visible order = underlying swap order.
    this.mutasiFilter.set('all');
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
      await this.loadFirstPage(this.accountId());
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menyimpan urutan',
      );
    } finally {
      this.saving.set(false);
    }
  }

  private computeSortUpdates(): { id: number; sort_index: number }[] {
    const updates: { id: number; sort_index: number }[] = [];
    const byDate = new Map<string, Transaction[]>();
    for (const tx of this.transactions()) {
      const arr = byDate.get(tx.date) ?? [];
      arr.push(tx);
      byDate.set(tx.date, arr);
    }
    for (const rows of byDate.values()) {
      const slots = rows.map((r) => r.sort_index ?? 0).sort((a, b) => b - a);
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

  onEdit(): void {
    void this.router.navigate(['/accounts', this.accountId(), 'edit']);
  }

  openDeleteConfirm(): void {
    void Haptics.impact({ style: ImpactStyle.Medium });
    this.showDeleteConfirm.set(true);
  }

  closeDeleteConfirm(): void {
    this.showDeleteConfirm.set(false);
  }

  async onConfirmDelete(): Promise<void> {
    this.closeDeleteConfirm();
    await this.deleteAccount();
  }

  private async deleteAccount(): Promise<void> {
    const a = this.account();
    if (!a) return;
    this.deleting.set(true);
    this.errorMessage.set(null);
    try {
      await this.accountService.softDelete(this.accountId());
      await this.accountService.loadAccounts();
      await this.accountService.loadAllAccounts();
      await Haptics.notification({ type: NotificationType.Success });
      void this.router.navigate(['/accounts'], { replaceUrl: true });
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menghapus akun',
      );
    } finally {
      this.deleting.set(false);
    }
  }
}
