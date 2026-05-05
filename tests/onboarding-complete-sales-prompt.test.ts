import { beforeEach, describe, expect, it, vi } from 'vitest';

const waitUntilMock = vi.fn();
const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const createThreadMock = vi.fn();
const generateThreadTitleMock = vi.fn();
const getThreadsPaginatedMock = vi.fn();

vi.mock('@/lib/wait-until', () => ({
  waitUntil: waitUntilMock,
}));

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: requireAuthContextMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/chat-do.server', () => ({
  createThread: createThreadMock,
  generateThreadTitle: generateThreadTitleMock,
  getThreadsPaginated: getThreadsPaginatedMock,
}));

const { action } = await import('@/routes/api/onboarding.complete');

describe('onboarding complete sales prompt flow', () => {
  let userStub: {
    getEmailVerificationStatus: ReturnType<typeof vi.fn>;
    updateOnboarding: ReturnType<typeof vi.fn>;
    getPendingSalesPrompt: ReturnType<typeof vi.fn>;
    clearPendingSalesPrompt: ReturnType<typeof vi.fn>;
  };
  let orgStubs: Map<
    string,
    {
      getInfo: ReturnType<typeof vi.fn>;
      getLlmProviderConfig: ReturnType<typeof vi.fn>;
      getThreadsPaginated: ReturnType<typeof vi.fn>;
    }
  >;

  function createOrgStub({
    billingStatus = 'active',
    llmProviderConfig = null,
    threadTotal = 0,
  }: {
    billingStatus?: string;
    llmProviderConfig?: unknown;
    threadTotal?: number;
  } = {}) {
    return {
      getInfo: vi.fn().mockResolvedValue({ billing_status: billingStatus }),
      getLlmProviderConfig: vi.fn().mockResolvedValue(llmProviderConfig),
      getThreadsPaginated: vi.fn().mockResolvedValue({
        items: [],
        total: threadTotal,
        offset: 0,
        limit: 1,
      }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    userStub = {
      getEmailVerificationStatus: vi.fn().mockResolvedValue({
        required: false,
        verified: true,
      }),
      updateOnboarding: vi.fn().mockResolvedValue(undefined),
      getPendingSalesPrompt: vi.fn().mockReturnValue(null),
      clearPendingSalesPrompt: vi.fn(),
    };

    requireAuthContextMock.mockResolvedValue({
      user: { id: 'user_123', name: 'Illiana Reed' },
      currentOrg: { id: 'org_123' },
      currentWorkspace: { id: 'ws_123' },
      orgs: [{ org_id: 'org_123' }],
      onboarding: { completed_at: null },
    });
    orgStubs = new Map([['org_123', createOrgStub()]]);
    getAuthEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: (id: string) => {
          let stub = orgStubs.get(id);
          if (!stub) {
            stub = createOrgStub();
            orgStubs.set(id, stub);
          }
          return stub;
        },
      },
    });
    getEnvMock.mockReturnValue({});
    createThreadMock.mockResolvedValue({
      id: 'thread_123',
      provider: 'claude',
    });
    generateThreadTitleMock.mockResolvedValue(undefined);
    getThreadsPaginatedMock.mockResolvedValue({ items: [] });
    waitUntilMock.mockImplementation(() => undefined);
  });

  it('reads the sales prompt from UserDO, returns it, and generates a title', async () => {
    userStub.getPendingSalesPrompt.mockReturnValue('Build me a CRM');

    const response = await action({
      request: new Request('https://camelai.dev/api/onboarding/complete', {
        method: 'POST',
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(userStub.clearPendingSalesPrompt).toHaveBeenCalled();
    expect(createThreadMock).toHaveBeenCalledWith(
      {},
      'ws_123',
      "Illiana's first chat",
      'user_123',
      'Build me a CRM',
      undefined,
    );
    expect(generateThreadTitleMock).toHaveBeenCalledWith(
      {},
      'thread_123',
      'ws_123',
      'Build me a CRM'
    );
    expect(waitUntilMock).toHaveBeenCalledTimes(1);

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      threadId: 'thread_123',
      salesPrompt: 'Build me a CRM',
    });
  });

  it('does not consume the sales prompt before email verification passes', async () => {
    userStub.getPendingSalesPrompt.mockReturnValue('Build me an admin panel');
    userStub.getEmailVerificationStatus.mockResolvedValue({
      required: true,
      verified: false,
    });

    const response = await action({
      request: new Request('https://camelai.dev/api/onboarding/complete', {
        method: 'POST',
      }),
      context: {},
    } as never);

    expect(response.status).toBe(403);
    expect(userStub.clearPendingSalesPrompt).not.toHaveBeenCalled();
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(waitUntilMock).not.toHaveBeenCalled();
  });

  it('works normally when no sales prompt is stored', async () => {
    const response = await action({
      request: new Request('https://camelai.dev/api/onboarding/complete', {
        method: 'POST',
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(userStub.clearPendingSalesPrompt).not.toHaveBeenCalled();

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      threadId: 'thread_123',
      salesPrompt: null,
    });
  });

  it('allows configured enterprise org slugs through the onboarding billing gate', async () => {
    orgStubs.set('org_123', {
      ...createOrgStub({ billingStatus: 'inactive' }),
      getInfo: vi.fn().mockResolvedValue({
        id: 'org_123',
        name: 'Enterprise Customer',
        slug: 'enterprise-customer',
        billing_status: 'inactive',
        billing_plan: 'free',
      }),
    });
    getEnvMock.mockReturnValue({
      BILLING_ENTERPRISE_ORG_SLUGS: 'enterprise-customer',
    });

    const response = await action({
      request: new Request('https://camelai.dev/api/onboarding/complete', {
        method: 'POST',
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(createThreadMock).toHaveBeenCalled();
  });

  it('does not start the first-chat flow for BYOK when the user already has a chat', async () => {
    orgStubs.set(
      'org_123',
      createOrgStub({
        llmProviderConfig: { provider: 'openai' },
        threadTotal: 1,
      }),
    );
    requireAuthContextMock.mockResolvedValue({
      user: { id: 'user_123', name: 'Illiana Reed' },
      currentOrg: { id: 'org_123' },
      currentWorkspace: { id: 'ws_123' },
      orgs: [{ org_id: 'org_123' }],
      onboarding: { completed_at: Date.now() },
    });

    const response = await action({
      request: new Request('https://camelai.dev/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessChoice: 'byok' }),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(userStub.updateOnboarding).not.toHaveBeenCalled();
    expect(userStub.clearPendingSalesPrompt).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectTo: '/chat',
    });
  });

  it('marks onboarding complete without first-chat flow when prior chats exist in another org', async () => {
    orgStubs.set(
      'org_123',
      createOrgStub({ llmProviderConfig: { provider: 'openai' } }),
    );
    orgStubs.set('org_other', createOrgStub({ threadTotal: 1 }));
    requireAuthContextMock.mockResolvedValue({
      user: { id: 'user_123', name: 'Illiana Reed' },
      currentOrg: { id: 'org_123' },
      currentWorkspace: { id: 'ws_123' },
      orgs: [{ org_id: 'org_123' }, { org_id: 'org_other' }],
      onboarding: { completed_at: null },
    });

    const response = await action({
      request: new Request('https://camelai.dev/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessChoice: 'byok' }),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(userStub.updateOnboarding).toHaveBeenCalledWith({
      completed_at: expect.any(Number),
    });
    expect(createThreadMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectTo: '/chat',
    });
  });
});
