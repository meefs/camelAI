/**
 * WebSocket access guard regression tests using Cloudflare Vitest pool
 */

import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createNewSession } from '../src/session-kv';
import {
  createUser,
  createOrg,
  createInvitation,
  acceptInvitation,
  listOrgWorkspaces,
  setWorkspaceAccess,
  removeOrgMember,
  type TestEnv,
} from './test-helpers';

const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe('WebSocket access guard', () => {
  const testEnv = env as unknown as TestEnv;
  const sessionsKV = env.SESSIONS as KVNamespace;

  async function setupMemberSession() {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'WS Access Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const workspaces = await listOrgWorkspaces(testEnv, org.id);
    const workspaceId = workspaces[0]?.id ?? null;
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(workspaceId!, 'Test thread', memberId);
    const { sessionId, sessionData } = await createNewSession(sessionsKV, memberId, org.id, workspaceId);
    expect(sessionData.workspace_id).toBeTruthy();

    return {
      ownerId,
      memberId,
      orgId: org.id,
      workspaceId: sessionData.workspace_id!,
      threadId: thread.id,
      sessionId,
    };
  }

  it('denies WebSocket upgrade for read_only workspace access', async () => {
    const { ownerId, memberId, workspaceId, threadId, sessionId } = await setupMemberSession();

    await setWorkspaceAccess(testEnv, workspaceId, memberId, 'read_only', ownerId);

    const response = await SELF.fetch(`http://example/ws/${workspaceId}?threadId=${threadId}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Chiridion-Session-Id': sessionId,
      },
    });

    expect(response.status).toBe(403);
  });

  it('denies WebSocket upgrade when org membership is removed', async () => {
    const { ownerId, memberId, orgId, workspaceId, threadId, sessionId } = await setupMemberSession();

    await removeOrgMember(testEnv, orgId, memberId, ownerId);

    const response = await SELF.fetch(`http://example/ws/${workspaceId}?threadId=${threadId}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Chiridion-Session-Id': sessionId,
      },
    });

    expect(response.status).toBe(403);
  });
});
