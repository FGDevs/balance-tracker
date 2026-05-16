import { Component, computed, inject, signal } from '@angular/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { IonContent } from '@ionic/angular/standalone';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [IonContent],
  templateUrl: './profile.page.html',
})
export class ProfilePage {
  private auth = inject(AuthService);

  readonly user = this.auth.currentUser;

  readonly displayName = computed(() => {
    const meta = this.user()?.user_metadata as { name?: string } | undefined;
    const fromMeta = meta?.name?.trim();
    if (fromMeta) return fromMeta;
    const email = this.user()?.email;
    return email ? email.split('@')[0] : 'Pengguna';
  });

  readonly firstName = computed(() => this.displayName().split(/\s+/)[0]);

  readonly email = computed(() => this.user()?.email ?? '—');

  readonly editionLabel = computed(() => {
    const d = new Date();
    const date = new Intl.DateTimeFormat('id-ID', {
      day: '2-digit',
      month: '2-digit',
    }).format(d);
    const day = new Intl.DateTimeFormat('id-ID', { weekday: 'long' })
      .format(d)
      .toUpperCase();
    return `Profil · ${date} · ${day}`;
  });

  readonly signingOut = signal(false);
  readonly errorMessage = signal<string | null>(null);

  async signOut(): Promise<void> {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    this.errorMessage.set(null);
    await Haptics.impact({ style: ImpactStyle.Medium });
    try {
      await this.auth.signOut();
      await Haptics.notification({ type: NotificationType.Success });
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal keluar. Coba lagi.',
      );
    } finally {
      this.signingOut.set(false);
    }
  }
}
