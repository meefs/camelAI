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
      currentWorkspace: { id: 'ws_123' },
      onboarding: { completed_at: null },
    });
    getAuthEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    });
    getEnvMock.mockReturnValue({});
    createThreadMock.mockResolvedValue({
      id: 'thread_123',
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
      'Build me a CRM'
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
});
