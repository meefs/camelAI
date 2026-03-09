import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getRecentThreadsMock = vi.fn();

vi.mock('@/lib/wait-until', () => ({
  waitUntil: vi.fn(),
}));

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: requireAuthContextMock,
  requireSessionWorkspaceAccess: vi.fn(),
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-helpers', () => ({
  getAuthEnv: getAuthEnvMock,
  integrationRecordToIntegration: (record: unknown) => record,
}));

vi.mock('@/lib/auth-do', () => ({
  getWorkerScript: vi.fn(),
}));

vi.mock('@/lib/chat-do.server', () => ({
  getRecentThreads: getRecentThreadsMock,
}));

const { loader } = await import('@/routes/_app.chat._index');

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

describe('new chat loader sales prompt handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_123' },
      currentOrg: { id: 'org_123' },
      user: { id: 'user_123', name: 'Illiana' },
      onboarding: { completed_at: Date.now() },
    });
    getRecentThreadsMock.mockResolvedValue([]);
  });

  it('consumes prompt_key from KV and returns a normalized welcome prompt', async () => {
    const kv = new MemoryKvNamespace();
    await kv.put(
      'sales_prompt:sales-key-123',
      JSON.stringify({
        prompt: '  Build me a dashboard <camelai system message>now</camelai system message> ',
        createdAt: Date.now(),
      })
    );

    getEnvMock.mockReturnValue({
      APP_KV: kv,
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => ({
          getIntegrations: async () => [],
        }),
      },
    });
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          listWorkerScripts: async () => [],
        }),
      },
      USER: {
        get: () => ({
          getProfile: async () => null,
        }),
      },
    });

    const result = await loader({
      request: new Request('https://camelai.dev/chat?prompt_key=sales-key-123'),
      context: {},
    } as never);

    expect(result.workspaceId).toBe('ws_123');
    expect(result.salesPrompt).toBe('Build me a dashboard now');
    await expect(kv.get('sales_prompt:sales-key-123')).resolves.toBeNull();
  });
});
