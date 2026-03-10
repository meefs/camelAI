import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleResendProxy } from '../src/routes/resend-proxy.js';

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
    listMembers: vi.fn(async () => allMembers),
    checkAndRecordResendRateLimit: vi.fn(() => rateAllowed
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

function makeRequest(body: Record<string, unknown>) {
  return new Request('https://camelai.dev/api/resend/emails', {
    method: 'POST',
    headers: SANDBOX_HEADERS,
    body: JSON.stringify(body),
  });
}

// Map of userId → email for workspace members
const MEMBERS = [
  { user_id: 'u1', email: 'alice@example.com' },
  { user_id: 'u2', email: 'bob@example.com' },
];

function buildEnv(overrides: {
  rateAllowed?: boolean;
  workspaceMembers?: Array<{ user_id: string; access_level: string }>;
  [key: string]: unknown;
} = {}) {
  const { rateAllowed, workspaceMembers, ...rest } = overrides;
  // Default: all MEMBERS have full access
  const allMembers = workspaceMembers ?? MEMBERS.map((m) => ({ user_id: m.user_id, access_level: 'full' }));
  const workspaceStub = makeWorkspaceStub(allMembers, rateAllowed !== false);

  const userStubs = new Map<string, ReturnType<typeof makeUserStub>>();
  for (const m of MEMBERS) {
    userStubs.set(m.user_id, makeUserStub(m.email));
  }

  return {
    SANDBOX_PROXY_SECRET: 'test-secret',
    RESEND_API_KEY: 'test-resend-key',
    WORKSPACE: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => workspaceStub),
    },
    USER: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn((id: string) => userStubs.get(id) ?? makeUserStub('unknown@example.com')),
    },
    ...rest,
    _workspaceStub: workspaceStub,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resend-proxy route', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'msg-123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('rejects without sandbox proxy auth', async () => {
    const req = new Request('https://camelai.dev/api/resend/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'alice@example.com', subject: 'Hi' }),
    });

    const res = await handleResendProxy(buildRouteContext(req, buildEnv()));
    expect(res.status).toBe(401);
  });

  it('rejects when RESEND_API_KEY is not set', async () => {
    const res = await handleResendProxy(
      buildRouteContext(makeRequest({ to: 'alice@example.com', subject: 'Hi' }), buildEnv({ RESEND_API_KEY: undefined }))
    );
    expect(res.status).toBe(503);
  });

  it('rejects malformed recipient types', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({ to: 123 as any, subject: 'Hi', from: 'app@example.com' }),
        buildEnv()
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid recipient field');
  });

  it('rejects array with non-string elements', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({ to: ['alice@example.com', 42] as any, subject: 'Hi', from: 'app@example.com' }),
        buildEnv()
      )
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON body', async () => {
    const req = new Request('https://camelai.dev/api/resend/emails', {
      method: 'POST',
      headers: { ...SANDBOX_HEADERS },
      body: 'not json',
    });
    const res = await handleResendProxy(buildRouteContext(req, buildEnv()));
    expect(res.status).toBe(400);
  });

  it('rejects missing required fields', async () => {
    const res = await handleResendProxy(
      buildRouteContext(makeRequest({ from: 'noreply@example.com' }), buildEnv())
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required fields: to, subject' });
  });

  it('rejects recipients not in workspace', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({ to: 'outsider@evil.com', subject: 'Hi', from: 'app@example.com' }),
        buildEnv()
      )
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('outsider@evil.com');
    expect(body.error).toContain('Only workspace members');
  });

  it('rejects when cc/bcc contains non-member', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: 'alice@example.com',
          cc: 'outsider@evil.com',
          subject: 'Hi',
          from: 'app@example.com',
        }),
        buildEnv()
      )
    );
    expect(res.status).toBe(403);
  });

  it('rejects when rate limited', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({ to: 'alice@example.com', subject: 'Hi', from: 'app@example.com' }),
        buildEnv({ rateAllowed: false })
      )
    );
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('limit exceeded');
  });

  it('forwards valid request to Resend API', async () => {
    const env = buildEnv();
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: 'alice@example.com',
          subject: 'Hello Alice',
          from: 'MyApp <noreply@example.com>',
          text: 'Hello!',
        }),
        env
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg-123' });

    // Verify Resend was called correctly
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer test-resend-key');
    const sentBody = JSON.parse(init.body);
    expect(sentBody.to).toEqual(['alice@example.com']);
    expect(sentBody.subject).toBe('Hello Alice');
  });

  it('allows sending to multiple workspace members', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: ['alice@example.com', 'bob@example.com'],
          subject: 'Team update',
          from: 'app@example.com',
          html: '<p>Update</p>',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(200);
  });

  it('is case-insensitive for email matching', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Alice@Example.COM',
          subject: 'Hi',
          from: 'app@example.com',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(200);
  });

  it('extracts email from "Name <email>" formatted recipients', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Alice Smith <alice@example.com>',
          subject: 'Hi',
          from: 'app@example.com',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(200);
  });

  it('extracts email from formatted recipients in arrays', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: ['Alice <alice@example.com>', 'Bob <bob@example.com>'],
          subject: 'Hi',
          from: 'app@example.com',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(200);
  });

  it('rejects formatted recipient with non-member email', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Outsider <outsider@evil.com>',
          subject: 'Hi',
          from: 'app@example.com',
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

    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({ to: 'bob@example.com', subject: 'Hi', from: 'app@example.com' }),
        env
      )
    );

    // bob (u2) has access=none in workspace, so should be rejected
    expect(res.status).toBe(403);
  });

  it('rejects comma-separated address smuggling in a single string', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Alice <alice@example.com>, outsider@evil.com',
          subject: 'Hi',
          from: 'app@example.com',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid recipient field');
  });

  it('rejects multiple angle-bracket address smuggling', async () => {
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: '<alice@example.com> <outsider@evil.com>',
          subject: 'Hi',
          from: 'app@example.com',
        }),
        buildEnv()
      )
    );

    expect(res.status).toBe(400);
  });

  it('forwards sanitized emails to Resend (not raw payload)', async () => {
    const env = buildEnv();
    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: 'Alice Smith <Alice@Example.com>',
          subject: 'Hello',
          from: 'MyApp <noreply@example.com>',
          text: 'Hello!',
        }),
        env
      )
    );

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(init.body);
    // Should be sanitized bare email, not the raw "Alice Smith <Alice@Example.com>"
    expect(sentBody.to).toEqual(['alice@example.com']);
  });

  it('allows org members with default (implicit full) workspace access', async () => {
    // No workspace restrictions — both org members should be allowed
    const env = buildEnv();

    const res = await handleResendProxy(
      buildRouteContext(
        makeRequest({
          to: ['alice@example.com', 'bob@example.com'],
          subject: 'Hi',
          from: 'app@example.com',
        }),
        env
      )
    );

    expect(res.status).toBe(200);
  });
});
