/**
 * WebSocket access guard regression tests using Cloudflare Vitest pool
 */

import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createSignedSession, type SignedSessionData } from '../src/signed-session';
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
  const signingSecret = (env as any).TOKEN_SIGNING_SECRET as string;

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

    // Create a signed session token
    const sessionData: SignedSessionData = {
      user_id: memberId,
      org_id: org.id,
      workspace_id: workspaceId,
      created_at: Date.now(),
      user_name: 'Member',
      user_email: memberEmail,
    };
    const signedToken = await createSignedSession(signingSecret, sessionData);

    return {
      ownerId,
      memberId,
      orgId: org.id,
      workspaceId: workspaceId!,
      threadId: thread.id,
      signedToken,
    };
  }

  it('allows WebSocket upgrade for authorized workspace access', async () => {
    const { workspaceId, threadId, signedToken } = await setupMemberSession();

    const response = await SELF.fetch(`http://example/agents/chat-thread/${threadId}?workspaceId=${workspaceId}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Chiridion-Session-Id': signedToken,
      },
    });

    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it('denies WebSocket upgrade for denied workspace access', async () => {
    const { ownerId, memberId, workspaceId, threadId, signedToken } = await setupMemberSession();

    await setWorkspaceAccess(testEnv, workspaceId, memberId, 'none', ownerId);

    const response = await SELF.fetch(`http://example/agents/chat-thread/${threadId}?workspaceId=${workspaceId}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Chiridion-Session-Id': signedToken,
      },
    });

    // Hard auth failures accept the upgrade then immediately close with a
    // terminal application code (4403) so the browser stops reconnecting.
    expect(response.status).toBe(101);
    expect(response.webSocket).toBeTruthy();
    const ws = response.webSocket!;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener('close', (event) => {
        resolve({ code: event.code, reason: event.reason });
      });
    });
    ws.accept();
    const close = await closed;
    expect(close.code).toBe(4403);
  });

  it('denies WebSocket upgrade when org membership is removed', async () => {
    const { ownerId, memberId, orgId, workspaceId, threadId, signedToken } = await setupMemberSession();

    await removeOrgMember(testEnv, orgId, memberId, ownerId);

    const response = await SELF.fetch(`http://example/agents/chat-thread/${threadId}?workspaceId=${workspaceId}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Chiridion-Session-Id': signedToken,
      },
    });

    expect(response.status).toBe(101);
    expect(response.webSocket).toBeTruthy();
    const ws = response.webSocket!;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener('close', (event) => {
        resolve({ code: event.code, reason: event.reason });
      });
    });
    ws.accept();
    const close = await closed;
    expect(close.code).toBe(4403);
  });
});
