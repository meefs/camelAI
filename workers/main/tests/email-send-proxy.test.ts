import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEmailSendProxy } from '../src/routes/email-send-proxy.js';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function buildRouteContext(req: Request, env: Record<string, unknown>) {
  return {
    req,
    env: env as never,
    ctx: { waitUntil: (_p: Promise<unknown>) => undefined } as never,
    url: new URL(req.url),
    match: [] as unknown as RegExpMatchArray,
  };
}

function makeWorkspaceStub(
  allMembers: Array<{ user_id: string; access_level: string }>,
  rateAllowed = true
) {
  return {
    getInfo: vi.fn(async () => ({
      id: 'ws-1',
      org_id: 'org-1',
      name: 'Test Workspace',
      email_handle: 'swift-tiger-moon',
      created_by: 'u1',
      created_at: Date.now(),
      avatar: { type: 'initials', bg: '#000', fg: '#fff', initials: 'TW' },
      compute_tier: 'standard',
    })),
    listMembers: vi.fn(async () => allMembers),
    checkAndRecordEmailSendRateLimit: vi.fn(() => rateAllowed
      ? { allowed: true }
      : { allowed: false, reason: 'Hourly email limit exceeded (50/hour)' }
    ),
  };
}

function makeUserStub(email: string) {
  return {
    getProfile: vi.fn(async () => ({
      id: 'user-' + email,
      email,
      name: email.split('@')[0],
      created_at: Date.now(),
      is_superuser: false,
      avatar: { type: 'initials', bg: '#000', fg: '#fff', initials: 'AB' },
      is_orphaned: false,
      orphaned_at: null,
      email_verified_at: Date.now(),
    })),
  };
}

const SANDBOX_HEADERS = {
  'Content-Type': 'application/json',
  'x-sandbox-secret': 'test-secret',
  'x-chiridion-org-id': 'org-1',
  'x-chiridion-workspace-id': 'ws-1',
};

function makeRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new Request('https://camelai.dev/api/email/send', {
    method: 'POST',
    headers: { ...SANDBOX_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

// Map of userId → email for workspace members
const MEMBERS = [
  { user_id: 'u1', email: 'alice@example.com' },
  { user_id: 'u2', email: 'bob@example.com' },
];

let emailSendMock: ReturnType<typeof vi.fn>;

function createMockKvStore(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial || {}));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    _store: store,
  };
}

