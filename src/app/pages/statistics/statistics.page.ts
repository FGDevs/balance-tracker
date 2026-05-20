import { Component, computed, effect, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonRefresher, IonRefresherContent } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { AccountService } from '../../core/services/account.service';
import { GroupService } from '../../core/services/group.service';
import { TransactionService } from '../../core/services/transaction.service';
import { ViewerScopeService } from '../../core/services/viewer-scope.service';
import {
  ACCOUNT_TYPE_LABEL,
  CategoryBreakdownEntry,
  ReservationSummaryEntry,
  ViewerScope,
} from '../../core/models';
import { CurrencyFormatPipe } from '../../shared/pipes/currency-format.pipe';
import {
  SearchableSelectComponent,
  SearchableSelectOption,
} from '../../shared/components/searchable-select/searchable-select.component';

type DatePreset = 'this-month' | 'last-month' | 'custom';

const PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'this-month', label: 'Bulan ini' },
  { value: 'last-month', label: 'Bulan lalu' },
  { value: 'custom', label: 'Custom' },
];

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Mei',
  'Jun',
  'Jul',
  'Agu',
  'Sep',
  'Okt',
  'Nov',
  'Des',
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
      return {
        from: ymd(new Date(yyyy, mm, 1)),
        to: ymd(new Date(yyyy, mm + 1, 0)),
      };
    }
    case 'last-month': {
      return {
        from: ymd(new Date(yyyy, mm - 1, 1)),
        to: ymd(new Date(yyyy, mm, 0)),
      };
    }
    case 'custom':
      return { from: ymd(t), to: ymd(t) };
  }
}

function formatLongDate(iso: string): string {
  // iso is YYYY-MM-DD; parse as local-date (no TZ shift)
  const [y, m, d] = iso.split('-').map((s) => Number(s));
  if (!y || !m || !d) return iso;
  return `${d} ${MONTH_LABELS[m - 1]} ${y}`;
}

@Component({
  selector: 'app-statistics',
  standalone: true,
  imports: [
    IonContent,
    IonRefresher,
    IonRefresherContent,
    CurrencyFormatPipe,
    SearchableSelectComponent,
  ],
  templateUrl: './statistics.page.html',
})
export class StatisticsPage {
  private readonly accountService = inject(AccountService);
  private readonly transactionService = inject(TransactionService);
  private readonly viewerScope = inject(ViewerScopeService);
  private readonly groupService = inject(GroupService);
  private readonly location = inject(Location);
  private readonly router = inject(Router);

  readonly presets = PRESETS;

  readonly scope = this.viewerScope.scope;
  readonly scopeOptions: { value: ViewerScope; label: string }[] = [
    { value: 'all', label: 'Semua' },
    { value: 'mine', label: 'Saya' },
    { value: 'others', label: 'Lain' },
  ];

  readonly accounts = computed(() => this.accountService.allAccounts());

  // null = "Semua akun" — passed through to the service.
  readonly accountId = signal<number | null>(null);
  readonly datePreset = signal<DatePreset>('this-month');

  private readonly initialRange = presetRange('this-month');
  readonly dateFrom = signal<string>(this.initialRange.from);
  readonly dateTo = signal<string>(this.initialRange.to);

  readonly breakdown = signal<CategoryBreakdownEntry[]>([]);
  readonly reservations = signal<ReservationSummaryEntry[]>([]);
  readonly loading = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);

  readonly currency = computed(
    () => this.accounts()[0]?.currency_code ?? 'IDR',
  );

  readonly totalExpense = computed(() =>
    this.breakdown().reduce((s, e) => s + e.total, 0),
  );

  readonly totalReserved = computed(() =>
    this.reservations().reduce((s, e) => s + e.totalReserved, 0),
  );

  readonly accountOptions = computed<SearchableSelectOption[]>(() => {
    const me = this.groupService;
    return this.accounts().map((a) => {
      const isForeign = a.created_by !== a.user_id || false;
      const hostName = me.nameFor(a.user_id);
      const showHost = hostName && hostName !== 'Saya';
      return {
        id: a.id,
        label: a.name,
        sublabel: ACCOUNT_TYPE_LABEL[a.type],
        hint: showHost ? hostName! : undefined,
      };
    });
  });

  readonly selectedAccountName = computed(() => {
    const id = this.accountId();
    if (id == null) return null;
    return this.accounts().find((a) => a.id === id)?.name ?? null;
  });

  constructor() {
    void this.bootstrap();

    let firstScopeRun = true;
    effect(() => {
      const _ = this.scope();
      if (firstScopeRun) {
        firstScopeRun = false;
        return;
      }
      void this.fetch();
    });
  }

  private async bootstrap(): Promise<void> {
    if (this.accounts().length === 0) {
      try {
        await this.accountService.loadAllAccounts();
      } catch {
        // surfaced by fetch below
      }
    }
    if (!this.groupService.myMemberships().length && !this.groupService.myMembers().length) {
      // best-effort hydration for foreign-host names in the picker
      try {
        await this.groupService.loadAll();
      } catch {
        // hostname annotation is optional — fail silent
      }
    }
    await this.fetch();
  }

  goBack(): void {
    this.location.back();
  }

  async refresh(event: CustomEvent): Promise<void> {
    try {
      await this.fetch();
    } finally {
      (event.target as HTMLIonRefresherElement).complete();
    }
  }

  // ── Filters ─────────────────────────────────────────────────────────────

  async setScope(next: ViewerScope): Promise<void> {
    if (this.scope() === next) return;
    await Haptics.impact({ style: ImpactStyle.Light });
    this.viewerScope.set(next);
  }

  async onAccountChange(id: number | null): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.accountId.set(id);
    await this.fetch();
  }

  async pickPreset(p: DatePreset): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.datePreset.set(p);
    if (p !== 'custom') {
      const r = presetRange(p);
      this.dateFrom.set(r.from);
      this.dateTo.set(r.to);
    }
    await this.fetch();
  }

  async onDateFromChange(value: string): Promise<void> {
    if (!value) return;
    this.dateFrom.set(value);
    await this.fetch();
  }

  async onDateToChange(value: string): Promise<void> {
    if (!value) return;
    this.dateTo.set(value);
    await this.fetch();
  }

  openOwingAccount(accountId: number): void {
    void Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/accounts', accountId]);
  }

  formatDate(iso: string): string {
    return formatLongDate(iso);
  }

  sharePercent(share: number): string {
    return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
  }

  // ── Fetching ─────────────────────────────────────────────────────────────

  private async fetch(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const [bd, res] = await Promise.all([
        this.transactionService.getCategoryBreakdown({
          from: this.dateFrom(),
          to: this.dateTo(),
          accountId: this.accountId(),
        }),
        this.transactionService.getReservationSummary({
          accountId: this.accountId(),
        }),
      ]);
      this.breakdown.set(bd);
      this.reservations.set(res);
    } catch (err) {
      this.breakdown.set([]);
      this.reservations.set([]);
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal memuat statistik',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
