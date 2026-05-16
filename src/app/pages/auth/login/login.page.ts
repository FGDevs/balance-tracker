import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { IonContent } from '@ionic/angular/standalone';
import { AuthService } from '../../../core/services/auth.service';

type Mode = 'signin' | 'signup';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [IonContent],
  templateUrl: './login.page.html',
})
export class LoginPage {
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly mode = signal<Mode>('signin');
  readonly email = signal('');
  readonly password = signal('');
  readonly name = signal('');
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  readonly canSubmit = computed(() => {
    const email = this.email().trim();
    const password = this.password();
    if (!email || password.length < 6) return false;
    if (this.mode() === 'signup' && !this.name().trim()) return false;
    return true;
  });

  setMode(next: Mode): void {
    if (next === this.mode()) return;
    this.mode.set(next);
    this.errorMessage.set(null);
    this.infoMessage.set(null);
  }

  asValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.loading() || !this.canSubmit()) return;

    this.loading.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    await Haptics.impact({ style: ImpactStyle.Light });

    try {
      if (this.mode() === 'signin') {
        await this.auth.signIn(this.email().trim(), this.password());
        await Haptics.notification({ type: NotificationType.Success });
        await this.router.navigateByUrl('/dashboard');
      } else {
        await this.auth.signUp(
          this.email().trim(),
          this.password(),
          this.name().trim(),
        );
        await Haptics.notification({ type: NotificationType.Success });
        if (this.auth.session()) {
          await this.router.navigateByUrl('/dashboard');
        } else {
          this.mode.set('signin');
          this.password.set('');
          this.infoMessage.set(
            'Periksa email untuk konfirmasi akun, lalu masuk.',
          );
        }
      }
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal masuk. Coba lagi.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
