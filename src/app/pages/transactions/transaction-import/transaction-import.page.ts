import { Component, computed, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { AccountService } from '../../../core/services/account.service';
import { CategoryService } from '../../../core/services/category.service';
import {
  BankImportError,
  BankImportService,
} from '../../../core/services/bank-import.service';
import { TransactionService } from '../../../core/services/transaction.service';
import {
  ACCOUNT_TYPE_LABEL,
  Category,
  ImportDraft,
  Transaction,
} from '../../../core/models';
import { CurrencyFormatPipe } from '../../../shared/pipes/currency-format.pipe';
import { ThousandsInputDirective } from '../../../shared/directives/thousands-input.directive';
import {
  SearchableSelectComponent,
  SearchableSelectOption,
} from '../../../shared/components/searchable-select/searchable-select.component';
import { CalcButtonComponent } from '../../../shared/components/calc-button/calc-button.component';

type Step = 'account' | 'upload' | 'extracting' | 'review';

function shiftDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

@Component({
  selector: 'app-transaction-import',
  standalone: true,
  imports: [
    IonContent,
    CurrencyFormatPipe,
    ThousandsInputDirective,
    SearchableSelectComponent,
    CalcButtonComponent,
  ],
  templateUrl: './transaction-import.page.html',
})
export class TransactionImportPage {
  private readonly accountService = inject(AccountService);
  private readonly categoryService = inject(CategoryService);
  private readonly bankImport = inject(BankImportService);
  private readonly transactionService = inject(TransactionService);
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly step = signal<Step>('account');
  readonly accountId = signal<number | null>(null);
  readonly drafts = signal<ImportDraft[]>([]);
  readonly errorMessage = signal<string | null>(null);
  readonly committing = signal(false);

  // Duplicate-hint cache: existing transactions on the picked account keyed by
  // 'YYYY-MM-DD'. Filled when entering Review for the union of (draft.date ± 1)
  // and topped up lazily when a user edits a draft date outside the cache.
  readonly nearbyByDate = signal<Map<string, Transaction[]>>(new Map());
  readonly expandedDuplicateAt = signal<Set<number>>(new Set());

  readonly accounts = computed(() => this.accountService.allAccounts());
  readonly categories = computed(() => this.categoryService.categories());
  readonly incomeCategories = computed(() =>
    this.categories().filter((c) => c.type === 'income'),
  );
  readonly expenseCategories = computed(() =>
    this.categories().filter((c) => c.type === 'expense'),
  );

  readonly keepCount = computed(() => this.drafts().filter((d) => !d.skip).length);
  readonly allSkipped = computed(() => this.keepCount() === 0);
  readonly selectedAccount = computed(() => {
    const id = this.accountId();
    return id ? this.accounts().find((a) => a.id === id) ?? null : null;
  });

  readonly otherAccounts = computed(() => {
    const id = this.accountId();
    return this.accounts().filter((a) => a.id !== id);
  });

  // Owing-account candidates: non-credit accounts other than the payer. Empty
  // when the user only has one non-credit account (or only credit cards).
  readonly owingAccountOptions = computed(() => {
    const id = this.accountId();
    return this.accounts().filter((a) => a.type !== 'credit' && a.id !== id);
  });

  readonly owingAccountPickerOptions = computed<SearchableSelectOption[]>(() =>
    this.owingAccountOptions().map((a) => ({
      id: a.id,
      label: a.name,
      sublabel: ACCOUNT_TYPE_LABEL[a.type],
    })),
  );

  // Bulk default for the Review step. Picking propagates to every expense row
  // (overwrites prior per-row values); clearing wipes them. Per-row pickers
  // still allow individual overrides after.
  readonly defaultOwingAccountId = signal<number | null>(null);

  readonly hasExpenseDraft = computed(() =>
    this.drafts().some((d) => d.type === 'expense' && !d.skip),
  );

  readonly incomeCategoryPickerOptions = computed<SearchableSelectOption[]>(
    () => this.incomeCategories().map((c) => ({ id: c.id, label: c.name })),
  );

  readonly expenseCategoryPickerOptions = computed<SearchableSelectOption[]>(
    () => this.expenseCategories().map((c) => ({ id: c.id, label: c.name })),
  );

  readonly transferAccountPickerOptions = computed<SearchableSelectOption[]>(
    () =>
      this.otherAccounts().map((a) => ({
        id: a.id,
        label: a.name,
        sublabel: ACCOUNT_TYPE_LABEL[a.type],
      })),
  );

  readonly missingTransferAccount = computed(() =>
    this.drafts().some(
      (d) => !d.skip && d.type === 'transfer' && !d.transferAccountId,
    ),
  );

  readonly missingDate = computed(() =>
    this.drafts().some((d) => !d.skip && !d.date),
  );

  readonly canCommit = computed(
    () =>
      !this.allSkipped() &&
      !this.missingTransferAccount() &&
      !this.missingDate(),
  );

  constructor() {
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    try {
      if (this.accounts().length === 0) {
        await this.accountService.loadAllAccounts();
      }
      if (this.categories().length === 0) {
        await this.categoryService.loadCategories();
      }
      // Deep-link: ?account=<id> pre-selects the account and skips Step 1.
      // Silently ignored if the id doesn't match a loaded account.
      const raw = this.route.snapshot.queryParamMap.get('account');
      const id = raw ? Number(raw) : NaN;
      if (Number.isFinite(id) && this.accounts().some((a) => a.id === id)) {
        this.accountId.set(id);
        this.step.set('upload');
      }
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal memuat data awal',
      );
    }
  }

  goBack(): void {
    this.location.back();
  }

  async pickAccount(id: number): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.accountId.set(id);
    this.step.set('upload');
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.accountId()) return;

    await Haptics.impact({ style: ImpactStyle.Light });
    this.errorMessage.set(null);
    this.step.set('extracting');
    this.nearbyByDate.set(new Map());
    this.expandedDuplicateAt.set(new Set());

    try {
      const drafts = await this.bankImport.extract({
        imageBlob: file,
        accountId: this.accountId()!,
      });
      if (drafts.length === 0) {
        this.errorMessage.set('Tidak ada transaksi terdeteksi pada gambar.');
        this.step.set('upload');
        return;
      }
      this.drafts.set(drafts);
      this.step.set('review');
      void this.ensureNearbyForDates(this.unionWindowDates(drafts));
    } catch (err) {
      this.errorMessage.set(
        err instanceof BankImportError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Gagal mengekstrak transaksi',
      );
      this.step.set('upload');
    }
  }

  private unionWindowDates(drafts: ImportDraft[]): string[] {
    const set = new Set<string>();
    for (const d of drafts) {
      if (!d.date) continue;
      for (const day of this.windowDatesFor(d.date)) set.add(day);
    }
    return [...set];
  }

  private windowDatesFor(date: string | null): string[] {
    if (!date) return [];
    return [shiftDate(date, -1), date, shiftDate(date, 1)];
  }

  private async ensureNearbyForDates(dates: string[]): Promise<void> {
    const accountId = this.accountId();
    if (!accountId) return;
    const cache = this.nearbyByDate();
    const missing = dates.filter((d) => !cache.has(d));
    if (missing.length === 0) return;
    try {
      const rows = await this.transactionService.getNearbyForImport({
        accountId,
        dates: missing,
      });
      const next = new Map(cache);
      for (const d of missing) next.set(d, []);
      for (const tx of rows) {
        const bucket = next.get(tx.date);
        if (bucket) bucket.push(tx);
      }
      this.nearbyByDate.set(next);
    } catch {
      // Silent: duplicate hints are advisory; commit + extract paths surface errors.
    }
  }

  matchesForDraft(draft: ImportDraft): {
    exact: Transaction[];
    nearby: Transaction[];
  } {
    if (!draft.date) return { exact: [], nearby: [] };
    const cache = this.nearbyByDate();
    const window = this.windowDatesFor(draft.date);
    const all: Transaction[] = [];
    for (const d of window) {
      const bucket = cache.get(d);
      if (bucket) all.push(...bucket);
    }
    const exact: Transaction[] = [];
    const nearby: Transaction[] = [];
    for (const tx of all) {
      if (tx.amount === draft.amount) exact.push(tx);
      else nearby.push(tx);
    }
    return { exact, nearby };
  }

  isDuplicateExpanded(index: number): boolean {
    return this.expandedDuplicateAt().has(index);
  }

  toggleDuplicateExpand(index: number): void {
    const next = new Set(this.expandedDuplicateAt());
    if (next.has(index)) next.delete(index);
    else next.add(index);
    this.expandedDuplicateAt.set(next);
  }

  formatNearbyDate(date: string): string {
    const d = new Date(date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((today.getTime() - d.getTime()) / 86_400_000);
    if (diffDays === 0) return 'Hari ini';
    if (diffDays === 1) return 'Kemarin';
    if (diffDays === -1) return 'Besok';
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(d);
  }

  retryUpload(): void {
    this.errorMessage.set(null);
    this.step.set('upload');
  }

  categoriesForDraft(draft: ImportDraft): Category[] {
    return draft.type === 'income'
      ? this.incomeCategories()
      : this.expenseCategories();
  }

  updateDraft(index: number, patch: Partial<ImportDraft>): void {
    this.drafts.update((list) =>
      list.map((d, i) => (i === index ? { ...d, ...patch } : d)),
    );
  }

  onDateChange(index: number, value: string): void {
    const next = value || null;
    this.updateDraft(index, { date: next });
    if (next) void this.ensureNearbyForDates(this.windowDatesFor(next));
  }

  onAmountChange(index: number, value: number | null): void {
    if (value != null && Number.isFinite(value) && value > 0) {
      this.updateDraft(index, { amount: value });
    }
  }

  onTypeChange(index: number, value: 'income' | 'expense' | 'transfer'): void {
    const list = this.drafts();
    const current = list[index];
    if (current.type === value) return;

    if (value === 'transfer') {
      this.updateDraft(index, {
        type: 'transfer',
        suggestedCategoryId: undefined,
        transferDirection: current.transferDirection ?? 'out',
        transferAccountId: current.transferAccountId,
      });
      return;
    }

    const newCats =
      value === 'income' ? this.incomeCategories() : this.expenseCategories();
    const stillValid =
      current.suggestedCategoryId &&
      newCats.some((c) => c.id === current.suggestedCategoryId)
        ? current.suggestedCategoryId
        : undefined;
    this.updateDraft(index, {
      type: value,
      suggestedCategoryId: stillValid,
      transferDirection: undefined,
      transferAccountId: undefined,
      // income rows can't carry a reservation; expense rows inherit the bulk
      // default when switching in (or stay on whatever value the row already
      // had if the user had pre-set it before flipping types).
      reservedFromAccountId:
        value === 'expense'
          ? current.reservedFromAccountId ?? this.defaultOwingAccountId() ?? undefined
          : null,
    });
  }

  // Page-level "fill all expense rows" picker. Mass-set on change so the
  // common case (CC statement → one owing account) is a single tap.
  onDefaultOwingPick(id: number | null): void {
    this.defaultOwingAccountId.set(id);
    this.drafts.update((list) =>
      list.map((d) =>
        d.type === 'expense' ? { ...d, reservedFromAccountId: id } : d,
      ),
    );
  }

  onRowOwingPick(index: number, id: number | null): void {
    this.updateDraft(index, { reservedFromAccountId: id });
  }

  onNoteChange(index: number, value: string): void {
    this.updateDraft(index, { note: value });
  }

  onCategoryChange(index: number, value: string): void {
    const id = value ? Number(value) : undefined;
    this.updateDraft(index, { suggestedCategoryId: id });
  }

  onCategoryPick(index: number, id: number | null): void {
    this.updateDraft(index, { suggestedCategoryId: id ?? undefined });
  }

  onTransferDirectionChange(index: number, value: 'in' | 'out'): void {
    this.updateDraft(index, { transferDirection: value });
  }

  onTransferAccountChange(index: number, value: string): void {
    const id = value ? Number(value) : undefined;
    this.updateDraft(index, { transferAccountId: id });
  }

  onTransferAccountPick(index: number, id: number | null): void {
    this.updateDraft(index, { transferAccountId: id ?? undefined });
  }

  toggleSkip(index: number): void {
    const current = this.drafts()[index];
    this.updateDraft(index, { skip: !current.skip });
  }

  selectAll(): void {
    this.drafts.update((list) => list.map((d) => ({ ...d, skip: false })));
  }

  skipAll(): void {
    this.drafts.update((list) => list.map((d) => ({ ...d, skip: true })));
  }

  async commit(): Promise<void> {
    if (this.committing() || !this.canCommit() || !this.accountId()) return;
    this.committing.set(true);
    this.errorMessage.set(null);
    await Haptics.impact({ style: ImpactStyle.Medium });
    try {
      await this.bankImport.commit({
        accountId: this.accountId()!,
        drafts: this.drafts(),
      });
      await this.accountService.loadAllAccounts();
      void this.router.navigate(['/transactions']);
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menyimpan transaksi',
      );
    } finally {
      this.committing.set(false);
    }
  }
}
