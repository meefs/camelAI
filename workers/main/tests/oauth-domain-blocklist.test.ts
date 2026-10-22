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
    APP_KV: {
      get: ReturnType<typeof vi.fn>;
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
      APP_KV: {
        get: vi.fn().mockResolvedValue(JSON.stringify(['mailinator.com'])),
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
      getOAuthProvider: vi.fn().mockResolvedValue(null),
      linkOAuthProvider: vi.fn().mockResolvedValue(undefined),
    };

    env.EMAIL_TO_USER.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('user-1');
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

describe('OAuth account identity precedence', () => {
  it('keeps the linked provider account when its new email belongs to another account', async () => {
    const kv = { get: vi.fn(async (key: string) => key.startsWith('oauth:') ? 'original-owner' : 'email-owner'), put: vi.fn() };
    getUserStubMock.mockReturnValue({ getProfile: async () => ({ id: 'original-owner' }), getOAuthProvider: async () => ({ provider_id: 'subject' }) });
    await expect(getOrCreateUserFromOAuth({ EMAIL_TO_USER: kv } as never, 'google', { email: 'other@example.com', providerId: 'subject' })).resolves.toBe('original-owner');
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.put).not.toHaveBeenCalled();
  });
  it('does not resurrect a deleted linked identity', async () => {
    getUserStubMock.mockReturnValue({ getProfile: async () => null });
    await expect(getOrCreateUserFromOAuth({ EMAIL_TO_USER: { get: async () => 'deleted' } } as never, 'google', { email: 'user@example.com', providerId: 'subject' })).rejects.toThrow('oauth_identity_unavailable');
  });
  it('rejects replacement of a different provider subject on an email-matched account', async () => {
    getUserStubMock.mockReturnValue({ getProfile: async () => ({ id: 'owner' }), getOAuthProvider: async () => ({ provider_id: 'original-subject' }) });
    const kv = { get: async (key: string) => key.startsWith('email:') ? 'owner' : null, put: vi.fn() };
    await expect(getOrCreateUserFromOAuth({ EMAIL_TO_USER: kv } as never, 'google', { email: 'user@example.com', providerId: 'different-subject' })).rejects.toThrow('oauth_identity_conflict');
    expect(kv.put).not.toHaveBeenCalled();
  });
});

it('does not attach OAuth to an unverified password account', async () => {
  getUserStubMock.mockReturnValue({ getProfile: async () => ({ id: 'pre-registered', email_verified_at: null }) });
  const kv = { get: async (key: string) => key.startsWith('email:') ? 'pre-registered' : null, put: vi.fn() };
  await expect(getOrCreateUserFromOAuth({ EMAIL_TO_USER: kv } as never, 'google', { email: 'victim@example.com', providerId: 'subject' })).rejects.toThrow('oauth_email_verification_required');
  expect(kv.put).not.toHaveBeenCalled();
});

it('does not authenticate through a stale provider mapping after unlinking', async () => {
  getUserStubMock.mockReturnValue({ getProfile: async () => ({ id: 'owner' }), getOAuthProvider: async () => null });
  await expect(getOrCreateUserFromOAuth({ EMAIL_TO_USER: { get: async () => 'owner' } } as never, 'google', { email: 'user@example.com', providerId: 'subject' })).rejects.toThrow('oauth_identity_conflict');
});
