/**
 * DO stub accessors for the admin API.
 */

import type { Env } from '../../types.js';
import type { OrgDO, UserDO } from '../../auth.js';
import type { AdminIndexDO } from '../../admin-index-do.js';
import { ensureAdminIndexReady } from '../../../../../src/lib/auth-do.server';
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../workspace-container.js';

// ---------------------------------------------------------------------------
// DO stub helpers
// ---------------------------------------------------------------------------

type AdminIndexEnv = Pick<Env, 'ADMIN_INDEX'>;
type OrgEnv = Pick<Env, 'ORG'>;
type UserEnv = Pick<Env, 'USER'>;
type AdminThreadContextLookup = {
  getThreadContextById(threadId: string): Promise<{
    org_id: string;
    workspace_id: string;
  } | null>;
};
type OrgThreadLookup = {
  getThread(threadId: string): Promise<{
    workspace_id: string;
  } | null>;
};
type ChatThreadLookup = {
  getLegacyClaudeSessionId(): Promise<string | null>;
  getCodexSessionId(): Promise<string | null>;
};

export function getAdminIndexStub(env: AdminIndexEnv) {
  return env.ADMIN_INDEX.get(env.ADMIN_INDEX.idFromName('admin_index')) as DurableObjectStub<AdminIndexDO>;
}

export function getOrgStub(env: OrgEnv, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
}

export function getUserStub(env: UserEnv, userId: string) {
  return env.USER.get(env.USER.idFromName(userId)) as DurableObjectStub<UserDO>;
}

// ---------------------------------------------------------------------------
// Thread message helpers
// ---------------------------------------------------------------------------

export async function loadAdminThreadMessagesResponse(
  env: Env,
  threadId: string,
): Promise<Response> {
  const trimmedThreadId = threadId.trim();
  if (!trimmedThreadId) {
    return Response.json({ error: 'Thread ID required' }, { status: 400 });
  }

  await ensureAdminIndexReady(env as never);

  const adminIndex = getAdminIndexStub(env) as unknown as AdminThreadContextLookup;
  const threadContext = await adminIndex.getThreadContextById(trimmedThreadId);
  if (!threadContext) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  const orgStub = getOrgStub(env, threadContext.org_id) as unknown as OrgThreadLookup;
  const thread = await orgStub.getThread(trimmedThreadId);
  if (!thread || thread.workspace_id !== threadContext.workspace_id) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  const container = new WorkspaceContainer(
    env as unknown as WorkspaceContainerEnv,
    threadContext.workspace_id,
    threadContext.org_id,
  );

  const chatThread = env.CHAT_THREAD.get(
    env.CHAT_THREAD.idFromName(trimmedThreadId),
  ) as unknown as ChatThreadLookup;
  const legacyClaudeSessionId = await chatThread.getLegacyClaudeSessionId().catch(() => null);
  const codexSessionId = await chatThread.getCodexSessionId().catch(() => null);
  const streamResult = await container.readThreadMessagesStream(trimmedThreadId, {
    claudeSessionId: legacyClaudeSessionId,
    codexSessionId,
  });
  if (!streamResult.success || !streamResult.response) {
    const status = streamResult.code?.startsWith('HTTP_')
      ? Number.parseInt(streamResult.code.slice(5), 10) || 500
      : 500;
    return Response.json(
      { error: streamResult.error || 'Failed to load messages' },
      { status },
    );
  }

  const upstream = streamResult.response;
  const headers = new Headers(upstream.headers);
  if (!headers.get('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Cache-Control', 'no-cache, no-transform');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