function buildEnv(overrides: {
  rateAllowed?: boolean;
  workspaceMembers?: Array<{ user_id: string; access_level: string }>;
  billingPlan?: string;
  billingStatus?: string;
  thread?: Record<string, unknown> | null;
  appKvInitial?: Record<string, string>;
  [key: string]: unknown;
} = {}) {
  const {
    rateAllowed,
    workspaceMembers,
    billingPlan,
    billingStatus,
    thread,
    appKvInitial,
    ...rest
  } = overrides;
  // Default: all MEMBERS have full access
  const allMembers = workspaceMembers ?? MEMBERS.map((m) => ({ user_id: m.user_id, access_level: 'full' }));
  const workspaceStub = makeWorkspaceStub(allMembers, rateAllowed !== false);
  const orgStub = {
    getInfo: vi.fn(async () => ({
      id: 'org-1',
      billing_plan: billingPlan ?? 'starter',
      billing_status: billingStatus ?? 'active',
    })),
    getThread: vi.fn(async (threadId: string) =>
      thread && (thread.id === threadId || !thread.id) ? thread : null
    ),
    listWorkspaceMembers: vi.fn(async () => allMembers),
  };
  const appKvStore = createMockKvStore(appKvInitial);

  const userStubs = new Map<string, ReturnType<typeof makeUserStub>>();
  for (const m of MEMBERS) {
    userStubs.set(m.user_id, makeUserStub(m.email));
  }

  return {
    SANDBOX_PROXY_SECRET: 'test-secret',
    EMAIL: { send: emailSendMock },
    WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
    WORKSPACE: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => workspaceStub),
    },
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
    APP_KV: appKvStore,
    USER: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn((id: string) => userStubs.get(id) ?? makeUserStub('unknown@example.com')),
    },
    ...rest,
    _workspaceStub: workspaceStub,
    _orgStub: orgStub,
    _appKvStore: appKvStore,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('email-send-proxy route', () => {
  beforeEach(() => {
    emailSendMock = vi.fn(async () => ({ messageId: 'msg-123' }));
  });

  it('rejects without sandbox proxy auth', async () => {
    const req = new Request('https://camelai.dev/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'alice@example.com', subject: 'Hi' }),
    });

    const res = await handleEmailSendProxy(buildRouteContext(req, buildEnv()));
    expect(res.status).toBe(401);
  });

  it('rejects when EMAIL is not set', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(makeRequest({ to: 'alice@example.com', subject: 'Hi' }), buildEnv({ EMAIL: undefined }))
    );
    expect(res.status).toBe(503);
  });

  it('rejects self-host delivery even when an EMAIL binding exists', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({ to: 'alice@example.com', subject: 'Hi', text: 'Hello!' }),
        buildEnv({ CF_ACCOUNT_ID: 'selfhost' }),
      ),
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error:
        'Outbound email is disabled in self-host mode. No SMTP transport is implemented.',
    });
    expect(emailSendMock).not.toHaveBeenCalled();
  });

  it('rejects malformed recipient types', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({ to: 123 as any, subject: 'Hi' }),
        buildEnv()
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid recipient field');
  });

  it('rejects Pay as you go orgs before sending email', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({ to: 'alice@example.com', subject: 'Hi', text: 'Hello!' }),
        buildEnv({ billingPlan: 'payg' })
      )
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan',
    });
    expect(emailSendMock).not.toHaveBeenCalled();
  });

  it('rejects array with non-string elements', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({ to: ['alice@example.com', 42] as any, subject: 'Hi' }),
        buildEnv()
      )
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON body', async () => {
    const req = new Request('https://camelai.dev/api/email/send', {
      method: 'POST',
      headers: { ...SANDBOX_HEADERS },
      body: 'not json',
    });
    const res = await handleEmailSendProxy(buildRouteContext(req, buildEnv()));
    expect(res.status).toBe(400);
  });

  it('rejects missing required fields', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(makeRequest({}), buildEnv())
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required fields: to, subject' });
  });

  it('rejects recipients not in workspace', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({ to: 'outsider@evil.com', subject: 'Hi' }),
        buildEnv()
      )
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('outsider@evil.com');
    expect(body.error).toContain('Only workspace members');
  });

  it('rejects when cc/bcc contains non-member', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: 'alice@example.com',
          cc: 'outsider@evil.com',
          subject: 'Hi',
        }),
        buildEnv()
      )
    );
    expect(res.status).toBe(403);
  });

  it('rejects array reply_to because Cloudflare Email Sending accepts a single reply-to address', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: 'alice@example.com',
          subject: 'Hi',
          reply_to: ['alice@example.com'],
          text: 'Hello!',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('reply_to must be a string');
    expect(emailSendMock).not.toHaveBeenCalled();
  });

  it('rejects when rate limited', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({ to: 'alice@example.com', subject: 'Hi' }),
        buildEnv({ rateAllowed: false })
      )
    );
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('limit exceeded');
  });

  it('forwards valid Starter request to Cloudflare Email Sending with workspace from address', async () => {
    const env = buildEnv();
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: 'alice@example.com',
          subject: 'Hello Alice',
          text: 'Hello!',
        }),
        env
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg-123', from: 'Camel <swift-tiger-moon@camelai.dev>' });

    expect(emailSendMock).toHaveBeenCalledTimes(1);
    const sentBody = emailSendMock.mock.calls[0]?.[0];
    expect(sentBody.to).toEqual(['alice@example.com']);
    expect(sentBody.subject).toBe('Hello Alice');
    // from is always the workspace address, not caller-supplied
    expect(sentBody.from).toBe('Camel <swift-tiger-moon@camelai.dev>');
  });

  it('adds RFC reply headers for sandbox sends from email-originated threads', async () => {
    const env = buildEnv({
      thread: {
        id: 'thread-1',
        workspace_id: 'ws-1',
        source: 'channel',
        channel_kind: 'email',
        channel_connection_id: 'swift-tiger-moon@camelai.dev',
        channel_conversation_id: 'message:first-user@example.com',
        channel_message_id: 'first-user@example.com',
      },
      appKvInitial: {
        'email_thread_refs:ws-1:thread-1': JSON.stringify([
          'first-user@example.com',
          'latest-user@example.com',
        ]),
      },
    });
    emailSendMock.mockResolvedValueOnce({ messageId: 'camel-reply@example.com' });

    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest(
          {
            to: 'alice@example.com',
            subject: 'Re: Need help',
            text: 'Here is the answer.',
          },
          { 'x-chiridion-thread-id': 'thread-1' },
        ),
        env,
      ),
    );

    expect(res.status).toBe(200);
    const sentBody = emailSendMock.mock.calls[0]?.[0];
    expect(sentBody.headers).toEqual({
      'In-Reply-To': '<latest-user@example.com>',
      References: '<first-user@example.com> <latest-user@example.com>',
    });
    expect(env._appKvStore.put).toHaveBeenCalledWith(
      'email_reply_ref:ws-1:camel-reply@example.com',
      'thread-1',
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(env._appKvStore.put).toHaveBeenCalledWith(
      'email_thread_refs:ws-1:thread-1',
      JSON.stringify([
        'first-user@example.com',
        'latest-user@example.com',
        'camel-reply@example.com',
      ]),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('adds RFC reply headers for sandbox sends from outbound-originated threads with stored refs', async () => {
    const env = buildEnv({
      thread: {
        id: 'thread-1',
        workspace_id: 'ws-1',
        source: 'web',
        channel_kind: null,
        channel_connection_id: null,
        channel_conversation_id: null,
        channel_message_id: null,
      },
      appKvInitial: {
        'email_thread_refs:ws-1:thread-1': JSON.stringify([
          'first-camel-email@example.com',
          'recipient-reply@example.com',
        ]),
      },
    });
    emailSendMock.mockResolvedValueOnce({ messageId: 'second-camel-reply@example.com' });

    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest(
          {
            to: 'alice@example.com',
            subject: 'Re: Need help',
            text: 'Here is the follow-up.',
          },
          { 'x-chiridion-thread-id': 'thread-1' },
        ),
        env,
      ),
    );

    expect(res.status).toBe(200);
    const sentBody = emailSendMock.mock.calls[0]?.[0];
    expect(sentBody.headers).toEqual({
      'In-Reply-To': '<recipient-reply@example.com>',
      References: '<first-camel-email@example.com> <recipient-reply@example.com>',
    });
    expect(sentBody).not.toHaveProperty('replyTo');
    expect(env._appKvStore.put).toHaveBeenCalledWith(
      'email_thread_refs:ws-1:thread-1',
      JSON.stringify([
        'first-camel-email@example.com',
        'recipient-reply@example.com',
        'second-camel-reply@example.com',
      ]),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('seeds thread refs for the first sandbox email from an outbound-originated thread', async () => {
    const env = buildEnv({
      thread: {
        id: 'thread-1',
        workspace_id: 'ws-1',
        source: 'web',
        channel_kind: null,
        channel_connection_id: null,
        channel_conversation_id: null,
        channel_message_id: null,
      },
    });

    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest(
          {
            to: 'alice@example.com',
            subject: 'Need help',
            text: 'Starting the email conversation.',
          },
          { 'x-chiridion-thread-id': 'thread-1' },
        ),
        env,
      ),
    );

    expect(res.status).toBe(200);
    expect(emailSendMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
    expect(env._appKvStore.put).toHaveBeenCalledWith(
      'email_thread_refs:ws-1:thread-1',
      JSON.stringify(['msg-123']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('returns sent when post-send metadata persistence fails', async () => {
    const env = buildEnv({
      thread: {
        id: 'thread-1',
        workspace_id: 'ws-1',
        source: 'web',
        channel_kind: null,
        channel_connection_id: null,
        channel_conversation_id: null,
        channel_message_id: null,
      },
    });
    env.APP_KV.put = vi.fn(async () => {
      throw new Error('KV unavailable');
    });
    emailSendMock.mockResolvedValueOnce({ messageId: 'sent-before-kv-failed@example.com' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await handleEmailSendProxy(
        buildRouteContext(
          makeRequest(
            {
              to: 'alice@example.com',
              subject: 'Status',
              text: 'Here is the update.',
            },
            { 'x-chiridion-thread-id': 'thread-1' },
          ),
          env,
        ),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: 'sent-before-kv-failed@example.com',
        from: 'Camel <swift-tiger-moon@camelai.dev>',
      });
      expect(emailSendMock).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[email-send-proxy] failed to persist email thread metadata',
        expect.objectContaining({
          error: 'KV unavailable',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          messageId: 'sent-before-kv-failed@example.com',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('sends without RFC thread headers when pre-send metadata read fails', async () => {
    const env = buildEnv({
      thread: {
        id: 'thread-1',
        workspace_id: 'ws-1',
        source: 'web',
        channel_kind: null,
        channel_connection_id: null,
        channel_conversation_id: null,
        channel_message_id: null,
      },
    });
    env.APP_KV.get = vi.fn(async () => {
      throw new Error('KV read unavailable');
    });
    emailSendMock.mockResolvedValueOnce({ messageId: 'sent-without-refs@example.com' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await handleEmailSendProxy(
        buildRouteContext(
          makeRequest(
            {
              to: 'alice@example.com',
              subject: 'Status',
              text: 'Here is the update.',
            },
            { 'x-chiridion-thread-id': 'thread-1' },
          ),
          env,
        ),
      );

      expect(res.status).toBe(200);
      expect(emailSendMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
      expect(consoleError).toHaveBeenCalledWith(
        '[email-send-proxy] failed to read email thread metadata',
        expect.objectContaining({
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          error: 'KV read unavailable',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not use non-email channel message ids as sandbox email reply headers', async () => {
    const env = buildEnv({
      thread: {
        id: 'thread-1',
        workspace_id: 'ws-1',
        source: 'channel',
        channel_kind: 'telegram',
        channel_connection_id: 'telegram-bot-1',
        channel_conversation_id: '12345',
        channel_message_id: '998877',
      },
    });

    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest(
          {
            to: 'alice@example.com',
            subject: 'Status',
            text: 'Here is the update.',
          },
          { 'x-chiridion-thread-id': 'thread-1' },
        ),
        env,
      ),
    );

    expect(res.status).toBe(200);
    expect(emailSendMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
    expect(env._appKvStore.put).toHaveBeenCalledWith(
      'email_thread_refs:ws-1:thread-1',
      JSON.stringify(['msg-123']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('skips RFC reply headers for sandbox sends when the thread has no real message id', async () => {
    const env = buildEnv({
      thread: {
        id: 'thread-1',
        workspace_id: 'ws-1',
        source: 'channel',
        channel_kind: 'email',
        channel_connection_id: 'swift-tiger-moon@camelai.dev',
        channel_conversation_id: 'message:8ad1518c-43e7-4b52-a4f2-80ee74d5b9f8',
        channel_message_id: null,
      },
    });

    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest(
          {
            to: 'alice@example.com',
            subject: 'Re: Need help',
            text: 'Here is the answer.',
          },
          { 'x-chiridion-thread-id': 'thread-1' },
        ),
        env,
      ),
    );

    expect(res.status).toBe(200);
    expect(emailSendMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
    expect(env._appKvStore.put).toHaveBeenCalledWith(
      'email_thread_refs:ws-1:thread-1',
      JSON.stringify(['msg-123']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('ignores caller-supplied from and uses workspace address', async () => {
    const env = buildEnv();
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: 'alice@example.com',
          subject: 'Hi',
          from: 'Attacker <evil@hacker.com>',
          text: 'Hello!',
        }),
        env
      )
    );

    expect(res.status).toBe(200);
    const sentBody = emailSendMock.mock.calls[0]?.[0];
    expect(sentBody.from).toBe('Camel <swift-tiger-moon@camelai.dev>');
  });

  it('allows sending to multiple workspace members', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: ['alice@example.com', 'bob@example.com'],
          subject: 'Team update',
          html: '<p>Update</p>',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(200);
  });

  it('is case-insensitive for email matching', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Alice@Example.COM',
          subject: 'Hi',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(200);
  });

  it('extracts email from "Name <email>" formatted recipients', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Alice Smith <alice@example.com>',
          subject: 'Hi',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(200);
  });

  it('extracts email from formatted recipients in arrays', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: ['Alice <alice@example.com>', 'Bob <bob@example.com>'],
          subject: 'Hi',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(200);
  });

  it('rejects formatted recipient with non-member email', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Outsider <outsider@evil.com>',
          subject: 'Hi',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(403);
  });

  it('excludes members with workspace access_level=none from whitelist', async () => {
    // bob (u2) is blocked at the workspace level
    const env = buildEnv({
      workspaceMembers: [
        { user_id: 'u1', access_level: 'full' },
        { user_id: 'u2', access_level: 'none' },
      ],
    });

    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({ to: 'bob@example.com', subject: 'Hi' }),
        env
      )
    );

    // bob (u2) has access=none in workspace, so should be rejected
    expect(res.status).toBe(403);
  });

  it('rejects comma-separated address smuggling in a single string', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Alice <alice@example.com>, outsider@evil.com',
          subject: 'Hi',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid recipient field');
  });

  it('rejects multiple angle-bracket address smuggling', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: '<alice@example.com> <outsider@evil.com>',
          subject: 'Hi',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(400);
  });

  it('forwards sanitized emails to Cloudflare Email Sending (not raw payload)', async () => {
    const env = buildEnv();
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Alice Smith <Alice@Example.com>',
          subject: 'Hello',
          text: 'Hello!',
        }),
        env
      )
    );

    expect(res.status).toBe(200);
    const sentBody = emailSendMock.mock.calls[0]?.[0];
    // Should be sanitized bare email, not the raw "Alice Smith <Alice@Example.com>"
    expect(sentBody.to).toEqual(['alice@example.com']);
  });

  it('allows org members with default (implicit full) workspace access', async () => {
    // No workspace restrictions — both org members should be allowed
    const env = buildEnv();

    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({
          to: ['alice@example.com', 'bob@example.com'],
          subject: 'Hi',
        }),
        env
      )
    );

    expect(res.status).toBe(200);
  });

  it('uses the simple Camel sender name regardless of workspace name punctuation', async () => {
    const env = buildEnv();
    // Override getInfo to return a name with commas
    env._workspaceStub.getInfo.mockResolvedValue({
      id: 'ws-1',
      org_id: 'org-1',
      name: 'Acme, Inc',
      email_handle: 'swift-tiger-moon',
      created_by: 'u1',
      created_at: Date.now(),
      avatar: { type: 'initials', bg: '#000', fg: '#fff', initials: 'AI' },
      compute_tier: 'standard',
    });

    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({ to: 'alice@example.com', subject: 'Hi', text: 'Hello' }),
        env
      )
    );

    expect(res.status).toBe(200);
    const sentBody = emailSendMock.mock.calls[0]?.[0];
    expect(sentBody.from).toBe('Camel <swift-tiger-moon@camelai.dev>');
  });

  it('returns 503 when workspace email is not configured', async () => {
    const res = await handleEmailSendProxy(
      buildRouteContext(
        makeRequest({ to: 'alice@example.com', subject: 'Hi' }),
        buildEnv({ WORKSPACE_EMAIL_DOMAIN: undefined })
      )
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Workspace email not configured');
  });
});
