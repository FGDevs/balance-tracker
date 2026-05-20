import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { IonRouterOutlet } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { filter, map } from 'rxjs';
import { AccountService } from '../core/services/account.service';
import { AuthService } from '../core/services/auth.service';
import { GroupService } from '../core/services/group.service';

type Tab = 'dashboard' | 'accounts' | 'transactions' | 'profile';

const TOP_LEVEL: ReadonlySet<string> = new Set([
  '/dashboard',
  '/accounts',
  '/transactions',
  '/profile',
]);

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [IonRouterOutlet, RouterLink],
  templateUrl: './app-shell.component.html',
})
export class AppShellComponent {
  private router = inject(Router);
  private auth = inject(AuthService);
  private groups = inject(GroupService);
  private accounts = inject(AccountService);

  // Auto-bind on login: claim any pending group invitations addressed to
  // this user's email, then load group membership data (so foreign-author
  // annotations have names to display) and refresh accounts. Runs once per
  // session boot. §13.5.
  private claimedThisSession = false;
  private readonly _autoBind = effect(async () => {
    const uid = this.auth.currentUser()?.id;
    if (!uid || this.claimedThisSession) return;
    this.claimedThisSession = true;
    const claimed = await this.groups.claimPendingInvitations();
    await this.groups.loadAll();
    if (claimed > 0) {
      await this.accounts.loadAccounts();
      await this.accounts.loadAllAccounts();
    }
  });

  readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => (e as NavigationEnd).urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  readonly showBar = computed(() => {
    const url = this.stripQuery(this.currentUrl());
    return TOP_LEVEL.has(url);
  });

  readonly activeTab = computed<Tab | null>(() => {
    const url = this.stripQuery(this.currentUrl());
    if (url.startsWith('/dashboard')) return 'dashboard';
    if (url.startsWith('/accounts')) return 'accounts';
    if (url.startsWith('/transactions')) return 'transactions';
    if (url.startsWith('/profile')) return 'profile';
    return null;
  });

  readonly fabExpanded = signal(false);
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired = false;

  // Stagger choreography: opening blooms bottom→top (index 3 first, index 0 last);
  // closing collapses top→bottom (index 0 first, index 3 last). The visual effect
  // is items "sprouting" out of the FAB and "falling back" into it.
  itemDelay(index: number): string {
    return this.fabExpanded()
      ? `${(3 - index) * 55}ms`
      : `${index * 35}ms`;
  }

  private stripQuery(url: string): string {
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
  }

  onFabPress(): void {
    this.longPressFired = false;
    this.clearLongPressTimer();
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.longPressFired = true;
      void Haptics.impact({ style: ImpactStyle.Medium });
      this.fabExpanded.set(true);
    }, 450);
  }

  onFabRelease(): void {
    this.clearLongPressTimer();
  }

  private clearLongPressTimer(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  onFabClick(): void {
    if (this.longPressFired) {
      this.longPressFired = false;
      return;
    }
    if (this.fabExpanded()) {
      this.fabExpanded.set(false);
      return;
    }
    void this.goToNewTransaction();
  }

  closeFabMenu(): void {
    this.fabExpanded.set(false);
  }

  async goToNewTransaction(): Promise<void> {
    this.fabExpanded.set(false);
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/transactions/new']);
  }

  async goToNewCategory(): Promise<void> {
    this.fabExpanded.set(false);
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/categories']);
  }

  async goToCalculator(): Promise<void> {
    this.fabExpanded.set(false);
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/calculator']);
  }

  async goToImport(): Promise<void> {
    this.fabExpanded.set(false);
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/transactions/import']);
  }
}
