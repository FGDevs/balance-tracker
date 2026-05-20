import { Component, computed, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { AccountService } from '../../../core/services/account.service';
import { CategoryService } from '../../../core/services/category.service';
import {
  BankImportError,
  BankImportService,
} from '../../../core/services/bank-import.service';
import {
  ACCOUNT_TYPE_LABEL,
  Category,
  ImportDraft,
} from '../../../core/models';
import { CurrencyFormatPipe } from '../../../shared/pipes/currency-format.pipe';
import {
  SearchableSelectComponent,
  SearchableSelectOption,
} from '../../../shared/components/searchable-select/searchable-select.component';

type Step = 'account' | 'upload' | 'extracting' | 'review';

@Component({
  selector: 'app-transaction-import',
  standalone: true,
  imports: [IonContent, CurrencyFormatPipe, SearchableSelectComponent],
  templateUrl: './transaction-import.page.html',
})
export class TransactionImportPage {
  private readonly accountService = inject(AccountService);
  private readonly categoryService = inject(CategoryService);
  private readonly bankImport = inject(BankImportService);
  private readonly location = inject(Location);
  private readonly router = inject(Router);

  readonly step = signal<Step>('account');
  readonly accountId = signal<number | null>(null);
  readonly drafts = signal<ImportDraft[]>([]);
  readonly errorMessage = signal<string | null>(null);
  readonly committing = signal(false);

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

  readonly canCommit = computed(
    () => !this.allSkipped() && !this.missingTransferAccount(),
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
    this.updateDraft(index, { date: value });
  }

  onAmountChange(index: number, value: string): void {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      this.updateDraft(index, { amount: num });
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
    });
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
