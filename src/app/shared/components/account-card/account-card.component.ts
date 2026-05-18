import { Component, computed, input, output } from '@angular/core';
import { AccountBalance, AccountType } from '../../../core/models';
import { CurrencyFormatPipe } from '../../pipes/currency-format.pipe';

const TYPE_LABEL: Record<AccountType, string> = {
  cash: 'Tunai',
  bank: 'Bank',
  credit: 'Kartu Kredit',
  savings: 'Tabungan',
};

@Component({
  selector: 'app-account-card',
  standalone: true,
  imports: [CurrencyFormatPipe],
  templateUrl: './account-card.component.html',
})
export class AccountCardComponent {
  readonly account = input.required<AccountBalance>();
  readonly cardClick = output<number>();

  readonly typeLabel = computed(() => TYPE_LABEL[this.account().type]);

  readonly utilization = computed(() => {
    const a = this.account();
    if (a.type !== 'credit' || !a.credit_limit) return 0;
    return Math.min(Math.abs(a.balance) / a.credit_limit, 1);
  });

  readonly utilizationPct = computed(() =>
    Math.round(this.utilization() * 100),
  );

  readonly availableCredit = computed(() => {
    const a = this.account();
    if (a.type !== 'credit' || !a.credit_limit) return 0;
    return a.credit_limit + a.balance;
  });

  readonly utilizationLevel = computed(() => {
    const u = this.utilization();
    if (u >= 0.9) return 'high' as const;
    if (u >= 0.5) return 'mid' as const;
    return 'low' as const;
  });

  readonly hasReservation = computed(
    () => this.account().total_reserved > 0,
  );

  // Hutang chip is shown only for non-credit accounts. Credit cards already
  // surface their debt via the negative `balance`, so a chip would duplicate.
  readonly debtAmount = computed(() => {
    const a = this.account();
    if (a.type === 'credit') return 0;
    return a.total_reserved > 0 ? a.total_reserved : 0;
  });

  // Saldo shortfall: positive when a non-credit account's real balance can't
  // cover its outstanding debt. Surfaces how much top-up is needed.
  readonly shortfallAmount = computed(() => {
    const a = this.account();
    if (a.type === 'credit') return 0;
    const gap = a.total_reserved - a.balance;
    return gap > 0 ? gap : 0;
  });
}
