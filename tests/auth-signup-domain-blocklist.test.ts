import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();
const getUserByEmailMock = vi.fn();
const createUserMock = vi.fn();
const createOrgMock = vi.fn();
const createSessionMock = vi.fn();
const createSessionCookieHeaderMock = vi.fn();
const sendUserVerificationEmailMock = vi.fn();
const waitUntilMock = vi.fn();
const validateTurnstileTokenMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-do', () => ({
  getUserByEmail: getUserByEmailMock,
  createUser: createUserMock,
  createOrg: createOrgMock,
  createSession: createSessionMock,
}));

vi.mock('@/lib/cookies.server', () => ({
  createSessionCookieHeader: createSessionCookieHeaderMock,
}));

vi.mock('@/lib/email-verification.server', () => ({
  sendUserVerificationEmail: sendUserVerificationEmailMock,
}));

vi.mock('@/lib/turnstile.server', () => ({
  validateTurnstileToken: validateTurnstileTokenMock,
}));

vi.mock('@/lib/wait-until', () => ({
  waitUntil: waitUntilMock,
}));

const { action } = await import('@/routes/api/auth.signup');

describe('auth signup domain blocklist', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getEnvMock.mockReturnValue({
      USER: {},
      ORG: {},
      WORKSPACE: {},
      SESSIONS: {},
      EMAIL_TO_USER: {},
      APP_KV: {},
      TOKEN_SIGNING_SECRET: 'secret',
      EMAIL_DOMAIN_BLOCKLIST: 'mailinator.com',
    });
    getUserByEmailMock.mockResolvedValue(null);
    createUserMock.mockResolvedValue({
      userId: 'user_123',
      user: { email: 'user@example.com', name: 'Test User' },
    });
    createOrgMock.mockResolvedValue({
      org: { id: 'org_123' },
      defaultWorkspaceId: 'ws_123',
    });
    createSessionMock.mockResolvedValue({ signedToken: 'signed-token' });
    createSessionCookieHeaderMock.mockReturnValue('session-cookie');
    sendUserVerificationEmailMock.mockResolvedValue({ status: 'sent' });
    validateTurnstileTokenMock.mockResolvedValue({ success: true });
  });

  it('rejects blocked signup domains with a 400 response', async () => {
    const response = await action({
      request: new Request('https://camelai.dev/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'person@mailinator.com',
          password: 'password123',
          turnstileToken: 'turnstile-token',
        }),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Email signups from this domain are not allowed',
    });
    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(sendUserVerificationEmailMock).not.toHaveBeenCalled();
  });
});
