import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IonModal } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { AccountService } from '../../../core/services/account.service';
import { TransactionService } from '../../../core/services/transaction.service';
import { ViewerScopeService } from '../../../core/services/viewer-scope.service';
import {
  ReservationPairEntry,
  Transaction,
  ViewerScope,
} from '../../../core/models';
import { CurrencyFormatPipe } from '../../../shared/pipes/currency-format.pipe';

type Op = '+' | '-' | '*' | '/';

type NumSource =
  | { kind: 'tx'; txId: number; date: string; accountName: string }
  | { kind: 'balance'; accountId: number; accountName: string }
  | { kind: 'debt'; owingName: string; creditorName: string };

interface NumToken {
  kind: 'num';
  value: number;
  source?: NumSource;
}
interface OpToken {
  kind: 'op';
  op: Op;
}
type Token = NumToken | OpToken;

type DatePreset = 'this-month' | 'last-month' | 'last-30' | 'custom';

const PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'this-month', label: 'Bulan ini' },
  { value: 'last-month', label: 'Bulan lalu' },
  { value: 'last-30', label: '30 hari' },
  { value: 'custom', label: 'Custom' },
];

const OP_GLYPH: Record<Op, string> = {
  '+': '+',
  '-': '−',
  '*': '×',
  '/': '÷',
};

