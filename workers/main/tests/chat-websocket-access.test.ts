import { describe, expect, it, vi } from 'vitest';

import { requireChatWebSocketAccess } from '../src/helpers/auth';
import { createSignedSession } from '../src/signed-session';

const SECRET = 'test-signing-secret';
const USER_ID = 'user-1';
const THREAD_ID = 'thread-1';
const URL_WORKSPACE_ID = 'workspace-url';
const SESSION_WORKSPACE_ID = 'workspace-session';
const URL_ORG_ID = 'org-url';
const SESSION_ORG_ID = 'org-session';

async function buildRequest(): Promise<Request> {
  const token = await createSignedSession(SECRET, {
    user_id: USER_ID,
    org_id: SESSION_ORG_ID,
    workspace_id: SESSION_WORKSPACE_ID,
    created_at: Date.now(),
    user_name: 'Test User',
    user_email: 'test@example.com',
  });
  return new Request(
    `https://camelai.dev/agents/chat-thread/${THREAD_ID}?workspaceId=${URL_WORKSPACE_ID}`,
    { headers: { Cookie: `chiridion_session_v3=${token}` } },
  );
}

function transientError(): Error {
  return new Error('Network connection lost.');
}

function buildEnv(overrides: {
  workspaceStub?: Record<string, unknown>;
  orgStub?: Record<string, unknown>;
  userStub?: Record<string, unknown>;
}) {
  const workspaceStub = {
    ...overrides.workspaceStub,
  };
  const orgStub = {
    getWorkspaceRecord: vi.fn().mockResolvedValue({
      id: URL_WORKSPACE_ID,
      org_id: URL_ORG_ID,
      archived: false,
    }),
    getWorkspaceAccess: vi.fn().mockResolvedValue('full'),
    validateChatThreadAccess: vi.fn().mockResolvedValue({
      ok: true,
      orgId: URL_ORG_ID,
      orgSlug: 'url-org',
      threadId: THREAD_ID,
    }),
    ...overrides.orgStub,
  };
  const userStub = overrides.userStub ?? {
    getSessionInvalidatedAt: vi.fn().mockResolvedValue(null),
  };
  const env = {
    TOKEN_SIGNING_SECRET: SECRET,
    APP_KV: { get: vi.fn().mockResolvedValue(null) },
    USER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => userStub),
    },
    WORKSPACE: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => workspaceStub),
    },
    ORG: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => orgStub),
    },
  } as any;
  return { env, workspaceStub, orgStub, userStub };
}

