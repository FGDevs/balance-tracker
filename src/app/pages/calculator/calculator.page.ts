import { Component, computed, effect, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { IonContent, IonModal } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { AccountService } from '../../core/services/account.service';
import { TransactionService } from '../../core/services/transaction.service';
import { ViewerScopeService } from '../../core/services/viewer-scope.service';
import { Transaction, ViewerScope } from '../../core/models';
import { CurrencyFormatPipe } from '../../shared/pipes/currency-format.pipe';

type Op = '+' | '-' | '*' | '/';

// Tokens drive the expression. NumToken.source hydrates the small chip under
// the expression line: 'tx' for transaction picks, 'balance' for account-saldo
// picks. Undefined for manually-typed operands.
type NumSource =
  | { kind: 'tx'; txId: number; date: string; accountName: string }
  | { kind: 'balance'; accountId: number; accountName: string };

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

// Two-pass left-to-right evaluator: collapse * and / first, then + and -.
// Tokens are alternating num/op (we enforce that at input time); if the trailing
// token is an operator, we evaluate the prefix and ignore the dangling op.
function evaluate(tokens: Token[]): number | null {
  if (tokens.length === 0) return null;
  const trimmed: Token[] =
    tokens[tokens.length - 1]?.kind === 'op' ? tokens.slice(0, -1) : tokens;
  if (trimmed.length === 0) return null;
  if (trimmed[0].kind !== 'num') return null;

  // First pass: * and /
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

  // Second pass: + and -
  let acc = (stack[0] as NumToken).value;
  for (let i = 1; i < stack.length; i += 2) {
    const op = (stack[i] as OpToken).op;
    const rhs = (stack[i + 1] as NumToken).value;
    acc = op === '+' ? acc + rhs : acc - rhs;
  }
  return Number.isFinite(acc) ? acc : null;
}

@Component({
  selector: 'app-calculator',
  standalone: true,
  imports: [IonContent, IonModal, CurrencyFormatPipe],
  templateUrl: './calculator.page.html',
})
export class CalculatorPage {
  private readonly accountService = inject(AccountService);
  private readonly transactionService = inject(TransactionService);
  private readonly viewerScope = inject(ViewerScopeService);
  private readonly location = inject(Location);

  readonly presets = PRESETS;
  readonly opGlyph = OP_GLYPH;

  // ── Expression state ─────────────────────────────────────────────────────
  // tokens[] = finalized operands and operators.
  // buffer holds the digits being typed into the next operand (string for
  // leading-zero handling). Empty buffer means "no operand under construction".
  readonly tokens = signal<Token[]>([]);
  readonly buffer = signal<string>('');

  readonly bufferNumber = computed(() => {
    const b = this.buffer();
    if (!b) return null;
    const n = Number(b);
    return Number.isFinite(n) ? n : null;
  });

  // Live evaluation: tokens + buffer (if any) folded into a tentative token list.
  readonly liveResult = computed(() => {
    const list = [...this.tokens()];
    const buf = this.bufferNumber();
    if (buf != null) list.push({ kind: 'num', value: buf });
    return evaluate(list);
  });

  // The expression to render. We append the buffer (if present) as a pseudo
  // token so the display matches what the live result is computed over.
  readonly displayTokens = computed<Token[]>(() => {
    const list = [...this.tokens()];
    const buf = this.bufferNumber();
    if (buf != null) list.push({ kind: 'num', value: buf });
    return list;
  });

  readonly hasContent = computed(
    () => this.tokens().length > 0 || this.buffer().length > 0,
  );

  // ── Picker filter state (lives on the page so it survives modal close) ──
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

  goBack(): void {
    this.location.back();
  }

  // ── Keypad actions ──────────────────────────────────────────────────────

  async tapDigit(d: string): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Light });
    this.buffer.update((b) => {
      if (b === '' && d === '0') return '0';
      if (b === '0') return d; // replace leading zero
      return b + d;
    });
  }

  // Commit the current buffer as a num token, then push the operator. If the
  // last token is already an operator (and no buffer), replace it — lets the
  // user fix a typo like `5 + −` → `5 −`.
  async tapOperator(op: Op): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Light });
    const buf = this.bufferNumber();
    this.tokens.update((list) => {
      const next = [...list];
      if (buf != null) {
        next.push({ kind: 'num', value: buf });
      }
      const last = next[next.length - 1];
      if (!last) return next;
      if (last.kind === 'op') {
        // Replace trailing operator if no new operand was added.
        next[next.length - 1] = { kind: 'op', op };
        return next;
      }
      next.push({ kind: 'op', op });
      return next;
    });
    this.buffer.set('');
  }

  async tapEquals(): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Medium });
    const result = this.liveResult();
    if (result == null) return;
    this.tokens.set([{ kind: 'num', value: Math.round(result * 100) / 100 }]);
    this.buffer.set('');
  }

  async tapBackspace(): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Light });
    if (this.buffer().length > 0) {
      this.buffer.update((b) => b.slice(0, -1));
      return;
    }
    // Buffer empty → drop the last token. If it was a num sourced from a tx,
    // it goes as one unit (no half-amount editing).
    this.tokens.update((list) =>
      list.length > 0 ? list.slice(0, -1) : list,
    );
  }

  async tapClear(): Promise<void> {
    void Haptics.impact({ style: ImpactStyle.Medium });
    this.tokens.set([]);
    this.buffer.set('');
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

  // Direction → sign. Income / incoming-transfer = +, expense / outgoing-
  // transfer = −. Mirrors the old tally page's isIncoming() rule.
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

  // Tx → operand + (implicit operator if expression already ends in num).
  // Rule: if the trailing position expects an operator AND the signed amount
  // is negative, we insert `−` followed by the absolute value (visually `5 − 200`,
  // not `5 + −200`). If positive in that position, insert `+` then the value.
  // When the expression is empty or ends with an operator, push as-is (signed).
  async pickTransaction(tx: Transaction): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Medium });
    const signed = this.signedAmount(tx);
    const source: NumSource = {
      kind: 'tx',
      txId: tx.id,
      date: tx.date,
      accountName: tx.account?.name ?? '—',
    };
    this.insertSignedNum(signed, source);
    this.closePicker();
  }

  async pickAccountBalance(accountId: number): Promise<void> {
    const account = this.accounts().find((a) => a.id === accountId);
    if (!account) return;
    await Haptics.impact({ style: ImpactStyle.Medium });
    const source: NumSource = {
      kind: 'balance',
      accountId: account.id,
      accountName: account.name,
    };
    this.insertSignedNum(account.balance, source);
    this.closeAccountPicker();
  }

  // Shared insert path for tx and balance picks. If the trailing position
  // expects an operator (previous token is a num), auto-prepend `+` or `−`
  // based on sign and store the absolute value; otherwise store the signed
  // value directly. Either way, attach the source annotation.
  private insertSignedNum(signed: number, source: NumSource): void {
    const bufNum = this.bufferNumber();
    this.tokens.update((list) => {
      const next = [...list];
      if (bufNum != null) next.push({ kind: 'num', value: bufNum });
      const last = next[next.length - 1];
      const expectsOperator = last?.kind === 'num';
      if (expectsOperator) {
        const op: Op = signed < 0 ? '-' : '+';
        next.push({ kind: 'op', op });
        next.push({ kind: 'num', value: Math.abs(signed), source });
      } else {
        next.push({ kind: 'num', value: signed, source });
      }
      return next;
    });
    this.buffer.set('');
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