const GROUP_FMT = new Intl.NumberFormat('id-ID');

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function presetRange(
  preset: DatePreset,
  today = new Date(),
): { from: string; to: string } {
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

function evaluate(tokens: Token[]): number | null {
  if (tokens.length === 0) return null;
  const trimmed: Token[] =
    tokens[tokens.length - 1]?.kind === 'op' ? tokens.slice(0, -1) : tokens;
  if (trimmed.length === 0) return null;
  if (trimmed[0].kind !== 'num') return null;

  const stack: Token[] = [trimmed[0]];
  for (let i = 1; i < trimmed.length; i += 2) {
    const op = trimmed[i] as OpToken;
    const rhs = trimmed[i + 1] as NumToken | undefined;
    if (!rhs || rhs.kind !== 'num') return null;
    if (op.op === '*' || op.op === '/') {
      const lhs = stack[stack.length - 1] as NumToken;
      const next =
        op.op === '*'
          ? lhs.value * rhs.value
          : rhs.value === 0
            ? NaN
            : lhs.value / rhs.value;
      stack[stack.length - 1] = { kind: 'num', value: next };
    } else {
      stack.push(op, rhs);
    }
  }

  let acc = (stack[0] as NumToken).value;
  for (let i = 1; i < stack.length; i += 2) {
    const op = (stack[i] as OpToken).op;
    const rhs = (stack[i + 1] as NumToken).value;
    acc = op === '+' ? acc + rhs : acc - rhs;
  }
  return Number.isFinite(acc) ? acc : null;
}

// Shared calculator engine + UI. Used standalone on /calculator (showApply=false)
// and inside CalcButton's modal (showApply=true, emits `apply` to seed an input).
@Component({
  selector: 'app-calc-pad',
  standalone: true,
  imports: [IonModal, CurrencyFormatPipe],
  templateUrl: './calc-pad.component.html',
})
export class CalcPadComponent {
  private readonly accountService = inject(AccountService);
  private readonly transactionService = inject(TransactionService);
  private readonly viewerScope = inject(ViewerScopeService);

  // Seed the screen buffer with this value on first non-null binding (typical:
  // existing input amount when the modal opens). Re-opens get a fresh component.
  readonly initialValue = input<number | null | undefined>(null);
  // Show the bottom "Gunakan" footer that emits the current result via `apply`.
  readonly showApply = input(false);
  readonly applyLabel = input('Gunakan');
  // When false (default), the pad behaves as a magnitude calculator: negative
  // initial values seed as their absolute, and negative results are abs'd on
  // apply. Used by amount fields (transaction/settlement/import). Set true for
  // signed fields (account-form balance), where credit-card debt is negative.
  readonly allowNegative = input(false);

  readonly apply = output<number>();

  readonly presets = PRESETS;
  readonly opGlyph = OP_GLYPH;

  private readonly exprLine =
    viewChild<ElementRef<HTMLDivElement>>('exprLine');

  readonly tokens = signal<Token[]>([]);
  readonly buffer = signal<string>('');
  readonly bufferSource = signal<NumSource | null>(null);
  readonly justEvaluated = signal<boolean>(false);

  readonly bufferNumber = computed(() => {
    const b = this.buffer();
    if (!b) return null;
    const n = Number(b);
    return Number.isFinite(n) ? n : null;
  });

  readonly screenValue = computed(() => {
    const b = this.buffer();
    if (!b) return '';
    const n = Number(b);
    return Number.isFinite(n) ? GROUP_FMT.format(n) : b;
  });

  readonly liveResult = computed(() => {
    const list = [...this.tokens()];
    const buf = this.bufferNumber();
    if (buf != null) list.push({ kind: 'num', value: buf });
    return evaluate(list);
  });

  // Picker filter state (lives on the component so it survives modal close).
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
  readonly loadingTxs = signal<boolean>(false);
  readonly txError = signal<string | null>(null);
  readonly capReached = computed(
    () => this.transactions().length >= TransactionService.CALCULATOR_CAP,
  );

  readonly pickerOpen = signal<boolean>(false);
  readonly accountPickerOpen = signal<boolean>(false);
  readonly debtPickerOpen = signal<boolean>(false);

  readonly reservationPairs = signal<ReservationPairEntry[]>([]);
  readonly loadingPairs = signal<boolean>(false);
  readonly pairsError = signal<string | null>(null);

  readonly currency = computed(
    () => this.accounts()[0]?.currency_code ?? 'IDR',
  );

  constructor() {
    void this.bootstrap();
    let firstScopeRun = true;
    effect(() => {
      const _ = this.scope();
      if (firstScopeRun) {
        firstScopeRun = false;
        return;
      }
      if (this.pickerOpen()) void this.fetchTxs();
    });
    effect(() => {
      const _ = this.tokens();
      const el = this.exprLine()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollLeft = el.scrollWidth));
    });
    // Seed the screen with the parent-provided initial value once. Skipped for
    // null/undefined/zero so the placeholder still shows for empty fields.
    let seeded = false;
    effect(() => {
      if (seeded) return;
      const v = this.initialValue();
      if (v == null || !Number.isFinite(v) || v === 0) return;
      seeded = true;
      const signed = this.allowNegative() ? v : Math.abs(v);
      this.buffer.set(String(Math.round(signed)));
    });
  }

  private async bootstrap(): Promise<void> {
    if (this.accounts().length === 0) {
      try {
        await this.accountService.loadAllAccounts();
      } catch {
        // surfaced from fetchTxs() when picker opens
      }
    }
  }

  // ── Keypad / screen actions ───────────────────────────────────────────────

  async tapDigit(d: string): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Light });
    if (this.justEvaluated()) {
      this.justEvaluated.set(false);
      this.bufferSource.set(null);
      this.buffer.set(d === '0' ? '0' : d);
      return;
    }
    this.bufferSource.set(null);
    this.buffer.update((b) => {
      if (b === '' && d === '0') return '0';
      if (b === '0') return d;
      return b + d;
    });
  }

  async tapOperator(op: Op): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Light });
    this.commitBuffer();
    this.justEvaluated.set(false);
    this.tokens.update((list) => {
      const next = [...list];
      const last = next[next.length - 1];
      if (!last) return next;
      if (last.kind === 'op') {
        next[next.length - 1] = { kind: 'op', op };
        return next;
      }
      next.push({ kind: 'op', op });
      return next;
    });
  }

  async tapEquals(): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Medium });
    const result = this.liveResult();
    if (result == null) return;
    this.tokens.set([]);
    this.bufferSource.set(null);
    this.buffer.set(String(Math.round(result * 100) / 100));
    this.justEvaluated.set(true);
  }

  async tapBackspace(): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Light });
    this.justEvaluated.set(false);
    if (this.buffer().length > 0) {
      this.bufferSource.set(null);
      this.buffer.update((b) => b.slice(0, -1));
      return;
    }
    this.tokens.update((list) => (list.length > 0 ? list.slice(0, -1) : list));
  }

  async tapClear(): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Medium });
    this.tokens.set([]);
    this.buffer.set('');
    this.bufferSource.set(null);
    this.justEvaluated.set(false);
  }

  async tapApply(): Promise<void> {
    const result = this.liveResult();
    if (result == null) return;
    void Haptics.impact({ style: ImpactStyle.Medium });
    const signed = this.allowNegative() ? result : Math.abs(result);
    this.apply.emit(Math.round(signed));
  }

  private commitBuffer(): void {
    const n = this.bufferNumber();
    if (n == null) return;
    const source = this.bufferSource() ?? undefined;
    this.tokens.update((list) => [...list, { kind: 'num', value: n, source }]);
    this.buffer.set('');
    this.bufferSource.set(null);
  }

  // ── Device-keyboard handlers on the screen <input> ────────────────────────

  onScreenInput(event: Event): void {
    const el = event.target as HTMLInputElement;
    const digits = el.value.replace(/\D/g, '');
    this.justEvaluated.set(false);
    this.bufferSource.set(null);
    this.buffer.set(digits);
    const formatted = digits ? GROUP_FMT.format(Number(digits)) : '';
    el.value = formatted;
    try {
      el.setSelectionRange(formatted.length, formatted.length);
    } catch {
      // some input types disallow selection range; ignore
    }
  }

  onScreenKey(event: KeyboardEvent): void {
    const k = event.key;
    if (k === '+' || k === '-' || k === '*' || k === '/') {
      event.preventDefault();
      void this.tapOperator(k);
      return;
    }
    if (k === 'x' || k === 'X') {
      event.preventDefault();
      void this.tapOperator('*');
      return;
    }
    if (k === 'Enter' || k === '=') {
      event.preventDefault();
      void this.tapEquals();
      return;
    }
    if (k === 'Escape') {
      event.preventDefault();
      void this.tapClear();
      return;
    }
    if (k === 'Backspace') {
      if (this.buffer().length === 0) {
        event.preventDefault();
        void this.tapBackspace();
      }
      return;
    }
    if (k.length === 1 && !/\d/.test(k)) event.preventDefault();
  }

  onKeypadPointerDown(event: Event): void {
    event.preventDefault();
  }

  // ── Tx picker ───────────────────────────────────────────────────────────

  async openPicker(): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.pickerOpen.set(true);
    void this.fetchTxs();
  }

  closePicker(): void {
    this.pickerOpen.set(false);
  }

  async openAccountPicker(): Promise<void> {
    if (this.accounts().length === 0) {
      try {
        await this.accountService.loadAllAccounts();
      } catch {
        // surfaced in the empty state when the list is empty
      }
    }
    await Haptics.impact({ style: ImpactStyle.Light });
    this.accountPickerOpen.set(true);
  }

  closeAccountPicker(): void {
    this.accountPickerOpen.set(false);
  }

  async openDebtPicker(): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.debtPickerOpen.set(true);
    void this.fetchPairs();
  }

  closeDebtPicker(): void {
    this.debtPickerOpen.set(false);
  }

  private async fetchPairs(): Promise<void> {
    this.loadingPairs.set(true);
    this.pairsError.set(null);
    try {
      this.reservationPairs.set(
        await this.transactionService.getReservationPairs(),
      );
    } catch (err) {
      this.reservationPairs.set([]);
      this.pairsError.set(
        err instanceof Error ? err.message : 'Gagal memuat hutang',
      );
    } finally {
      this.loadingPairs.set(false);
    }
  }

  private isIncoming(tx: Transaction): boolean {
    if (tx.type === 'income') return true;
    if (tx.type === 'transfer') {
      return tx.transfer_pair_id != null && tx.transfer_pair_id < tx.id;
    }
    return false;
  }

  signedAmount(tx: Transaction): number {
    return this.isIncoming(tx) ? tx.amount : -tx.amount;
  }

  private fillOperand(value: number, source: NumSource): void {
    this.buffer.set(String(Math.round(Math.abs(value))));
    this.bufferSource.set(source);
    this.justEvaluated.set(false);
  }

  async pickTransaction(tx: Transaction): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Medium });
    this.fillOperand(tx.amount, {
      kind: 'tx',
      txId: tx.id,
      date: tx.date,
      accountName: tx.account?.name ?? '—',
    });
    this.closePicker();
  }

  async pickAccountBalance(accountId: number): Promise<void> {
    const account = this.accounts().find((a) => a.id === accountId);
    if (!account) return;
    await Haptics.impact({ style: ImpactStyle.Medium });
    this.fillOperand(account.balance, {
      kind: 'balance',
      accountId: account.id,
      accountName: account.name,
    });
    this.closeAccountPicker();
  }

  async pickDebtPair(pair: ReservationPairEntry): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Medium });
    this.fillOperand(pair.totalReserved, {
      kind: 'debt',
      owingName: pair.owing.name,
      creditorName: pair.creditor.name,
    });
    this.closeDebtPicker();
  }

  // ── Picker filters ──────────────────────────────────────────────────────

  async setScope(next: ViewerScope): Promise<void> {
    if (this.scope() === next) return;
    await Haptics.impact({ style: ImpactStyle.Light });
    this.viewerScope.set(next);
  }

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
    await this.fetchTxs();
  }

  async toggleAccount(id: number): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    const current = this.accountFilter();
    let next: number[];
    if (current === 'all') next = [id];
    else if (current.includes(id)) next = current.filter((x) => x !== id);
    else next = [...current, id];
    this.accountFilter.set(next.length === 0 ? 'all' : next);
    await this.fetchTxs();
  }

  async pickPreset(p: DatePreset): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.datePreset.set(p);
    if (p !== 'custom') {
      const r = presetRange(p);
      this.dateFrom.set(r.from);
      this.dateTo.set(r.to);
    }
    await this.fetchTxs();
  }

  async onDateFromChange(value: string): Promise<void> {
    if (!value) return;
    this.dateFrom.set(value);
    await this.fetchTxs();
  }

  async onDateToChange(value: string): Promise<void> {
    if (!value) return;
    this.dateTo.set(value);
    await this.fetchTxs();
  }

  private async fetchTxs(): Promise<void> {
    this.loadingTxs.set(true);
    this.txError.set(null);
    try {
      const rows = await this.transactionService.getForCalculator({
        accountIds: this.accountFilter(),
        dateFrom: this.dateFrom(),
        dateTo: this.dateTo(),
      });
      this.transactions.set(rows);
    } catch (err) {
      this.transactions.set([]);
      this.txError.set(
        err instanceof Error ? err.message : 'Gagal memuat transaksi',
      );
    } finally {
      this.loadingTxs.set(false);
    }
  }
}
