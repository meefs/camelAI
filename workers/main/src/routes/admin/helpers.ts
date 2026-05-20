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
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../workspace-container.js';

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
  getLegacyClaudeSessionId(): Promise<string | null>;
  getCodexSessionId(): Promise<string | null>;
  getPiCoreParsedMessages(threadId: string): Promise<unknown[]> | unknown[];
};

async function getOptionalChatThreadSessionId(
  env: Env,
  threadId: string,
  methodName: keyof ChatThreadLookup,
): Promise<string | null> {
  if (!('CHAT_THREAD' in env) || !env.CHAT_THREAD) {
    return null;
  }

  const chatThread = env.CHAT_THREAD.get(
    env.CHAT_THREAD.idFromName(threadId),
  ) as unknown as Partial<ChatThreadLookup>;
  const method = chatThread[methodName];
  if (typeof method !== 'function') {
    return null;
  }

  const sessionMethod = method as (this: Partial<ChatThreadLookup>) => Promise<string | null> | string | null;
  const sessionId = await Promise.resolve(sessionMethod.call(chatThread)).catch(() => null);
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
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

  if ('CHAT_THREAD' in env && env.CHAT_THREAD) {
    const chatThread = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(trimmedThreadId),
    ) as unknown as Partial<ChatThreadLookup>;
    if (typeof chatThread.getPiCoreParsedMessages === 'function') {
      const piMessages = await Promise.resolve(
        chatThread.getPiCoreParsedMessages(trimmedThreadId),
      ).catch(() => []);
      if (Array.isArray(piMessages) && piMessages.length > 0) {
        return Response.json(
          { success: true, messages: piMessages },
          {
            headers: {
              'Cache-Control': 'no-cache, no-transform',
            },
          },
        );
      }
    }
  }

  const container = new WorkspaceContainer(
    env as unknown as WorkspaceContainerEnv,
    threadContext.workspace_id,
    threadContext.org_id,
  );

  const legacyClaudeSessionId = await getOptionalChatThreadSessionId(
    env,
    trimmedThreadId,
    'getLegacyClaudeSessionId',
  );
  const codexSessionId = await getOptionalChatThreadSessionId(
    env,
    trimmedThreadId,
    'getCodexSessionId',
  );
  const streamResult = await container.readThreadMessagesStream(trimmedThreadId, {
    claudeSessionId: legacyClaudeSessionId,
    codexSessionId,
    skipBanCheck: true,
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
