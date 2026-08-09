import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();
const requireWorkspaceAccessMock = vi.fn();
const createMultipartUploadMock = vi.fn();
const r2PutMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/routes/api/workspaces.utils', () => ({
  requireWorkspaceAccess: requireWorkspaceAccessMock,
}));

const { action } = await import('@/routes/api/workspaces.$id.upload');

describe('workspace upload API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceAccessMock.mockResolvedValue({ orgId: 'org_123' });
    getEnvMock.mockReturnValue({
      CF_ACCOUNT_ID: 'selfhost',
      CF_DISPATCH_NAMESPACE: 'selfhost',
      R2_BUCKET: {
        createMultipartUpload: createMultipartUploadMock,
        put: r2PutMock,
      },
    });
  });

  it('selects direct upload mode without creating an R2 multipart upload on self-host', async () => {
    const response = await action({
      request: new Request(
        'https://camel.test/api/workspaces/ws_123/upload?action=mpu-create',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalName: 'source.zip', contentType: 'application/zip' }),
        },
      ),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      uploadMode: 'direct',
      path: expect.stringMatching(/^uploads\/source-/),
      filename: expect.stringMatching(/^source-/),
    });
    expect(createMultipartUploadMock).not.toHaveBeenCalled();
  });

  it('keeps using R2 multipart uploads outside self-host', async () => {
    getEnvMock.mockReturnValue({
      CF_ACCOUNT_ID: 'account_123',
      CF_DISPATCH_NAMESPACE: 'chiridion-platform-staging',
      R2_BUCKET: {
        createMultipartUpload: createMultipartUploadMock,
        put: r2PutMock,
      },
    });
    createMultipartUploadMock.mockResolvedValue({ uploadId: 'upload_123' });

    const response = await action({
      request: new Request(
        'https://camel.test/api/workspaces/ws_123/upload?action=mpu-create',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalName: 'source.zip', contentType: 'application/zip' }),
        },
      ),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      uploadId: 'upload_123',
      path: expect.stringMatching(/^uploads\/source-/),
      filename: expect.stringMatching(/^source-/),
    });
    expect(createMultipartUploadMock).toHaveBeenCalledOnce();
  });

  it('streams a direct self-host upload into the workspace R2 prefix', async () => {
    r2PutMock.mockResolvedValue({ size: 7, httpEtag: '"etag-1"' });
    const response = await action({
      request: new Request(
        'https://camel.test/api/workspaces/ws_123/upload?action=direct&filename=source-123.zip&originalName=source.zip',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/zip' },
          body: 'zipdata',
        },
      ),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(200);
    expect(r2PutMock).toHaveBeenCalledWith(
      'org_123/ws_123/user-uploads/source-123.zip',
      expect.any(ReadableStream),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/zip' },
        customMetadata: expect.objectContaining({ originalName: 'source.zip' }),
      }),
    );
    expect(await response.json()).toEqual({
      path: 'uploads/source-123.zip',
      filename: 'source-123.zip',
      size: 7,
      etag: '"etag-1"',
    });
  });
});
