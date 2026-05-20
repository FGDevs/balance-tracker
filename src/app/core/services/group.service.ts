import { Injectable, computed, inject, signal } from '@angular/core';
import {
  GroupInvitation,
  GroupInvitationStatus,
  GroupMembership,
} from '../models';
import { AuthService } from './auth.service';
import { SupabaseService } from './supabase.service';

// Per CLAUDE.md §13 — the service that owns invite + membership lifecycle.
// All RLS is enforced server-side; this service trusts it and just shapes
// data for the UI. Self-invites and obvious dup-invites are short-circuited
// client-side for friendlier errors.

const MEMBERSHIP_SELECT =
  '*, host:profiles!group_memberships_host_user_id_fkey(*), member:profiles!group_memberships_member_user_id_fkey(*)';

export class GroupServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_authenticated'
      | 'self_invite'
      | 'already_invited'
      | 'unknown',
  ) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class GroupService {
  private readonly supabase = inject(SupabaseService);
  private readonly auth = inject(AuthService);

  readonly myMemberships = signal<GroupMembership[]>([]);
  readonly myMembers = signal<GroupMembership[]>([]);
  readonly pendingOutbound = signal<GroupInvitation[]>([]);

  readonly hasMembers = computed(() => this.myMembers().length > 0);
  readonly hasMemberships = computed(() => this.myMemberships().length > 0);
  readonly hasPending = computed(() => this.pendingOutbound().length > 0);

  // §13 — a {userId → displayName} lookup built from currently-loaded
  // memberships (hosts I follow + members in my group) plus the signed-in
  // user. Used by Account Card and Transaction Row foreign-author labels.
  // Returns null when the user is not in any known relation (cache miss).
  nameFor(userId: string | undefined | null): string | null {
    if (!userId) return null;
    const me = this.auth.currentUser();
    if (me?.id === userId) {
      const meta = me.user_metadata as { name?: string } | undefined;
      return meta?.name?.trim() || me.email?.split('@')[0] || 'Saya';
    }
    for (const m of this.myMemberships()) {
      if (m.host_user_id === userId && m.host?.name) return m.host.name;
    }
    for (const m of this.myMembers()) {
      if (m.member_user_id === userId && m.member?.name) return m.member.name;
    }
    return null;
  }

  async loadAll(): Promise<void> {
    const uid = this.auth.currentUser()?.id;
    if (!uid) {
      this.myMemberships.set([]);
      this.myMembers.set([]);
      this.pendingOutbound.set([]);
      return;
    }
    const client = this.supabase.getClient();

    const [memberships, members, invitations] = await Promise.all([
      client
        .from('group_memberships')
        .select(MEMBERSHIP_SELECT)
        .eq('member_user_id', uid),
      client
        .from('group_memberships')
        .select(MEMBERSHIP_SELECT)
        .eq('host_user_id', uid),
      client
        .from('group_invitations')
        .select('*')
        .eq('host_user_id', uid)
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
    ]);

    if (memberships.error) throw memberships.error;
    if (members.error) throw members.error;
    if (invitations.error) throw invitations.error;

    this.myMemberships.set((memberships.data ?? []) as GroupMembership[]);
    this.myMembers.set((members.data ?? []) as GroupMembership[]);
    this.pendingOutbound.set(
      (invitations.data ?? []) as GroupInvitation[],
    );
  }

  async invite(email: string): Promise<GroupInvitation> {
    const uid = this.auth.currentUser()?.id;
    const selfEmail = this.auth.currentUser()?.email?.toLowerCase();
    if (!uid) throw new GroupServiceError('Belum login', 'not_authenticated');

    const normalized = email.trim().toLowerCase();
    if (!normalized) throw new Error('Email wajib diisi');
    if (selfEmail && normalized === selfEmail) {
      throw new GroupServiceError(
        'Tidak bisa mengundang diri sendiri',
        'self_invite',
      );
    }

    const client = this.supabase.getClient();

    // Surface a friendly error before hitting the DB if a pending invite
    // exists for the same (host, email).
    const { data: existing, error: lookupErr } = await client
      .from('group_invitations')
      .select('id, status')
      .eq('host_user_id', uid)
      .eq('invitee_email', normalized)
      .eq('status', 'pending')
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (existing) {
      throw new GroupServiceError(
        'Sudah ada undangan tertunda untuk email ini',
        'already_invited',
      );
    }

    // 30-day window. The invitee just needs to sign in with that email
    // before then; claim_invitations_for_email() does the rest.
    const expiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: row, error } = await client
      .from('group_invitations')
      .insert({
        host_user_id: uid,
        invitee_email: normalized,
        status: 'pending' as GroupInvitationStatus,
        expires_at: expiresAt,
      })
      .select()
      .single();
    if (error) throw error;
    const invitation = row as GroupInvitation;

    this.pendingOutbound.update((list) => [invitation, ...list]);
    return invitation;
  }

  async revoke(invitationId: number): Promise<void> {
    const client = this.supabase.getClient();
    const { error } = await client
      .from('group_invitations')
      .update({ status: 'revoked' as GroupInvitationStatus })
      .eq('id', invitationId);
    if (error) throw error;
    this.pendingOutbound.update((list) =>
      list.filter((i) => i.id !== invitationId),
    );
  }

  // Called at app boot for an authenticated session. Hits the
  // claim_invitations_for_email RPC; returns the # of NEW memberships
  // created in this call (0 when there was nothing to claim). The caller
  // (typically AppShellComponent) reloads accounts/transactions when > 0.
  async claimPendingInvitations(): Promise<number> {
    const uid = this.auth.currentUser()?.id;
    if (!uid) return 0;
    const client = this.supabase.getClient();
    const { data, error } = await client.rpc('claim_invitations_for_email');
    if (error) return 0;
    return typeof data === 'number' ? data : 0;
  }

  async kickMember(memberUserId: string): Promise<void> {
    const uid = this.auth.currentUser()?.id;
    if (!uid) throw new GroupServiceError('Belum login', 'not_authenticated');
    const client = this.supabase.getClient();
    const { error } = await client
      .from('group_memberships')
      .delete()
      .eq('host_user_id', uid)
      .eq('member_user_id', memberUserId);
    if (error) throw error;
    this.myMembers.update((list) =>
      list.filter((m) => m.member_user_id !== memberUserId),
    );
  }

  async leaveGroup(hostUserId: string): Promise<void> {
    const uid = this.auth.currentUser()?.id;
    if (!uid) throw new GroupServiceError('Belum login', 'not_authenticated');
    const client = this.supabase.getClient();
    const { error } = await client
      .from('group_memberships')
      .delete()
      .eq('host_user_id', hostUserId)
      .eq('member_user_id', uid);
    if (error) throw error;
    this.myMemberships.update((list) =>
      list.filter((m) => m.host_user_id !== hostUserId),
    );
  }

}
