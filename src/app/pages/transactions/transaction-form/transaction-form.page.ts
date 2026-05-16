import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Location } from '@angular/common';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { IonContent, IonModal } from '@ionic/angular/standalone';
import { AccountService } from '../../../core/services/account.service';
import { CategoryService } from '../../../core/services/category.service';
import {
  TransactionItemInput,
  TransactionService,
} from '../../../core/services/transaction.service';
import { Transaction, TransactionType } from '../../../core/models';
import { CurrencyFormatPipe } from '../../../shared/pipes/currency-format.pipe';

interface RincianRow {
  amount: number | null;
  category_id: number | null;
  note: string;
  // UI-only toggle. true → reservation card visible (account may still be null
  // pending user pick); false → no reservation regardless of owing value.
  reservation_enabled: boolean;
  reserved_from_account_id: number | null;
}

interface TypeOption {
  value: TransactionType;
  label: string;
  short: string;
}

@Component({
  selector: 'app-transaction-form',
  standalone: true,
  imports: [IonContent, IonModal, CurrencyFormatPipe],
  templateUrl: './transaction-form.page.html',
})
export class TransactionFormPage {
  private readonly accountService = inject(AccountService);
  private readonly categoryService = inject(CategoryService);
  private readonly transactionService = inject(TransactionService);
  private readonly location = inject(Location);

  readonly id = input<string | undefined>(undefined);
  readonly account = input<string | undefined>(undefined);

  readonly typeOptions: TypeOption[] = [
    { value: 'expense', label: 'Pengeluaran', short: 'Keluar' },
    { value: 'income', label: 'Pemasukan', short: 'Masuk' },
    { value: 'transfer', label: 'Transfer', short: 'Pindah' },
  ];

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly showDeleteConfirm = signal(false);

  readonly type = signal<TransactionType>('expense');
  readonly amount = signal<number | null>(null);
  readonly date = signal<string>(new Date().toISOString().slice(0, 10));
  readonly accountId = signal<number | null>(null);
  readonly toAccountId = signal<number | null>(null);
  readonly fromAccountId = signal<number | null>(null);
  readonly categoryId = signal<number | null>(null);
  readonly note = signal<string>('');
  readonly payFromAnother = signal<boolean>(false);
  readonly owingAccountId = signal<number | null>(null);

  readonly itemsMode = signal<boolean>(false);
  readonly items = signal<RincianRow[]>([]);

  private original: Transaction | null = null;

  readonly isEdit = computed(() => this.id() !== undefined);
  readonly editLocked = computed(() => this.isEdit());
  readonly itemsLocked = computed(() => this.isEdit() && this.itemsMode());

  readonly allAccounts = computed(() => this.accountService.allAccounts());

  readonly nonCreditAccounts = computed(() =>
    this.allAccounts().filter((a) => a.type !== 'credit'),
  );

  readonly primaryAccountOptions = computed(() =>
    this.type() === 'expense' ? this.allAccounts() : this.nonCreditAccounts(),
  );

  readonly owingAccountOptions = computed(() => {
    const payer = this.accountId();
    return this.nonCreditAccounts().filter((a) => a.id !== payer);
  });

  readonly availableCategories = computed(() =>
    this.categoryService.getByType(this.type()),
  );

  readonly selectedAccount = computed(() => {
    const id = this.accountId();
    if (id == null) return undefined;
    return this.allAccounts().find((a) => a.id === id);
  });

  readonly canShowReservationToggle = computed(() => {
    if (this.type() !== 'expense') return false;
    if (this.itemsMode()) return false; // §9: parent-level toggle hidden in split mode
    return !!this.selectedAccount();
  });

  readonly canSplit = computed(() => this.type() !== 'transfer');

  readonly itemsTotal = computed(() =>
    this.items().reduce((sum, i) => sum + (Number(i.amount) || 0), 0),
  );

  readonly canSave = computed(() => {
    if (!this.date()) return false;
    if (this.type() === 'transfer') {
      const f = this.fromAccountId();
      const t = this.toAccountId();
      const amt = this.amount();
      if (!amt || amt <= 0) return false;
      if (f == null || t == null || f === t) return false;
      return true;
    }
    if (!this.accountId()) return false;
    if (this.payFromAnother()) {
      const owing = this.owingAccountId();
      if (owing == null || owing === this.accountId()) return false;
    }

    if (this.itemsMode()) {
      const list = this.items();
      if (list.length === 0) return false;
      const payer = this.accountId();
      const nonCreditIds = new Set(this.nonCreditAccounts().map((a) => a.id));
      for (const it of list) {
        if (!it.amount || it.amount <= 0) return false;
        if (it.category_id == null) return false;
        if (it.reservation_enabled) {
          const owing = it.reserved_from_account_id;
          if (owing == null) return false;
          if (owing === payer) return false;
          if (!nonCreditIds.has(owing)) return false;
        }
      }
      return true;
    }

    const amt = this.amount();
    if (!amt || amt <= 0) return false;
    return true;
  });

