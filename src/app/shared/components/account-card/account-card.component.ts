import { Component, computed, inject, input, output, signal } from '@angular/core';
import { ACCOUNT_TYPE_LABEL, AccountBalance } from '../../../core/models';
import { AuthService } from '../../../core/services/auth.service';
import { GroupService } from '../../../core/services/group.service';
import { CurrencyFormatPipe } from '../../pipes/currency-format.pipe';

@Component({
  selector: 'app-account-card',
  standalone: true,
  imports: [CurrencyFormatPipe],
  templateUrl: './account-card.component.html',
})
export class AccountCardComponent {
  private readonly auth = inject(AuthService);
  private readonly groups = inject(GroupService);

  readonly account = input.required<AccountBalance>();
  readonly cardClick = output<number>();

  readonly typeLabel = computed(() => ACCOUNT_TYPE_LABEL[this.account().type]);

  // §13 — foreign-owner annotation. When this account lives in another
  // host's group, show their display name next to the account name.
  // Hidden for the user's own accounts and when the host's profile hasn't
  // loaded yet.
  readonly foreignOwnerName = computed(() => {
    const a = this.account();
    const me = this.auth.currentUser()?.id;
    if (!me || a.user_id === me) return null;
    return this.groups.nameFor(a.user_id);
  });

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

  readonly shortfallPopoverOpen = signal(false);

  toggleShortfallPopover(event: Event): void {
    event.stopPropagation();
    this.shortfallPopoverOpen.update((v) => !v);
  }

  closeShortfallPopover(): void {
    this.shortfallPopoverOpen.set(false);
  }

  onCardKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.cardClick.emit(this.account().id);
    }
  }
}
