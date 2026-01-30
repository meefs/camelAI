import { describe, expect, it, vi } from 'vitest';
import { acceptInvitation, getInvitation } from '@/lib/auth-do';
import type { AuthEnv } from '@/lib/auth-helpers';
import type { Organization } from '@/types';

function buildEnv(options: {
  orgInfo: Organization | null;
  invitation: { id: string; email: string; role: string } | null;
  acceptResult?: boolean;
}) {
  const orgStub = {
    getInvitation: vi.fn(async () => options.invitation),
    getInfo: vi.fn(async () => options.orgInfo),
    acceptInvitation: vi.fn(async () => options.acceptResult ?? true),
  };

  const userStub = {
    addOrg: vi.fn(async () => undefined),
    setOrphaned: vi.fn(async () => undefined),
  };

  const env = {
    ORG: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => orgStub),
    },
    USER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => userStub),
    },
    WORKSPACE: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({})),
    },
    SESSIONS: {} as KVNamespace,
    EMAIL_TO_USER: {} as KVNamespace,
    APP_KV: {} as KVNamespace,
  } as unknown as AuthEnv;

  return { env, orgStub, userStub };
}

describe('auth-do invitations', () => {
  it('getInvitation returns null when org is archived', async () => {
    const archivedOrg: Organization = {
      id: 'org-archived',
      name: 'Archived Org',
      created_at: Date.now(),
      created_by: 'user-1',
      billing_status: 'free',
      archived: true,
      archived_at: Date.now(),
      archived_by: 'user-1',
    };

    const { env } = buildEnv({
      orgInfo: archivedOrg,
      invitation: { id: 'inv-1', email: 'invitee@example.com', role: 'member' },
    });

    const invitation = await getInvitation(env, archivedOrg.id, 'inv-1');
    expect(invitation).toBeNull();
  });

  it('acceptInvitation rejects archived org invitations', async () => {
    const archivedOrg: Organization = {
      id: 'org-archived',
      name: 'Archived Org',
      created_at: Date.now(),
      created_by: 'user-1',
      billing_status: 'free',
      archived: true,
      archived_at: Date.now(),
      archived_by: 'user-1',
    };

    const { env, orgStub } = buildEnv({
      orgInfo: archivedOrg,
      invitation: { id: 'inv-1', email: 'invitee@example.com', role: 'member' },
    });

    const accepted = await acceptInvitation(env, archivedOrg.id, 'inv-1', 'user-2');

    expect(accepted).toBe(false);
    expect(orgStub.acceptInvitation).not.toHaveBeenCalled();
  });
});
