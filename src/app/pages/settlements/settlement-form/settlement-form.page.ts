import {
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, ToastController } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { AccountService } from '../../../core/services/account.service';
import { SettlementService } from '../../../core/services/settlement.service';
import { TransactionService } from '../../../core/services/transaction.service';
import { AccountBalance, ReservationEntry } from '../../../core/models';
import { CurrencyFormatPipe } from '../../../shared/pipes/currency-format.pipe';
import { ThousandsInputDirective } from '../../../shared/directives/thousands-input.directive';
import { CalcButtonComponent } from '../../../shared/components/calc-button/calc-button.component';

interface FifoPreview {
  fullySettled: ReservationEntry[];
  partialEntry: ReservationEntry | null;
  remainderAmount: number;
  totalCovered: number;
}

@Component({
  selector: 'app-settlement-form',
  standalone: true,
  imports: [FormsModule, IonContent, CurrencyFormatPipe, ThousandsInputDirective, CalcButtonComponent],
  templateUrl: './settlement-form.page.html',
})
export class SettlementFormPage {
  private readonly accountService = inject(AccountService);
  private readonly transactionService = inject(TransactionService);
  private readonly settlementService = inject(SettlementService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toastCtrl = inject(ToastController);
  private readonly location = inject(Location);

  readonly loading = signal(true);
  readonly saving = signal(false);

  readonly owingAccountId = signal<number | null>(null);
  readonly lenderAccountId = signal<number | null>(null);
  // Optional conduit account: the real account that physically pays the
  // creditor. null = pay directly (owing → creditor). §7.4.
  readonly viaAccountId = signal<number | null>(null);
  readonly paymentAmount = signal<number | null>(null);
  readonly paymentDate = signal<string>(new Date().toISOString().slice(0, 10));
  readonly owingLocked = signal(false);
  readonly unsettled = signal<ReservationEntry[]>([]);
  readonly mode = signal<'amount' | 'select'>('amount');
  readonly selectedKeys = signal<Set<string>>(new Set());

  readonly allAccounts = computed(() => this.accountService.allAccounts());

  readonly owingOptions = computed(() =>
    this.allAccounts().filter(
      (a) => a.type !== 'credit' && a.total_reserved > 0,
    ),
  );

  readonly owingAccount = computed<AccountBalance | undefined>(() => {
    const id = this.owingAccountId();
    return id == null
      ? undefined
      : this.allAccounts().find((a) => a.id === id);
  });

  readonly lenderOptions = computed(() => {
    const map = new Map<number, { account: AccountBalance; total: number }>();
    for (const entry of this.unsettled()) {
      const acc = this.allAccounts().find(
        (a) => a.id === entry.parent.account_id,
      );
      if (!acc) continue;
      const grouped = map.get(acc.id) ?? { account: acc, total: 0 };
      grouped.total = Number((grouped.total + entry.amount).toFixed(2));
      map.set(acc.id, grouped);
    }
    return [...map.values()];
  });

  readonly selectedLender = computed(() => {
    const id = this.lenderAccountId();
    return id == null
      ? undefined
      : this.lenderOptions().find((l) => l.account.id === id);
  });

  // Conduit options = any account other than the owing and the creditor.
  readonly viaOptions = computed(() => {
    const owing = this.owingAccountId();
    const lender = this.lenderAccountId();
    return this.allAccounts().filter(
      (a) => a.id !== owing && a.id !== lender,
    );
  });

  readonly viaAccount = computed<AccountBalance | undefined>(() => {
    const id = this.viaAccountId();
    return id == null
      ? undefined
      : this.allAccounts().find((a) => a.id === id);
  });

  readonly filteredUnsettled = computed(() => {
    const lender = this.lenderAccountId();
    if (lender == null) return [];
    return this.unsettled().filter((e) => e.parent.account_id === lender);
  });

  readonly totalUnsettled = computed(() =>
    Number(
      this.filteredUnsettled()
        .reduce((sum, e) => sum + e.amount, 0)
        .toFixed(2),
    ),
  );

  // Positive when the user-entered payment is less than the total unsettled
  // debt for the picked owing/lender pair — i.e. how much more would be needed
  // to fully clear the debt. Null when nothing is entered yet.
  readonly shortfall = computed<number | null>(() => {
    const amt = this.paymentAmount();
    if (amt == null || amt <= 0) return null;
    const gap = Number((this.totalUnsettled() - amt).toFixed(2));
    return gap > 0 ? gap : 0;
  });

  // Positive when the entered payment exceeds the owing account's current
  // balance — that account would go minus after settle(). Null when nothing
  // is entered or the owing account hasn't been picked yet.
  readonly balanceShortage = computed<number | null>(() => {
    const amt = this.paymentAmount();
    const acc = this.owingAccount();
    if (amt == null || amt <= 0 || !acc) return null;
    const gap = Number((amt - acc.balance).toFixed(2));
    return gap > 0 ? gap : 0;
  });

  readonly currencyCode = computed(
    () => this.owingAccount()?.currency_code ?? 'IDR',
  );

  readonly selectedEntries = computed<ReservationEntry[]>(() => {
    const keys = this.selectedKeys();
    if (keys.size === 0) return [];
    return this.filteredUnsettled().filter((e) =>
      keys.has(this.entryKey(e)),
    );
  });

  readonly selectionTotal = computed(() =>
    Number(
      this.selectedEntries()
        .reduce((sum, e) => sum + e.amount, 0)
        .toFixed(2),
    ),
  );

  readonly allFilteredSelected = computed(() => {
    const entries = this.filteredUnsettled();
    if (entries.length === 0) return false;
    return entries.every((e) => this.selectedKeys().has(this.entryKey(e)));
  });

  readonly preview = computed<FifoPreview>(() => {
    if (this.mode() === 'select') {
      const selected = this.selectedEntries();
      return {
        fullySettled: selected,
        partialEntry: null,
        remainderAmount: 0,
        totalCovered: this.selectionTotal(),
      };
    }
    const amount = this.paymentAmount() ?? 0;
    const reservations = this.filteredUnsettled();
    const fullySettled: ReservationEntry[] = [];
    let partialEntry: ReservationEntry | null = null;
    let remainderAmount = 0;
    let remaining = amount;
    let totalCovered = 0;
    for (const entry of reservations) {
      if (remaining <= 0) break;
      if (entry.amount <= remaining) {
        fullySettled.push(entry);
        totalCovered = Number((totalCovered + entry.amount).toFixed(2));
        remaining = Number((remaining - entry.amount).toFixed(2));
      } else {
        partialEntry = entry;
        remainderAmount = Number((entry.amount - remaining).toFixed(2));
        totalCovered = Number((totalCovered + remaining).toFixed(2));
        remaining = 0;
      }
    }
    return { fullySettled, partialEntry, remainderAmount, totalCovered };
  });

  readonly settledKeys = computed(
    () => new Set(this.preview().fullySettled.map((e) => `${e.kind}-${e.id}`)),
  );

  readonly partialKey = computed(() => {
    const p = this.preview().partialEntry;
    return p ? `${p.kind}-${p.id}` : null;
  });

  readonly canSubmit = computed(() => {
    if (!this.paymentDate()) return false;
    if (this.owingAccountId() == null) return false;
    if (this.lenderAccountId() == null) return false;
    if (this.mode() === 'select') {
      return this.selectedEntries().length > 0;
    }
    const amt = this.paymentAmount();
    if (!amt || amt <= 0) return false;
    if (amt > this.totalUnsettled()) return false;
    return true;
  });

  isSettled(entry: ReservationEntry): boolean {
    return this.settledKeys().has(`${entry.kind}-${entry.id}`);
  }

  isSelected(entry: ReservationEntry): boolean {
    return this.selectedKeys().has(this.entryKey(entry));
  }

  isPartial(entry: ReservationEntry): boolean {
    return this.partialKey() === `${entry.kind}-${entry.id}`;
  }

  entryStatus(entry: ReservationEntry): 'lunas' | 'parsial' | 'idle' {
    if (this.isSettled(entry)) return 'lunas';
    if (this.isPartial(entry)) return 'parsial';
    return 'idle';
  }

  entryKey(entry: ReservationEntry): string {
    return `${entry.kind}-${entry.id}`;
  }

  formatDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round(
      (today.getTime() - d.getTime()) / 86_400_000,
    );
    if (diffDays === 0) return 'Hari ini';
    if (diffDays === 1) return 'Kemarin';
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d);
  }

  entryTitle(entry: ReservationEntry): string {
    const note = entry.note?.trim();
    if (note) return note;
    if (entry.category?.name) return entry.category.name;
    return 'Pengeluaran';
  }

  entrySubtitle(entry: ReservationEntry): string {
    const acc = this.allAccounts().find(
      (a) => a.id === entry.parent.account_id,
    );
    const accName = acc?.name ?? 'akun';
    const prefix = entry.kind === 'item' ? 'rincian dari' : 'dari';
    return `${prefix} ${accName} · ${this.formatDate(entry.parent.date)}`;
  }

  constructor() {
    effect(() => {
      const reservedFromParam = this.route.snapshot.queryParamMap.get(
        'reservedFrom',
      );
      const reservedFrom = reservedFromParam ? Number(reservedFromParam) : null;
      void this.bootstrap(reservedFrom);
    });

    effect(() => {
      if (this.mode() !== 'amount') return;
      const total = this.totalUnsettled();
      if (total > 0 && this.paymentAmount() == null) {
        this.paymentAmount.set(total);
      }
    });

    // In select mode, mirror SUM(selected) into paymentAmount so the existing
    // shortfall / balance-shortage chips and the action button label work
    // without a separate code path.
    effect(() => {
      if (this.mode() !== 'select') return;
      const sum = this.selectionTotal();
      this.paymentAmount.set(sum > 0 ? sum : null);
    });

    effect(() => {
      const opts = this.lenderOptions();
      if (opts.length === 1 && this.lenderAccountId() == null) {
        this.lenderAccountId.set(opts[0].account.id);
      }
    });
  }

  private async bootstrap(reservedFrom: number | null): Promise<void> {
    this.loading.set(true);
    try {
      if (this.allAccounts().length === 0) {
        await this.accountService.loadAllAccounts();
      }
      if (reservedFrom != null) {
        this.owingAccountId.set(reservedFrom);
        this.owingLocked.set(true);
        await this.loadUnsettledFor(reservedFrom);
      }
    } finally {
      this.loading.set(false);
    }
  }

  private async loadUnsettledFor(owingId: number): Promise<void> {
    const rows = await this.transactionService.getUnsettledReservations(
      owingId,
    );
    this.unsettled.set(rows);
  }

  async selectOwing(id: number): Promise<void> {
    if (this.owingAccountId() === id) return;
    this.owingAccountId.set(id);
    this.lenderAccountId.set(null);
    this.viaAccountId.set(null);
    this.paymentAmount.set(null);
    this.selectedKeys.set(new Set());
    this.unsettled.set([]);
    await this.loadUnsettledFor(id);
  }

  selectLender(id: number): void {
    if (this.lenderAccountId() === id) return;
    this.lenderAccountId.set(id);
    this.viaAccountId.set(null);
    this.paymentAmount.set(null);
    this.selectedKeys.set(new Set());
  }

  // null = pay directly (owing → creditor); an account id routes the money
  // owing → via → creditor (§7.4).
  selectVia(id: number | null): void {
    this.viaAccountId.set(id);
  }

  onAmountInput(value: string): void {
    const n = value === '' ? null : Number(value);
    this.paymentAmount.set(Number.isFinite(n) ? n : null);
  }

  onDateInput(value: string): void {
    if (value) this.paymentDate.set(value);
  }

  setMaxAmount(): void {
    this.paymentAmount.set(this.totalUnsettled());
  }

  setMode(next: 'amount' | 'select'): void {
    if (this.mode() === next) return;
    this.mode.set(next);
    this.selectedKeys.set(new Set());
    this.paymentAmount.set(null);
  }

  toggleEntry(entry: ReservationEntry): void {
    const key = this.entryKey(entry);
    const next = new Set(this.selectedKeys());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.selectedKeys.set(next);
  }

  selectAllVisible(): void {
    const next = new Set<string>();
    for (const e of this.filteredUnsettled()) next.add(this.entryKey(e));
    this.selectedKeys.set(next);
  }

  clearSelection(): void {
    this.selectedKeys.set(new Set());
  }

  goBack(): void {
    this.location.back();
  }

  async onSubmit(): Promise<void> {
    if (!this.canSubmit()) return;
    await Haptics.impact({ style: ImpactStyle.Medium });
    this.saving.set(true);
    try {
      if (this.mode() === 'select') {
        await this.settlementService.settleSelected({
          payerAccountId: this.lenderAccountId()!,
          reservedFromAccountId: this.owingAccountId()!,
          entries: this.selectedEntries(),
          paymentDate: this.paymentDate(),
          viaAccountId: this.viaAccountId(),
        });
      } else {
        await this.settlementService.settle({
          payerAccountId: this.lenderAccountId()!,
          reservedFromAccountId: this.owingAccountId()!,
          paymentAmount: this.paymentAmount()!,
          paymentDate: this.paymentDate(),
          viaAccountId: this.viaAccountId(),
        });
      }
      await this.accountService.loadAccounts();
      await this.accountService.loadAllAccounts();
      await Haptics.notification({ type: NotificationType.Success });
      const toast = await this.toastCtrl.create({
        message: 'Hutang lunas',
        duration: 1800,
        color: 'success',
      });
      await toast.present();
      void this.router.navigate(
        ['/accounts', this.owingAccountId()],
        { replaceUrl: true },
      );
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      const toast = await this.toastCtrl.create({
        message: err instanceof Error ? err.message : 'Gagal melunasi',
        duration: 3000,
        color: 'danger',
      });
      await toast.present();
    } finally {
      this.saving.set(false);
    }
  }
}
