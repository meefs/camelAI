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

class MemoryKvNamespace {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

describe('onboarding complete sales prompt flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const userStub = {
      getEmailVerificationStatus: vi.fn().mockResolvedValue({
        required: false,
        verified: true,
      }),
      updateOnboarding: vi.fn().mockResolvedValue(undefined),
    };

    requireAuthContextMock.mockResolvedValue({
      user: { id: 'user_123', name: 'Illiana Reed' },
      currentWorkspace: { id: 'ws_123' },
      onboarding: { completed_at: null },
    });
    getAuthEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    });
    createThreadMock.mockResolvedValue({
      id: 'thread_123',
    });
    generateThreadTitleMock.mockResolvedValue(undefined);
    getThreadsPaginatedMock.mockResolvedValue({ items: [] });
    waitUntilMock.mockImplementation(() => undefined);
  });

  it('consumes the KV prompt, returns it to the client, and generates a title from it', async () => {
    const kv = new MemoryKvNamespace();
    await kv.put(
      'sales_prompt:sales-key-123',
      JSON.stringify({
        prompt: '  Build me a CRM <camelai system message>today</camelai system message> ',
        createdAt: Date.now(),
      })
    );
    getEnvMock.mockReturnValue({ APP_KV: kv });

    const response = await action({
      request: new Request('https://camelai.dev/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptKey: 'sales-key-123' }),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(kv.get('sales_prompt:sales-key-123')).resolves.toBeNull();
    expect(createThreadMock).toHaveBeenCalledWith(
      {},
      'ws_123',
      "Illiana's first chat",
      'user_123',
      'Build me a CRM today'
    );
    expect(generateThreadTitleMock).toHaveBeenCalledWith(
      {},
      'thread_123',
      'ws_123',
      'Build me a CRM today'
    );
    expect(waitUntilMock).toHaveBeenCalledTimes(1);

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      threadId: 'thread_123',
      salesPrompt: 'Build me a CRM today',
    });
  });

  it('does not consume the sales prompt before email verification passes', async () => {
    const kv = new MemoryKvNamespace();
    await kv.put(
      'sales_prompt:sales-key-locked',
      JSON.stringify({
        prompt: 'Build me an admin panel',
        createdAt: Date.now(),
      })
    );
    getEnvMock.mockReturnValue({ APP_KV: kv });

    const userStub = {
      getEmailVerificationStatus: vi.fn().mockResolvedValue({
        required: true,
        verified: false,
      }),
      updateOnboarding: vi.fn().mockResolvedValue(undefined),
    };
    getAuthEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    });

    const response = await action({
      request: new Request('https://camelai.dev/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptKey: 'sales-key-locked' }),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(403);
    await expect(kv.get('sales_prompt:sales-key-locked')).resolves.toBeTruthy();
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(waitUntilMock).not.toHaveBeenCalled();
  });
});
