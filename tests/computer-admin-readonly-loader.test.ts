import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthContextMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const getWorkspaceMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: requireAuthContextMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-do', () => ({
  getWorkspace: getWorkspaceMock,
}));

const { loader } = await import('@/routes/_app.computer.$workspaceId');

describe('computer workspace loader adminReadonly override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({});
  });

  it('keeps normal redirect for non-superuser cross-workspace access', async () => {
    requireAuthContextMock.mockResolvedValue({
      user: { is_superuser: false },
      currentWorkspace: { id: 'ws_current' },
    });

    await expect(
      loader({
        request: new Request('https://camelai.com/computer/ws_foreign?file=%2FREADME.md'),
        context: {},
        params: { workspaceId: 'ws_foreign' },
      } as never)
    ).rejects.toSatisfy((response: unknown) => {
      return response instanceof Response
        && response.status === 302
        && response.headers.get('Location') === '/computer/ws_current';
    });
  });

  it('allows superuser adminReadonly access to foreign workspaces when workspace exists', async () => {
    requireAuthContextMock.mockResolvedValue({
      user: { is_superuser: true },
      currentWorkspace: { id: 'ws_current' },
    });
    getWorkspaceMock.mockResolvedValue({
      id: 'ws_foreign',
      org_id: 'org_foreign',
    });

    const result = await loader({
      request: new Request('https://camelai.com/computer/ws_foreign?adminReadonly=1&file=%2FREADME.md'),
      context: {},
      params: { workspaceId: 'ws_foreign' },
    } as never);

    expect(result).toEqual({ workspaceId: 'ws_foreign', readOnly: true });
  });

  it('keeps adminReadonly mode when opening the current workspace', async () => {
    requireAuthContextMock.mockResolvedValue({
      user: { is_superuser: true },
      currentWorkspace: { id: 'ws_current' },
    });

    const result = await loader({
      request: new Request('https://camelai.com/computer/ws_current?adminReadonly=1&file=%2FREADME.md'),
      context: {},
      params: { workspaceId: 'ws_current' },
    } as never);

    expect(result).toEqual({ workspaceId: 'ws_current', readOnly: true });
    expect(getWorkspaceMock).not.toHaveBeenCalled();
  });

  it('returns editable mode for normal same-workspace navigation', async () => {
    requireAuthContextMock.mockResolvedValue({
      user: { is_superuser: true },
      currentWorkspace: { id: 'ws_current' },
    });

    const result = await loader({
      request: new Request('https://camelai.com/computer/ws_current?file=%2FREADME.md'),
      context: {},
      params: { workspaceId: 'ws_current' },
    } as never);

    expect(result).toEqual({ workspaceId: 'ws_current', readOnly: false });
  });

  it('redirects to current workspace when adminReadonly workspace does not exist', async () => {
    requireAuthContextMock.mockResolvedValue({
      user: { is_superuser: true },
      currentWorkspace: { id: 'ws_current' },
    });
    getWorkspaceMock.mockResolvedValue(null);

    await expect(
      loader({
        request: new Request('https://camelai.com/computer/ws_missing?adminReadonly=1'),
        context: {},
        params: { workspaceId: 'ws_missing' },
      } as never)
    ).rejects.toSatisfy((response: unknown) => {
      return response instanceof Response
        && response.status === 302
        && response.headers.get('Location') === '/computer/ws_current';
    });
  });
});
