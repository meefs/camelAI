/**
 * WebSocket access guard regression tests using Cloudflare Vitest pool
 */

import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { DoRpcService } from '../src/rpc-service';

const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe('WebSocket access guard', () => {
  const rpc = env.DO_RPC as unknown as DoRpcService;

  async function setupMemberSession() {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('WS Access Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    const { sessionId, sessionData } = await rpc.createSession(memberId, org.id);
    expect(sessionData.workspace_id).toBeTruthy();

    return {
      ownerId,
      memberId,
      orgId: org.id,
      workspaceId: sessionData.workspace_id!,
      sessionId,
    };
  }

  it('denies WebSocket upgrade for read_only workspace access', async () => {
    const { ownerId, memberId, workspaceId, sessionId } = await setupMemberSession();

    await rpc.setWorkspaceAccess(workspaceId, memberId, 'read_only', ownerId);

    const response = await SELF.fetch(`http://example/ws/${workspaceId}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Chiridion-Session-Id': sessionId,
      },
    });

    expect(response.status).toBe(403);
  });

  it('denies WebSocket upgrade when org membership is removed', async () => {
    const { ownerId, memberId, orgId, workspaceId, sessionId } = await setupMemberSession();

    await rpc.removeOrgMember(orgId, memberId, ownerId);

    const response = await SELF.fetch(`http://example/ws/${workspaceId}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Chiridion-Session-Id': sessionId,
      },
    });

    expect(response.status).toBe(403);
  });
});
