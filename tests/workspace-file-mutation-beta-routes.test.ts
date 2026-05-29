import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireWorkspaceAuthMock = vi.fn();
const blockFileEditMock = vi.fn();

vi.mock('@/routes/api/workspaces.utils', () => ({
  requireWorkspaceAuth: requireWorkspaceAuthMock,
  blockFileEdit: blockFileEditMock,
  resolveContainerPathForWrite: vi.fn(),
  normalizeWorkspacePath: vi.fn((path?: string | null) => path ?? '/'),
  resolveContainerPath: vi.fn(),
  toContainerPath: vi.fn((path: string) => path),
}));

const writeRoute = await import('@/routes/api/workspaces.$id.fs.write');
const createRoute = await import('@/routes/api/workspaces.$id.fs.create');
const mkdirRoute = await import('@/routes/api/workspaces.$id.fs.mkdir');
const uploadRoute = await import('@/routes/api/workspaces.$id.fs.upload');
const moveRoute = await import('@/routes/api/workspaces.$id.fs.move');
const deleteRoute = await import('@/routes/api/workspaces.$id.fs.delete');

const blockedResponse = () =>
  Response.json(
    { error: 'File editing is disabled.' },
    { status: 403 }
  );

describe('workspace file mutation routes while file editing is disabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceAuthMock.mockResolvedValue({});
    blockFileEditMock.mockImplementation(blockedResponse);
  });

  it.each([
    [
      'POST /api/workspaces/:id/fs/write',
      writeRoute.action,
      new Request('https://camelai.com/api/workspaces/ws_123/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      }),
    ],
    [
      'POST /api/workspaces/:id/fs/create',
      createRoute.action,
      new Request('https://camelai.com/api/workspaces/ws_123/fs/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      }),
    ],
    [
      'POST /api/workspaces/:id/fs/mkdir',
      mkdirRoute.action,
      new Request('https://camelai.com/api/workspaces/ws_123/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      }),
    ],
    [
      'POST /api/workspaces/:id/fs/upload',
      uploadRoute.action,
      new Request('https://camelai.com/api/workspaces/ws_123/fs/upload', {
        method: 'POST',
        body: 'not form data',
      }),
    ],
    [
      'POST /api/workspaces/:id/fs/move',
      moveRoute.action,
      new Request('https://camelai.com/api/workspaces/ws_123/fs/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      }),
    ],
    [
      'POST /api/workspaces/:id/fs/delete',
      deleteRoute.action,
      new Request('https://camelai.com/api/workspaces/ws_123/fs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      }),
    ],
  ])('%s returns the file editing 403 block before parsing the body', async (_label, action, request) => {
    const context = {};

    const response = await action({
      request,
      context,
      params: { id: 'ws_123' },
    } as never);

    expect(requireWorkspaceAuthMock).toHaveBeenCalledWith(
      request,
      context,
      'ws_123',
      { requireWrite: true }
    );
    expect(blockFileEditMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'File editing is disabled.',
    });
  });
});
