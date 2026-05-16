import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import {
  IonContent,
  IonRefresher,
  IonRefresherContent,
  RefresherCustomEvent,
} from '@ionic/angular/standalone';
import { AccountService } from '../../../core/services/account.service';
import { AccountType } from '../../../core/models';
import { AccountCardComponent } from '../../../shared/components/account-card/account-card.component';
import { CurrencyFormatPipe } from '../../../shared/pipes/currency-format.pipe';

const TYPE_ORDER: AccountType[] = ['cash', 'bank', 'savings', 'credit'];
const TYPE_LABEL: Record<AccountType, string> = {
  cash: 'Tunai',
  bank: 'Bank',
  savings: 'Tabungan',
  credit: 'Kartu Kredit',
};

@Component({
  selector: 'app-account-list',
  standalone: true,
  imports: [
    AccountCardComponent,
    CurrencyFormatPipe,
    IonContent,
    IonRefresher,
    IonRefresherContent,
  ],
  templateUrl: './account-list.page.html',
})
export class AccountListPage {
  private readonly accountService = inject(AccountService);
  private readonly router = inject(Router);

  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly accounts = this.accountService.allAccounts;

  readonly totalAvailable = computed(() =>
    this.accounts().reduce((sum, a) => sum + Number(a.available_balance), 0),
  );

  readonly totalActual = computed(() =>
    this.accounts().reduce((sum, a) => sum + Number(a.balance), 0),
  );

  readonly totalReserved = computed(() =>
    this.accounts().reduce((sum, a) => sum + Number(a.total_reserved), 0),
  );

  readonly primaryCurrency = computed(
    () => this.accounts()[0]?.currency_code ?? 'IDR',
  );

  readonly grouped = computed(() => {
    const all = this.accounts();
    return TYPE_ORDER.map((type) => ({
      type,
      label: TYPE_LABEL[type],
      accounts: all.filter((a) => a.type === type),
    })).filter((g) => g.accounts.length > 0);
  });

  constructor() {
    void this.refresh();
  }

  ionViewWillEnter(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      await this.accountService.loadAllAccounts();
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal memuat akun',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async onRefresh(event: RefresherCustomEvent): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    try {
      await this.accountService.loadAllAccounts();
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal memuat akun',
      );
    } finally {
      event.target.complete();
    }
  }

  onCardClick(id: number): void {
    void this.router.navigate(['/accounts', id]);
  }

  async onAdd(): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/accounts/new']);
  }
}
