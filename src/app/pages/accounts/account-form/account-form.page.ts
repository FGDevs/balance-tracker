import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { IonContent, IonModal } from '@ionic/angular/standalone';
import { Account, AccountType } from '../../../core/models';
import { AccountService } from '../../../core/services/account.service';

const COLOR_PRESETS = [
  '#d97a3c',
  '#e9b067',
  '#3a6a9a',
  '#2f7a3d',
  '#b54a3c',
  '#6b4f3a',
];

const TYPE_LABEL: Record<AccountType, string> = {
  cash: 'Tunai',
  bank: 'Bank',
  credit: 'Kartu Kredit',
  savings: 'Tabungan',
};

interface TypeOption {
  value: AccountType;
  label: string;
}

@Component({
  selector: 'app-account-form',
  standalone: true,
  imports: [IonContent, IonModal],
  templateUrl: './account-form.page.html',
})
export class AccountFormPage implements OnInit {
  private accountService = inject(AccountService);
  private router = inject(Router);
  private location = inject(Location);

  readonly id = input<string | undefined>(undefined);

  readonly colorPresets = COLOR_PRESETS;
  readonly typeOptions: TypeOption[] = [
    { value: 'cash', label: 'Tunai' },
    { value: 'bank', label: 'Bank' },
    { value: 'savings', label: 'Tabungan' },
    { value: 'credit', label: 'Kartu Kredit' },
  ];

  readonly name = signal('');
  readonly type = signal<AccountType>('bank');
  readonly balance = signal<number | null>(0);
  readonly currencyCode = signal('IDR');
  readonly color = signal<string>(COLOR_PRESETS[0]);
  readonly creditLimit = signal<number | null>(null);
  readonly statementDay = signal<number | null>(null);
  readonly paymentDueDay = signal<number | null>(null);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly deleting = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly showDeleteConfirm = signal(false);

  readonly isEdit = computed(() => this.id() !== undefined);
  readonly accountId = computed(() =>
    this.id() !== undefined ? Number(this.id()) : null,
  );
  readonly isCredit = computed(() => this.type() === 'credit');
  readonly typeLabel = computed(() => TYPE_LABEL[this.type()]);

  readonly canSubmit = computed(() => {
    if (!this.name().trim()) return false;
    if (this.currencyCode().trim().length !== 3) return false;
    if (!this.isEdit() && this.balance() === null) return false;
    if (this.isCredit()) {
      const cl = this.creditLimit();
      if (cl === null || cl <= 0) return false;
      if (!this.isDayValid(this.statementDay())) return false;
      if (!this.isDayValid(this.paymentDueDay())) return false;
    }
    return true;
  });

  async ngOnInit(): Promise<void> {
    if (!this.isEdit()) return;
    await this.loadExisting();
  }

  asValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  asNumber(event: Event): number | null {
    const raw = this.asValue(event).trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  private isDayValid(day: number | null): boolean {
    if (day === null) return true;
    return Number.isInteger(day) && day >= 1 && day <= 31;
  }

  selectType(t: AccountType): void {
    if (this.isEdit()) return;
    this.type.set(t);
  }

  selectColor(c: string): void {
    this.color.set(c);
    void Haptics.impact({ style: ImpactStyle.Light });
  }

  goBack(): void {
    this.location.back();
  }

  private async loadExisting(): Promise<void> {
    const id = this.accountId();
    if (id === null) return;

    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      let account = this.accountService.getById(id);
      if (!account) {
        await this.accountService.loadAccounts();
        account = this.accountService.getById(id);
      }
      if (!account) throw new Error('Akun tidak ditemukan');

      this.name.set(account.name);
      this.type.set(account.type);
      this.balance.set(account.balance);
      this.currencyCode.set(account.currency_code);
      this.color.set(account.color ?? COLOR_PRESETS[0]);
      this.creditLimit.set(account.credit_limit ?? null);
      // this.statementDay.set(account.statement_day ?? null);
      // this.paymentDueDay.set(account.payment_due_day ?? null);
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal memuat akun',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit() || this.saving()) return;

    this.saving.set(true);
    this.errorMessage.set(null);
    await Haptics.impact({ style: ImpactStyle.Light });

    try {
      const creditFields = this.isCredit()
        ? {
            credit_limit: this.creditLimit() ?? undefined,
            // statement_day: this.statementDay() ?? undefined,
            // payment_due_day: this.paymentDueDay() ?? undefined,
          }
        : {
            credit_limit: undefined,
            // statement_day: undefined,
            // payment_due_day: undefined,
          };

      if (this.isEdit()) {
        const update: Partial<Account> = {
          name: this.name().trim(),
          color: this.color(),
          ...creditFields,
        };
        await this.accountService.update(this.accountId()!, update);
      } else {
        await this.accountService.create({
          name: this.name().trim(),
          type: this.type(),
          balance: this.balance() ?? 0,
          currency_code: this.currencyCode().trim().toUpperCase(),
          color: this.color(),
          ...creditFields,
        });
      }

      await Haptics.notification({ type: NotificationType.Success });
      await this.accountService.loadAccounts();
      await this.router.navigateByUrl('/accounts');
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menyimpan',
      );
    } finally {
      this.saving.set(false);
    }
  }

  openDeleteConfirm(): void {
    if (!this.isEdit() || this.deleting() || this.saving()) return;
    void Haptics.impact({ style: ImpactStyle.Medium });
    this.showDeleteConfirm.set(true);
  }

  closeDeleteConfirm(): void {
    this.showDeleteConfirm.set(false);
  }

  async onConfirmDelete(): Promise<void> {
    this.closeDeleteConfirm();
    await this.delete();
  }

  private async delete(): Promise<void> {
    const id = this.accountId();
    if (id === null) return;

    this.deleting.set(true);
    this.errorMessage.set(null);
    await Haptics.impact({ style: ImpactStyle.Medium });

    try {
      await this.accountService.softDelete(id);
      await Haptics.notification({ type: NotificationType.Success });
      await this.accountService.loadAccounts();
      await this.router.navigateByUrl('/accounts');
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menghapus',
      );
    } finally {
      this.deleting.set(false);
    }
  }
}
