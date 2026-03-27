import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserStubMock = vi.fn();
const getOrgStubMock = vi.fn();
const getWorkspaceStubMock = vi.fn();

vi.mock('../src/helpers/stubs.js', () => ({
  getUserStub: getUserStubMock,
  getOrgStub: getOrgStubMock,
  getWorkspaceStub: getWorkspaceStubMock,
}));

const { getOrCreateUserFromOAuth } = await import('../src/services/oauth.js');

describe('oauth email domain blocklist', () => {
  let env: {
    EMAIL_TO_USER: {
      get: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    env = {
      EMAIL_TO_USER: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
      },
    };
  });

  it('rejects blocked domains only when creating a new oauth user', async () => {
    env.EMAIL_TO_USER.get.mockResolvedValue(null);

    await expect(
      getOrCreateUserFromOAuth(
        env as never,
        'google',
        {
          email: 'person@mailinator.com',
          name: 'Blocked User',
          providerId: 'provider-123',
        },
      ),
    ).rejects.toThrow('email_domain_blocked');

    expect(env.EMAIL_TO_USER.put).not.toHaveBeenCalled();
  });

  it('does not block an existing oauth user with a now-blocked domain', async () => {
    const profile = { id: 'user-1', email: 'person@mailinator.com' };
    const userStub = {
      getProfile: vi.fn().mockResolvedValue(profile),
      linkOAuthProvider: vi.fn().mockResolvedValue(undefined),
    };

    env.EMAIL_TO_USER.get
      .mockResolvedValueOnce('user-1')
      .mockResolvedValueOnce(null);
    env.EMAIL_TO_USER.put.mockResolvedValue(undefined);
    getUserStubMock.mockReturnValue(userStub);

    await expect(
      getOrCreateUserFromOAuth(
        env as never,
        'google',
        {
          email: 'person@mailinator.com',
          name: 'Existing User',
          providerId: 'provider-123',
        },
      ),
    ).resolves.toBe('user-1');

    expect(env.EMAIL_TO_USER.put).toHaveBeenCalledWith(
      'oauth:google:provider-123',
      'user-1',
    );
  });
});
