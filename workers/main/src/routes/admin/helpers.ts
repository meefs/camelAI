/**
 * Shared accessors for the admin API.
 */

import type { Env } from '../../types.js';
import type { OrgDO, UserDO } from '../../auth.js';
import {
  getAppIndexDatabase,
  getAppIndexReadDatabase,
} from '../../app-index-db.js';
import { ensureAdminIndexReady } from '../../admin-index-bootstrap.js';

// ---------------------------------------------------------------------------
// Shared data access helpers
// ---------------------------------------------------------------------------

type AdminIndexEnv = Pick<Env, 'APP_DB' | 'APP_KV' | 'EMAIL_TO_USER' | 'USER' | 'ORG' | 'WORKSPACE'>;
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
  getPiCoreParsedMessages(threadId: string): Promise<unknown[]> | unknown[];
  getLegacyClaudeSessionId(): Promise<string | null> | string | null;
  getCodexSessionId(): Promise<string | null> | string | null;
};

function legacyWorkspaceUrl(
  orgId: string,
  workspaceId: string,
  subpath: string,
  query?: Record<string, string>,
): string {
  const url = new URL('http://legacy-workspace');
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const cleanedSubpath = subpath.startsWith('/') ? subpath : `/${subpath}`;
  url.pathname = `${basePath}/v1/workspaces/${encodeURIComponent(orgId)}/${encodeURIComponent(workspaceId)}${cleanedSubpath}`;
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function fetchLegacyWorkspace(
  env: Env,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (!env.LEGACY_WORKSPACE_HOST) {
    throw new Error('LEGACY_WORKSPACE_HOST binding is not configured');
  }
  return env.LEGACY_WORKSPACE_HOST.fetch(new Request(url, init));
}

async function loadLegacyThreadMessages(
  env: Env,
  chatThread: Partial<ChatThreadLookup> | null,
  input: {
    orgId: string;
    workspaceId: string;
    threadId: string;
  },
): Promise<unknown[]> {
  if (!env.LEGACY_WORKSPACE_HOST) {
    return [];
  }

  const query: Record<string, string> = { threadId: input.threadId };
  const legacyClaudeSessionId = chatThread?.getLegacyClaudeSessionId
    ? await Promise.resolve(chatThread.getLegacyClaudeSessionId()).catch(() => null)
    : null;
  if (typeof legacyClaudeSessionId === 'string' && legacyClaudeSessionId.trim()) {
    query.claudeSessionId = legacyClaudeSessionId.trim();
  }
  const codexSessionId = chatThread?.getCodexSessionId
    ? await Promise.resolve(chatThread.getCodexSessionId()).catch(() => null)
    : null;
  if (typeof codexSessionId === 'string' && codexSessionId.trim()) {
    query.codexSessionId = codexSessionId.trim();
  }

  const response = await fetchLegacyWorkspace(
    env,
    legacyWorkspaceUrl(
      input.orgId,
      input.workspaceId,
      '/chat/messages',
      query,
    ),
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to load legacy messages: ${response.status}`);
  }
  const payload = await response.json() as { messages?: unknown };
  return Array.isArray(payload.messages) ? payload.messages : [];
}

export function getAdminIndexStub(env: AdminIndexEnv) {
  const readIndex = getAppIndexReadDatabase(env);
  const writeIndex = getAppIndexDatabase(env);
  if (!readIndex || !writeIndex) {
    throw new Error('APP_DB binding is not configured');
  }
  const writeMethods = new Set([
    'applyAdminEvent',
    'blockSignupIp',
    'markBootstrapComplete',
    'unblockSignupIp',
  ]);

  return new Proxy(readIndex as unknown as Record<string, unknown>, {
    get(_target, prop, receiver) {
      const target = typeof prop === 'string' && writeMethods.has(prop)
        ? writeIndex
        : readIndex;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      return async (...args: unknown[]) => {
        await ensureAdminIndexReady(env);
        return value.apply(target, args);
      };
    },
  });
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

  let chatThread: Partial<ChatThreadLookup> | null = null;
  let piMessages: unknown[] = [];
  if ('CHAT_THREAD' in env && env.CHAT_THREAD) {
    chatThread = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(trimmedThreadId),
    ) as unknown as Partial<ChatThreadLookup>;
    if (typeof chatThread.getPiCoreParsedMessages === 'function') {
      piMessages = await Promise.resolve(
        chatThread.getPiCoreParsedMessages(trimmedThreadId),
      ).catch(() => []);
      if (!Array.isArray(piMessages)) piMessages = [];
    }
  }

  const legacyMessages = await loadLegacyThreadMessages(env, chatThread, {
    orgId: threadContext.org_id,
    workspaceId: threadContext.workspace_id,
    threadId: trimmedThreadId,
  }).catch((error) => {
    if (piMessages.length > 0) {
      return [];
    }
    throw error;
  });
  if (legacyMessages.length === 0 && piMessages.length > 0) {
    return Response.json(
      { success: true, messages: piMessages },
      {
        headers: {
          'Cache-Control': 'no-cache, no-transform',
        },
      },
    );
  }
  return Response.json(
    { success: true, messages: legacyMessages },
    {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
      },
    },
  );
}
