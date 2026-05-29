import {
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  IonContent,
  IonRefresher,
  IonRefresherContent,
  RefresherCustomEvent,
} from '@ionic/angular/standalone';
import { AccountService } from '../../core/services/account.service';
import { AuthService } from '../../core/services/auth.service';
import { ViewerScopeService } from '../../core/services/viewer-scope.service';
import { SavingsVisibilityService } from '../../core/services/savings-visibility.service';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { ViewerScope } from '../../core/models';
import { AccountCardComponent } from '../../shared/components/account-card/account-card.component';
import { CurrencyFormatPipe } from '../../shared/pipes/currency-format.pipe';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    AccountCardComponent,
    CurrencyFormatPipe,
    IonContent,
    IonRefresher,
    IonRefresherContent,
    RouterLink,
  ],
  templateUrl: './dashboard.page.html',
})
export class DashboardPage implements OnInit {
  private accountService = inject(AccountService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private viewerScope = inject(ViewerScopeService);
  private savingsVisibility = inject(SavingsVisibilityService);

  // Raw accounts from the service (used for the "Akun aktif · N" label so the
  // count reflects what actually exists).
  readonly allAccounts = this.accountService.accounts;
  // Saldo total / debt chip / grid all key off this filtered view. When the
  // user toggles tabungan off, savings accounts disappear from those surfaces.
  readonly accounts = computed(() =>
    this.savingsVisibility.include()
      ? this.allAccounts()
      : this.allAccounts().filter((a) => a.type !== 'savings'),
  );
  readonly includeSavings = this.savingsVisibility.include;
  readonly hasSavings = computed(() =>
    this.allAccounts().some((a) => a.type === 'savings'),
  );
  readonly scope = this.viewerScope.scope;
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly scopeOptions: { value: ViewerScope; label: string }[] = [
    { value: 'all', label: 'Semua' },
    { value: 'mine', label: 'Saya' },
    { value: 'others', label: 'Lain' },
  ];

  setScope(next: ViewerScope): void {
    if (this.scope() === next) return;
    this.viewerScope.set(next);
  }

  async toggleSavings(): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.savingsVisibility.toggle();
  }

  constructor() {
    // Reload accounts when scope changes (ngOnInit already covers initial load).
    let firstRun = true;
    effect(() => {
      const _ = this.scope();
      if (firstRun) {
        firstRun = false;
        return;
      }
      void this.load();
    });
  }

  readonly totalActual = computed(() =>
    this.accounts().reduce((sum, a) => sum + a.balance, 0),
  );

  readonly totalDebt = computed(() =>
    this.accounts().reduce((sum, a) => {
      if (a.type === 'credit') return sum + (a.balance < 0 ? Math.abs(a.balance) : 0);
      return sum + (a.total_reserved > 0 ? a.total_reserved : 0);
    }, 0),
  );

  readonly currency = computed(
    () => this.accounts()[0]?.currency_code ?? 'IDR',
  );

  readonly userFirstName = computed(() => {
    const meta = this.auth.currentUser()?.user_metadata as
      | { name?: string }
      | undefined;
    const full = meta?.name?.trim();
    if (full) return full.split(/\s+/)[0];
    const email = this.auth.currentUser()?.email;
    return email ? email.split('@')[0] : 'di sana';
  });

  readonly timeOfDay = computed(() => {
    const h = new Date().getHours();
    if (h < 11) return 'pagi';
    if (h < 15) return 'siang';
    if (h < 18) return 'sore';
    return 'malam';
  });

  readonly editionLabel = computed(() => {
    const d = new Date();
    const date = new Intl.DateTimeFormat('id-ID', {
      day: '2-digit',
      month: '2-digit',
    }).format(d);
    const day = new Intl.DateTimeFormat('id-ID', {
      weekday: 'long',
    })
      .format(d)
      .toUpperCase();
    return `Edisi ${date} · ${day}`;
  });

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async refresh(event: RefresherCustomEvent): Promise<void> {
    await this.load();
    await event.target.complete();
  }

  async openAccount(id: number): Promise<void> {
    await this.router.navigateByUrl(`/accounts/${id}`);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      await this.accountService.loadAccounts();
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal memuat akun',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
