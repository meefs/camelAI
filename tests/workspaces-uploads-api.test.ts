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

const { loader } = await import('@/routes/api/workspaces.$id.uploads.$');

describe('GET /api/workspaces/:id/uploads/*', () => {
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

  it('serves upload files from R2', async () => {
    r2GetMock.mockResolvedValue({
      body: new Response('pdf-data').body,
      size: 8,
      httpMetadata: { contentType: 'application/pdf' },
    });

    const response = await loader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/uploads/doc.pdf'),
      context: {},
      params: { id: 'ws_123', '*': 'doc.pdf' },
    } as never);

    expect(response.status).toBe(200);
    expect(r2GetMock).toHaveBeenCalledWith('org_123/ws_123/user-uploads/doc.pdf');
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Disposition')).toBe('inline; filename="doc.pdf"');
  });

  it('returns 404 when file is missing from R2', async () => {
    r2GetMock.mockResolvedValue(null);

    const response = await loader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/uploads/missing.csv'),
      context: {},
      params: { id: 'ws_123', '*': 'missing.csv' },
    } as never);

    expect(response.status).toBe(404);
  });
});
