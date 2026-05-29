import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { filter, map } from 'rxjs';

// Global "peeping" handle fixed to the right edge of every authed page. Tapping it
// slides out a drawer of utility shortcuts; for v1 the only util is the Calculator.
// Lives in AppShellComponent as a sibling of the Tab Bar — see docs/ui-screens.md.
@Component({
  selector: 'app-utils-peek',
  standalone: true,
  imports: [],
  templateUrl: './utils-peek.component.html',
})
export class UtilsPeekComponent {
  private router = inject(Router);

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => (e as NavigationEnd).urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  // Hide on the calculator page itself — you're already where the only util goes.
  readonly hidden = computed(() => {
    const url = this.stripQuery(this.currentUrl());
    return url.startsWith('/calculator');
  });

  readonly expanded = signal(false);

  private stripQuery(url: string): string {
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
  }

  async toggle(): Promise<void> {
    const next = !this.expanded();
    this.expanded.set(next);
    if (next) await Haptics.impact({ style: ImpactStyle.Light });
  }

  close(): void {
    this.expanded.set(false);
  }

  async goToCalculator(): Promise<void> {
    this.expanded.set(false);
    await Haptics.impact({ style: ImpactStyle.Light });
    void this.router.navigate(['/calculator']);
  }
}
