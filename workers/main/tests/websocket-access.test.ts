/**
 * Chat transport access guard regression tests using Cloudflare Vitest pool.
 *
 * The chat transport is HTTP now: an SSE attach admits with 200 +
 * text/event-stream, and a denial is a real status the client can classify as
 * terminal (400/401/403/404) or retryable (409/429/5xx) — replacing the
 * accept-then-close-with-4403 trick the WebSocket upgrade needed.
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

describe('Chat transport access guard', () => {
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

  const attach = (threadId: string, workspaceId: string, signedToken: string) =>
    SELF.fetch(
      `http://example/agents/chat-thread/${threadId}/sse?workspaceId=${workspaceId}&_pk=pk-1`,
      {
        headers: {
          Accept: 'text/event-stream',
          'X-Chiridion-Session-Id': signedToken,
        },
      },
    );

  it('opens the SSE stream for authorized workspace access', async () => {
    const { workspaceId, threadId, signedToken } = await setupMemberSession();

    const response = await attach(threadId, workspaceId, signedToken);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    // Never read to completion — the stream is long-lived by design.
    await response.body?.cancel();
  });

  it('denies the SSE stream for denied workspace access', async () => {
    const { ownerId, memberId, workspaceId, threadId, signedToken } = await setupMemberSession();

    await setWorkspaceAccess(testEnv, workspaceId, memberId, 'none', ownerId);

    const response = await attach(threadId, workspaceId, signedToken);

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).not.toBe('text/event-stream');
  });

  it('denies the SSE stream when org membership is removed', async () => {
    const { ownerId, memberId, orgId, workspaceId, threadId, signedToken } = await setupMemberSession();

    await removeOrgMember(testEnv, orgId, memberId, ownerId);

    const response = await attach(threadId, workspaceId, signedToken);

    expect(response.status).toBe(403);
  });

  it('rejects an unauthenticated POST send', async () => {
    const { workspaceId, threadId } = await setupMemberSession();

    const response = await SELF.fetch(
      `http://example/agents/chat-thread/${threadId}/call?workspaceId=${workspaceId}&_pk=pk-1`,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'rpc', id: 'r1', method: 'requestStop', args: [] }),
      },
    );

    expect(response.status).toBe(401);
  });

  it('404s an /agents/ path that matches no transport route', async () => {
    const { signedToken } = await setupMemberSession();

    const response = await SELF.fetch('http://example/agents/chat-thread/nope/bogus', {
      headers: { 'X-Chiridion-Session-Id': signedToken },
    });

    // A miss must not fall through to the SPA shell (200 text/html).
    expect(response.status).toBe(404);
  });
});
