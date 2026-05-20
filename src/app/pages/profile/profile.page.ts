import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { IonContent, IonModal } from '@ionic/angular/standalone';
import { AuthService } from '../../core/services/auth.service';
import {
  GroupService,
  GroupServiceError,
} from '../../core/services/group.service';
import { GroupInvitation, GroupMembership } from '../../core/models';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [IonContent, IonModal, DatePipe],
  templateUrl: './profile.page.html',
})
export class ProfilePage {
  private auth = inject(AuthService);
  private groups = inject(GroupService);

  readonly user = this.auth.currentUser;
  readonly version = environment.version;

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

  // Group state (signals proxied from the service so the template can subscribe).
  readonly members = this.groups.myMembers;
  readonly memberships = this.groups.myMemberships;
  readonly pendingInvites = this.groups.pendingOutbound;
  readonly hasGroupSection = computed(
    () =>
      this.members().length > 0 ||
      this.memberships().length > 0 ||
      this.pendingInvites().length > 0,
  );

  // Invite modal state
  readonly showInviteModal = signal(false);
  readonly inviteEmail = signal('');
  readonly inviting = signal(false);
  readonly inviteError = signal<string | null>(null);
  readonly inviteSuccess = signal<string | null>(null);

  readonly canInvite = computed(() => {
    const e = this.inviteEmail().trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  });

  constructor() {
    effect(() => {
      const u = this.user();
      if (u) void this.groups.loadAll();
    });
  }

  // ── group actions ────────────────────────────────────────────────────────

  openInviteModal(): void {
    this.inviteEmail.set('');
    this.inviteError.set(null);
    this.inviteSuccess.set(null);
    this.showInviteModal.set(true);
  }

  closeInviteModal(): void {
    this.showInviteModal.set(false);
  }

  asValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  memberDisplayName(m: GroupMembership): string {
    return m.member?.name?.trim() || m.member_user_id.slice(0, 8);
  }

  hostDisplayName(m: GroupMembership): string {
    return m.host?.name?.trim() || m.host_user_id.slice(0, 8);
  }

  async submitInvite(): Promise<void> {
    if (!this.canInvite() || this.inviting()) return;
    this.inviting.set(true);
    this.inviteError.set(null);
    this.inviteSuccess.set(null);
    await Haptics.impact({ style: ImpactStyle.Light });
    try {
      await this.groups.invite(this.inviteEmail().trim());
      await Haptics.notification({ type: NotificationType.Success });
      this.inviteSuccess.set(
        'Tersimpan. Akan bergabung otomatis saat masuk dengan email ini.',
      );
      this.inviteEmail.set('');
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      const msg =
        err instanceof GroupServiceError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Gagal mengirim undangan.';
      this.inviteError.set(msg);
    } finally {
      this.inviting.set(false);
    }
  }

  async revokeInvite(invitation: GroupInvitation): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Medium });
    try {
      await this.groups.revoke(invitation.id);
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal membatalkan undangan.',
      );
    }
  }

  async kickMember(m: GroupMembership): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Medium });
    try {
      await this.groups.kickMember(m.member_user_id);
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal mengeluarkan anggota.',
      );
    }
  }

  async leaveHost(m: GroupMembership): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Medium });
    try {
      await this.groups.leaveGroup(m.host_user_id);
    } catch (err) {
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal keluar dari grup.',
      );
    }
  }

  // ── sign out ─────────────────────────────────────────────────────────────

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
