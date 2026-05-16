import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { IonRouterOutlet } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { filter, map } from 'rxjs';

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
}
