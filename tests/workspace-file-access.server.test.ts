import { beforeEach, describe, expect, it, vi } from 'vitest';

const getWorkspaceMock = vi.fn();
const getWorkspaceAccessMock = vi.fn();

vi.mock('@/lib/auth-do', () => ({
  getWorkspace: getWorkspaceMock,
  getWorkspaceAccess: getWorkspaceAccessMock,
}));

const { resolveWorkspaceFileReadOrgId } = await import('@/lib/workspace-file-access.server');

describe('resolveWorkspaceFileReadOrgId', () => {
  const getProfileMock = vi.fn();
  const userIdFromNameMock = vi.fn((id: string) => id);
  const userGetMock = vi.fn(() => ({ getProfile: getProfileMock }));

  const authEnv = {
    USER: {
      idFromName: userIdFromNameMock,
      get: userGetMock,
    },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when workspace does not exist', async () => {
    getWorkspaceMock.mockResolvedValue(null);

    const result = await resolveWorkspaceFileReadOrgId(
      authEnv,
      'ws_123',
      'org_a',
      'user_1'
    );

    expect(result).toBeNull();
  });

  it('allows same-org users with workspace access', async () => {
    getWorkspaceMock.mockResolvedValue({ id: 'ws_123', org_id: 'org_a' });
    getWorkspaceAccessMock.mockResolvedValue('full');

    const result = await resolveWorkspaceFileReadOrgId(
      authEnv,
      'ws_123',
      'org_a',
      'user_1'
    );

    expect(result).toBe('org_a');
    expect(getWorkspaceAccessMock).toHaveBeenCalledWith(authEnv, 'ws_123', 'user_1');
    expect(getProfileMock).not.toHaveBeenCalled();
  });

  it('blocks same-org non-superusers with no workspace access', async () => {
    getWorkspaceMock.mockResolvedValue({ id: 'ws_123', org_id: 'org_a' });
    getWorkspaceAccessMock.mockResolvedValue('none');
    getProfileMock.mockResolvedValue({ id: 'user_1', is_superuser: false });

    const result = await resolveWorkspaceFileReadOrgId(
      authEnv,
      'ws_123',
      'org_a',
      'user_1'
    );

    expect(result).toBeNull();
    expect(userIdFromNameMock).toHaveBeenCalledWith('user_1');
    expect(getProfileMock).toHaveBeenCalledTimes(1);
  });

  it('allows same-org superusers with no workspace access', async () => {
    getWorkspaceMock.mockResolvedValue({ id: 'ws_123', org_id: 'org_a' });
    getWorkspaceAccessMock.mockResolvedValue('none');
    getProfileMock.mockResolvedValue({ id: 'user_1', is_superuser: true });

    const result = await resolveWorkspaceFileReadOrgId(
      authEnv,
      'ws_123',
      'org_a',
      'user_1'
    );

    expect(result).toBe('org_a');
    expect(userIdFromNameMock).toHaveBeenCalledWith('user_1');
    expect(getProfileMock).toHaveBeenCalledTimes(1);
  });

  it('blocks cross-org non-superusers', async () => {
    getWorkspaceMock.mockResolvedValue({ id: 'ws_123', org_id: 'org_b' });
    getProfileMock.mockResolvedValue({ id: 'user_1', is_superuser: false });

    const result = await resolveWorkspaceFileReadOrgId(
      authEnv,
      'ws_123',
      'org_a',
      'user_1'
    );

    expect(result).toBeNull();
    expect(getWorkspaceAccessMock).not.toHaveBeenCalled();
    expect(userIdFromNameMock).toHaveBeenCalledWith('user_1');
  });

  it('allows cross-org superusers', async () => {
    getWorkspaceMock.mockResolvedValue({ id: 'ws_123', org_id: 'org_b' });
    getProfileMock.mockResolvedValue({ id: 'user_1', is_superuser: true });

    const result = await resolveWorkspaceFileReadOrgId(
      authEnv,
      'ws_123',
      'org_a',
      'user_1'
    );

    expect(result).toBe('org_b');
    expect(getWorkspaceAccessMock).not.toHaveBeenCalled();
  });
});
