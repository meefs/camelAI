import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSuperuserMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const adminGetThreadWithMessagesMock = vi.fn();
const getVanityDomainMock = vi.fn();
const orgIdFromNameMock = vi.fn((id: string) => `org-id:${id}`);
const orgGetMock = vi.fn();
const getExperimentalSettingsMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireSuperuser: requireSuperuserMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-do.server', () => ({
  adminGetThreadWithMessages: adminGetThreadWithMessagesMock,
}));

vi.mock('@/lib/app-url.server', () => ({
  getVanityDomain: getVanityDomainMock,
}));

const { loader } = await import('@/routes/_admin.threads.$id');

describe('admin thread detail loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const env = { TEST_ENV: true };
    getEnvMock.mockReturnValue(env);
    getExperimentalSettingsMock.mockResolvedValue({ claude_proxy_models: true });
    orgGetMock.mockReturnValue({ getExperimentalSettings: getExperimentalSettingsMock });
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: orgIdFromNameMock,
        get: orgGetMock,
      },
    });
    getVanityDomainMock.mockResolvedValue('camelai.dev');
  });

  it('loads org experimental settings through authEnv and preserves thread provider', async () => {
    requireSuperuserMock.mockResolvedValue({
      user: { is_superuser: true },
    });
    adminGetThreadWithMessagesMock.mockResolvedValue({
      thread: {
        id: 'thread_123',
        title: 'Investigate authEnv',
        provider: 'codex',
        model: 'gpt-5.2',
        created_by: 'user_123',
        created_at: 1_710_000_000_000,
        updated_at: 1_710_000_100_000,
      },
      messages: [
        {
          id: 'msg_123',
          thread_id: 'thread_123',
          role: 'user',
          content: 'open admin detail',
          created_at: 1_710_000_000_000,
        },
      ],
      org_id: 'org_123',
      org_name: 'Acme',
      workspace_id: 'ws_123',
      workspace_name: 'Main',
      preview_target: null,
    });

    const context = { cloudflare: { env: { TEST_ENV: true } } };
    const result = await loader({
      request: new Request('https://camelai.dev/qaml-backdoor/threads/thread_123'),
      context,
      params: { id: 'thread_123' },
    } as never);

    expect(requireSuperuserMock).toHaveBeenCalledTimes(1);
    expect(getEnvMock).toHaveBeenCalledWith(context);
    expect(getAuthEnvMock).toHaveBeenCalledWith({ TEST_ENV: true });
    expect(adminGetThreadWithMessagesMock).toHaveBeenCalledWith(context, 'thread_123');
    expect(orgIdFromNameMock).toHaveBeenCalledWith('org_123');
    expect(orgGetMock).toHaveBeenCalledWith('org-id:org_123');
    expect(getExperimentalSettingsMock).toHaveBeenCalledTimes(1);
    expect(result.thread).toMatchObject({
      id: 'thread_123',
      provider: 'codex',
      model: 'gpt-5.2',
    });
    expect(result.experimentalSettings).toEqual({ claude_proxy_models: true });
    expect(result.jsonlDownloadUrl).toBe(
      '/api/admin/threads/thread_123/jsonl?orgId=org_123&workspaceId=ws_123',
    );
  });
});
