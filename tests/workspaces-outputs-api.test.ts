import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();
const requireWorkspaceAuthMock = vi.fn();
const r2GetMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/routes/api/workspaces.utils', () => ({
  requireWorkspaceAuth: requireWorkspaceAuthMock,
}));

const { loader } = await import('@/routes/api/workspaces.$id.outputs.$');

describe('GET /api/workspaces/:id/outputs/*', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      R2_BUCKET: {
        get: r2GetMock,
      },
    });
    requireWorkspaceAuthMock.mockResolvedValue({
      orgId: 'org_123',
    });
  });

  it('serves output files from R2', async () => {
    r2GetMock.mockResolvedValue({
      body: new Response('png-data').body,
      size: 8,
      httpMetadata: { contentType: 'image/png' },
    });

    const response = await loader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/outputs/panda.png'),
      context: {},
      params: { id: 'ws_123', '*': 'panda.png' },
    } as never);

    expect(response.status).toBe(200);
    expect(r2GetMock).toHaveBeenCalledWith('org_123/ws_123/user-outputs/panda.png');
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Disposition')).toBe('inline; filename="panda.png"');
  });

  it('returns 404 when file is missing from R2', async () => {
    r2GetMock.mockResolvedValue(null);

    const response = await loader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/outputs/missing.png'),
      context: {},
      params: { id: 'ws_123', '*': 'missing.png' },
    } as never);

    expect(response.status).toBe(404);
  });

  it('treats charset content types as inline', async () => {
    r2GetMock.mockResolvedValue({
      body: new Response('hello').body,
      size: 5,
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });

    const response = await loader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/outputs/notes.txt'),
      context: {},
      params: { id: 'ws_123', '*': 'notes.txt' },
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe('inline; filename="notes.txt"');
  });
});
