import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import {
  acceptInvitation,
  createInvitation,
  createOrg,
  createUser,
  setWorkspaceAccess,
  type TestEnv,
} from './test-helpers';

const email = (label: string) =>
  `${label}-${crypto.randomUUID()}@example.com`;

describe('OrgDO chat WebSocket authorization', () => {
  const testEnv = env as unknown as TestEnv;

  it('validates workspace, full access, membership, and thread in one RPC', async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      email('owner'),
      'password123',
      'Owner',
    );
    const memberEmail = email('member');
    const { userId: memberId } = await createUser(
      testEnv,
      memberEmail,
      'password123',
      'Member',
    );
    const { userId: outsiderId } = await createUser(
      testEnv,
      email('outsider'),
      'password123',
      'Outsider',
    );
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Chat websocket authorization',
      ownerId,
    );
    const invitation = await createInvitation(
      testEnv,
      org.id,
      memberEmail,
      'member',
      ownerId,
    );
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(
      defaultWorkspaceId,
      'Authorized thread',
      memberId,
    );

    await expect(
      orgStub.validateChatWebSocketAccess(
        memberId,
        defaultWorkspaceId,
        thread.id,
      ),
    ).resolves.toMatchObject({
      ok: true,
      orgId: org.id,
      workspaceId: defaultWorkspaceId,
      threadId: thread.id,
    });

    await setWorkspaceAccess(
      testEnv,
      defaultWorkspaceId,
      memberId,
      'none',
      ownerId,
    );
    await expect(
      orgStub.validateChatWebSocketAccess(
        memberId,
        defaultWorkspaceId,
        thread.id,
      ),
    ).resolves.toEqual({ ok: false, reason: 'forbidden' });

    await expect(
      orgStub.validateChatWebSocketAccess(
        outsiderId,
        defaultWorkspaceId,
        thread.id,
      ),
    ).resolves.toEqual({ ok: false, reason: 'forbidden' });

    await expect(
      orgStub.validateChatWebSocketAccess(
        memberId,
        `missing-${crypto.randomUUID()}`,
        thread.id,
      ),
    ).resolves.toEqual({ ok: false, reason: 'workspace_not_found' });

    await setWorkspaceAccess(
      testEnv,
      defaultWorkspaceId,
      memberId,
      'full',
      ownerId,
    );
    await expect(
      orgStub.validateChatWebSocketAccess(
        memberId,
        defaultWorkspaceId,
        `missing-${crypto.randomUUID()}`,
      ),
    ).resolves.toEqual({ ok: false, reason: 'thread_not_found' });
  });
});