describe('requireChatWebSocketAccess', () => {
  it('authorizes against the workspace from the URL, not the session selection', async () => {
    const { env, orgStub } = buildEnv({});
    const req = await buildRequest();

    const access = await requireChatWebSocketAccess(
      req,
      env,
      THREAD_ID,
      URL_WORKSPACE_ID,
    );

    expect('error' in access).toBe(false);
    expect('degraded' in access).toBe(false);
    if ('error' in access || 'degraded' in access) return;
    expect(access.workspaceId).toBe(URL_WORKSPACE_ID);
    // Org resolved from the workspace record, even though the session points
    // at a different org.
    expect(access.orgId).toBe(URL_ORG_ID);
    expect(env.ORG.idFromName).toHaveBeenCalledWith(URL_ORG_ID);
    expect(
      (orgStub.validateChatThreadAccess as ReturnType<typeof vi.fn>).mock
        .calls[0],
    ).toEqual([USER_ID, URL_WORKSPACE_ID, THREAD_ID]);
  });

  it('fails closed when the user is not a member of the workspace org', async () => {
    const { env } = buildEnv({
      orgStub: {
        validateChatThreadAccess: vi
          .fn()
          .mockResolvedValue({ ok: false, reason: 'forbidden' }),
      },
    });
    const req = await buildRequest();

    const access = await requireChatWebSocketAccess(
      req,
      env,
      THREAD_ID,
      URL_WORKSPACE_ID,
    );

    expect('error' in access).toBe(true);
    if (!('error' in access)) return;
    expect(access.error.status).toBe(403);
  });

  it('retries transient workspace RPC failures before succeeding', async () => {
    const getWorkspaceRecord = vi
      .fn()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValue({
        id: URL_WORKSPACE_ID,
        org_id: URL_ORG_ID,
        archived: false,
      });
    const { env } = buildEnv({ orgStub: { getWorkspaceRecord } });
    const req = await buildRequest();

    const access = await requireChatWebSocketAccess(
      req,
      env,
      THREAD_ID,
      URL_WORKSPACE_ID,
    );

    expect('error' in access).toBe(false);
    expect('degraded' in access).toBe(false);
    expect(getWorkspaceRecord).toHaveBeenCalledTimes(2);
  });

  it('returns degraded access when authorization RPCs stay unreachable', async () => {
    const { env } = buildEnv({
      orgStub: {
        getWorkspaceRecord: vi.fn().mockRejectedValue(transientError()),
      },
    });
    const req = await buildRequest();

    const access = await requireChatWebSocketAccess(
      req,
      env,
      THREAD_ID,
      URL_WORKSPACE_ID,
    );

    expect('degraded' in access).toBe(true);
    if (!('degraded' in access)) return;
    expect(access.userId).toBe(USER_ID);
    expect(access.threadId).toBe(THREAD_ID);
  });

  it('fails closed on non-transient authorization errors', async () => {
    const { env } = buildEnv({
      orgStub: {
        getWorkspaceRecord: vi
          .fn()
          .mockRejectedValue(new Error('boom')),
      },
    });
    const req = await buildRequest();

    const access = await requireChatWebSocketAccess(
      req,
      env,
      THREAD_ID,
      URL_WORKSPACE_ID,
    );

    expect('error' in access).toBe(true);
    if (!('error' in access)) return;
    expect(access.error.status).toBe(403);
  });

  it('denies known restricted member access even when the org RPC stays unreachable', async () => {
    const { env } = buildEnv({
      orgStub: {
        getWorkspaceAccess: vi.fn().mockResolvedValue('none'),
        validateChatThreadAccess: vi.fn().mockRejectedValue(transientError()),
      },
    });
    const req = await buildRequest();

    const access = await requireChatWebSocketAccess(
      req,
      env,
      THREAD_ID,
      URL_WORKSPACE_ID,
    );

    // A denial already in hand must never be converted into degraded access.
    expect('degraded' in access).toBe(false);
    expect('error' in access).toBe(true);
    if (!('error' in access)) return;
    expect(access.error.status).toBe(403);
  });

  it('fails open when the session invalidation check is unreachable', async () => {
    const { env } = buildEnv({
      userStub: {
        getSessionInvalidatedAt: vi.fn().mockRejectedValue(transientError()),
      },
    });
    const req = await buildRequest();

    const access = await requireChatWebSocketAccess(
      req,
      env,
      THREAD_ID,
      URL_WORKSPACE_ID,
    );

    expect('error' in access).toBe(false);
    expect('degraded' in access).toBe(false);
  });

  it('does not fail open on non-transient invalidation check errors', async () => {
    const { env } = buildEnv({
      userStub: {
        getSessionInvalidatedAt: vi
          .fn()
          .mockRejectedValue(new Error('schema exploded')),
      },
    });
    const req = await buildRequest();

    await expect(
      requireChatWebSocketAccess(req, env, THREAD_ID, URL_WORKSPACE_ID),
    ).rejects.toThrow('schema exploded');
  });

  it('still rejects sessions invalidated by logout', async () => {
    const { env } = buildEnv({
      userStub: {
        getSessionInvalidatedAt: vi
          .fn()
          .mockResolvedValue(Date.now() + 60_000),
      },
    });
    const req = await buildRequest();

    const access = await requireChatWebSocketAccess(
      req,
      env,
      THREAD_ID,
      URL_WORKSPACE_ID,
    );

    expect('error' in access).toBe(true);
    if (!('error' in access)) return;
    expect(access.error.status).toBe(401);
  });
});
