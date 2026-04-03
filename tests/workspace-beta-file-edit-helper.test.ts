import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

vi.mock('@cloudflare/containers', () => ({
  Container: class {},
}));

vi.mock('@/lib/auth.server', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: vi.fn(),
}));

vi.mock('@/lib/auth-do', () => ({
  getWorkspace: vi.fn(),
  getWorkspaceAccess: vi.fn(),
}));

const { blockBetaFileEdit } = await import('@/routes/api/workspaces.utils');

describe('blockBetaFileEdit', () => {
  it('returns the beta 403 response payload', async () => {
    const response = blockBetaFileEdit();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'File editing is disabled during beta.',
    });
  });
});
