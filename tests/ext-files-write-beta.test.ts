import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();
const requireBearerAuthMock = vi.fn();
const getContainerMock = vi.fn();
const blockBetaFileEditMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/ext-api.server', () => ({
  requireBearerAuth: requireBearerAuthMock,
  getContainer: getContainerMock,
  err: (error: string, status = 400, details?: string) =>
    Response.json({ error, ...(details ? { details } : {}) }, { status }),
}));

vi.mock('@/routes/api/workspaces.utils', () => ({
  blockBetaFileEdit: blockBetaFileEditMock,
}));

const { action } = await import('@/routes/api/ext.files.write');

describe('PUT /api/ext/files/write during beta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({ APP_KV: {} });
    requireBearerAuthMock.mockResolvedValue({
      org_id: 'org_123',
      workspace_id: 'ws_123',
    });
    blockBetaFileEditMock.mockImplementation(() =>
      Response.json(
        { error: 'File editing is disabled during beta.' },
        { status: 403 }
      )
    );
  });

  it('returns the beta 403 block after bearer auth and before parsing the body', async () => {
    const request = new Request('https://camelai.com/api/ext/files/write', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: '{invalid json',
    });
    const context = {};

    const response = await action({
      request,
      context,
      params: {},
    } as never);

    expect(getEnvMock).toHaveBeenCalledWith(context);
    expect(requireBearerAuthMock).toHaveBeenCalledWith(request, { APP_KV: {} });
    expect(blockBetaFileEditMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'File editing is disabled during beta.',
    });
  });
});
