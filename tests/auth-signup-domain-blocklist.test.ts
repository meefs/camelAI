import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();
const completePasswordSignupMock = vi.fn();
const createSessionMock = vi.fn();
const isSignupIpBlockedMock = vi.fn();
const createSessionCookieHeaderMock = vi.fn();
const sendUserVerificationEmailMock = vi.fn();
const waitUntilMock = vi.fn();
const validateTurnstileTokenMock = vi.fn();
const appKvGetMock = vi.fn();

let action: typeof import('@/routes/api/auth.signup').action;

describe('auth signup domain blocklist', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.doMock('@/lib/cloudflare.server', () => ({
      getEnv: getEnvMock,
    }));
    vi.doMock('@/lib/auth-do', () => ({
      completePasswordSignup: completePasswordSignupMock,
      createSession: createSessionMock,
      isSignupIpBlocked: isSignupIpBlockedMock,
    }));
    vi.doMock('@/lib/cookies.server', () => ({
      createSessionCookieHeader: createSessionCookieHeaderMock,
    }));
    vi.doMock('@/lib/email-verification.server', () => ({
      sendUserVerificationEmail: sendUserVerificationEmailMock,
    }));
    vi.doMock('@/lib/turnstile.server', () => ({
      validateTurnstileToken: validateTurnstileTokenMock,
    }));
    vi.doMock('@/lib/wait-until', () => ({
      waitUntil: waitUntilMock,
    }));

    getEnvMock.mockReturnValue({
      USER: {},
      ORG: {},
      WORKSPACE: {},
      SESSIONS: {},
      EMAIL_TO_USER: {},
      APP_KV: {
        get: appKvGetMock,
      },
      TOKEN_SIGNING_SECRET: 'secret',
    });
    appKvGetMock.mockResolvedValue(JSON.stringify(['mailinator.com']));
    completePasswordSignupMock.mockResolvedValue({
      status: 'ready',
      userId: 'user_123',
      user: { email: 'user@example.com', name: 'Test User' },
      orgId: 'org_123',
      workspaceId: 'ws_123',
    });
    createSessionMock.mockResolvedValue({ signedToken: 'signed-token' });
    isSignupIpBlockedMock.mockResolvedValue(false);
    createSessionCookieHeaderMock.mockReturnValue('session-cookie');
    sendUserVerificationEmailMock.mockResolvedValue({ status: 'sent' });
    validateTurnstileTokenMock.mockResolvedValue({ success: true });

    ({ action } = await import('@/routes/api/auth.signup'));
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
    expect(completePasswordSignupMock).not.toHaveBeenCalled();
    expect(sendUserVerificationEmailMock).not.toHaveBeenCalled();
  });
});