  constructor() {
    effect(() => {
      const txId = this.id();
      void this.bootstrap(txId);
    });
    effect(() => {
      const payer = this.accountId();
      const owing = this.owingAccountId();
      if (owing != null && payer != null && owing === payer) {
        this.owingAccountId.set(null);
      }
    });
    // Items: clear any per-item owing that collides with the current payer.
    // The reservation_enabled flag is kept so the user sees the empty selector
    // and re-picks a valid account.
    effect(() => {
      const payer = this.accountId();
      if (payer == null) return;
      const list = this.items();
      if (list.length === 0) return;
      const needsClear = list.some(
        (i) => i.reserved_from_account_id === payer,
      );
      if (needsClear) {
        this.items.update((rows) =>
          rows.map((r) =>
            r.reserved_from_account_id === payer
              ? { ...r, reserved_from_account_id: null }
              : r,
          ),
        );
      }
    });
  }

  asValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  asNumber(event: Event): number | null {
    const raw = this.asValue(event).trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  asNumberId(event: Event): number | null {
    const v = this.asValue(event);
    return v === '' ? null : Number(v);
  }

  goBack(): void {
    this.location.back();
  }

  categoryNameOf(id: number | null | undefined): string {
    if (id == null) return 'Tanpa kategori';
    const cat = this.categoryService
      .categories()
      .find((c) => c.id === id);
    return cat?.name ?? 'Tanpa kategori';
  }

  accountNameOf(id: number | null | undefined): string {
    if (id == null) return '';
    return this.allAccounts().find((a) => a.id === id)?.name ?? '';
  }

  private async bootstrap(txId: string | undefined): Promise<void> {
    this.loading.set(true);
    try {
      await Promise.all([
        this.allAccounts().length === 0
          ? this.accountService.loadAllAccounts()
          : Promise.resolve(),
        this.categoryService.categories().length === 0
          ? this.categoryService.loadCategories()
          : Promise.resolve(),
      ]);
      if (txId) {
        const tx = await this.transactionService.getById(Number(txId));
        if (tx) this.populateFromTx(tx);
      } else {
        this.applyDefaultAccount();
      }
    } finally {
      this.loading.set(false);
    }
  }

  private applyDefaultAccount(): void {
    const raw = this.account();
    if (!raw) return;
    const id = Number(raw);
    if (!Number.isFinite(id)) return;
    const exists = this.allAccounts().some((a) => a.id === id);
    if (!exists) return;
    this.accountId.set(id);
    this.fromAccountId.set(id);
  }

  private populateFromTx(tx: Transaction): void {
    this.original = tx;
    this.type.set(tx.type);
    this.amount.set(tx.amount);
    this.date.set(tx.date);
    this.note.set(tx.note ?? '');
    this.categoryId.set(tx.category_id ?? null);
    if (tx.type === 'transfer') {
      this.fromAccountId.set(tx.account_id);
      this.toAccountId.set(tx.transfer_pair_id ?? null);
    } else {
      this.accountId.set(tx.account_id);
      if (tx.reserved_from_account_id) {
        this.payFromAnother.set(true);
        this.owingAccountId.set(tx.reserved_from_account_id);
      } else {
        this.payFromAnother.set(false);
        this.owingAccountId.set(null);
      }
    }
    if (tx.items && tx.items.length > 0) {
      this.itemsMode.set(true);
      this.items.set(
        tx.items.map((it) => ({
          amount: it.amount,
          category_id: it.category_id ?? null,
          note: it.note ?? '',
          reservation_enabled: it.reserved_from_account_id != null,
          reserved_from_account_id: it.reserved_from_account_id ?? null,
        })),
      );
    }
  }

  selectType(t: TransactionType): void {
    if (this.editLocked()) return;
    this.type.set(t);
    this.categoryId.set(null);
    if (t === 'transfer') {
      this.payFromAnother.set(false);
      this.owingAccountId.set(null);
      if (this.itemsMode()) this.disableSplit(true);
    }
  }

  onPayFromAnotherChange(checked: boolean): void {
    this.payFromAnother.set(checked);
    if (!checked) this.owingAccountId.set(null);
  }

  // ── rincian editing ──────────────────────────────────────────────────────

  enableSplit(): void {
    if (this.itemsLocked()) return;
    if (!this.canSplit()) return;
    void Haptics.impact({ style: ImpactStyle.Light });
    const seedCategory = this.categoryId();
    const seedAmount = this.amount();
    const seedEnabled = this.payFromAnother() && this.owingAccountId() != null;
    const seedOwing = seedEnabled ? this.owingAccountId() : null;
    this.items.set([
      {
        amount: seedAmount,
        category_id: seedCategory,
        note: '',
        reservation_enabled: seedEnabled,
        reserved_from_account_id: seedOwing,
      },
    ]);
    this.itemsMode.set(true);
  }

  disableSplit(silent = false): void {
    if (this.itemsLocked()) return;
    if (!silent) void Haptics.impact({ style: ImpactStyle.Light });
    const list = this.items();
    if (list.length > 0) {
      this.amount.set(this.itemsTotal() || null);
      this.categoryId.set(list[0].category_id);
    }
    this.items.set([]);
    this.itemsMode.set(false);
  }

  addItem(): void {
    if (this.itemsLocked()) return;
    void Haptics.impact({ style: ImpactStyle.Light });
    this.items.update((list) => [
      ...list,
      {
        amount: null,
        category_id: null,
        note: '',
        reservation_enabled: false,
        reserved_from_account_id: null,
      },
    ]);
  }

  // Toggles per-item "Hutang ke akun" UI. ON opens the selector (owing stays
  // null until the user picks). OFF clears any selected owing account.
  toggleItemReservation(index: number, checked: boolean): void {
    if (this.itemsLocked()) return;
    this.updateItem(index, {
      reservation_enabled: checked,
      reserved_from_account_id: null,
    });
  }

  removeItem(index: number): void {
    if (this.itemsLocked()) return;
    void Haptics.impact({ style: ImpactStyle.Light });
    this.items.update((list) => list.filter((_, i) => i !== index));
  }

  updateItem(index: number, patch: Partial<RincianRow>): void {
    if (this.itemsLocked()) return;
    this.items.update((list) =>
      list.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  // ── save / delete ────────────────────────────────────────────────────────

  async onSave(): Promise<void> {
    if (!this.canSave() || this.saving()) return;
    await Haptics.impact({ style: ImpactStyle.Light });
    this.saving.set(true);
    this.errorMessage.set(null);
    try {
      if (this.isEdit()) {
        await this.saveEdit();
      } else {
        await this.saveCreate();
      }
      await this.accountService.loadAccounts();
      await this.accountService.loadAllAccounts();
      await Haptics.notification({ type: NotificationType.Success });
      this.location.back();
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menyimpan',
      );
    } finally {
      this.saving.set(false);
    }
  }

  private buildItemsInput(): TransactionItemInput[] {
    return this.items().map((row, idx) => ({
      amount: Number(row.amount),
      category_id: row.category_id ?? undefined,
      note: row.note.trim() || undefined,
      position: idx,
      reserved_from_account_id:
        row.reservation_enabled && row.reserved_from_account_id != null
          ? row.reserved_from_account_id
          : undefined,
    }));
  }

  private async saveCreate(): Promise<void> {
    const date = this.date();
    const note = this.note().trim() || undefined;
    const inSplit = this.itemsMode();
    const splitItems = inSplit ? this.buildItemsInput() : undefined;
    const amount = inSplit
      ? splitItems!.reduce((s, i) => s + i.amount, 0)
      : Number(this.amount());

    if (this.type() === 'transfer') {
      await this.transactionService.createTransfer({
        fromAccountId: this.fromAccountId()!,
        toAccountId: this.toAccountId()!,
        amount,
        date,
        note,
      });
      return;
    }

    // §9 hybrid invariant: in split mode each item owns its own reservation,
    // and the parent row carries NULL reservation. Always create() with items.
    if (inSplit) {
      await this.transactionService.create(
        {
          account_id: this.accountId()!,
          category_id: undefined,
          amount,
          type: this.type(),
          date,
          note,
        },
        splitItems,
      );
      return;
    }

    if (this.type() === 'expense' && this.payFromAnother()) {
      await this.transactionService.createReservedExpense({
        payerAccountId: this.accountId()!,
        reservedFromAccountId: this.owingAccountId()!,
        categoryId: this.categoryId() ?? undefined,
        amount,
        date,
        note,
      });
      return;
    }

    await this.transactionService.create({
      account_id: this.accountId()!,
      category_id: this.categoryId() ?? undefined,
      amount,
      type: this.type(),
      date,
      note,
    });
  }

  private async saveEdit(): Promise<void> {
    if (!this.original) return;
    // v1: items themselves are not editable in edit mode (per CLAUDE.md §7.6).
    // Only date, note, and (single-mode) category may change here.
    await this.transactionService.update(this.original.id, {
      date: this.date(),
      note: this.note().trim() || undefined,
      category_id: this.itemsMode()
        ? undefined
        : this.categoryId() ?? undefined,
    });
  }

  openDeleteConfirm(): void {
    if (!this.isEdit() || this.saving()) return;
    void Haptics.impact({ style: ImpactStyle.Medium });
    this.showDeleteConfirm.set(true);
  }

  closeDeleteConfirm(): void {
    this.showDeleteConfirm.set(false);
  }

  async onConfirmDelete(): Promise<void> {
    this.closeDeleteConfirm();
    await this.deleteTx();
  }

  private async deleteTx(): Promise<void> {
    if (!this.original) return;
    this.saving.set(true);
    this.errorMessage.set(null);
    await Haptics.impact({ style: ImpactStyle.Medium });
    try {
      await this.transactionService.delete(this.original.id);
      await this.accountService.loadAccounts();
      await this.accountService.loadAllAccounts();
      await Haptics.notification({ type: NotificationType.Success });
      this.location.back();
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menghapus',
      );
    } finally {
      this.saving.set(false);
    }
  }
}
