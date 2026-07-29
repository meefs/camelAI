import { beforeEach, describe, expect, it, vi } from 'vitest';

const authDoMocks = vi.hoisted(() => ({
  completePasswordSignup: vi.fn(),
  createSession: vi.fn(),
  isSignupIpBlocked: vi.fn(),
}));

const salesPromptMocks = vi.hoisted(() => ({
  consumeSalesPrompt: vi.fn(),
  getPromptKeyFromUrl: vi.fn(),
}));

const emailMocks = vi.hoisted(() => ({
  sendUserVerificationEmail: vi.fn(),
}));

const banMocks = vi.hoisted(() => ({
  getBanForEmail: vi.fn(),
}));

vi.mock('@/lib/auth-do', () => authDoMocks);
vi.mock('@/lib/sales-prompt.server', () => salesPromptMocks);
vi.mock('@/lib/email-verification.server', () => emailMocks);
vi.mock('@/lib/ban.server', () => banMocks);
vi.mock('@/lib/wait-until', () => ({
  waitUntil: (promise: Promise<unknown>) => promise.catch(() => undefined),
}));

import { action } from '@/routes/api/auth.signup';

describe('signup action IP handling', () => {
  const fakeEnv = {
    USER: {},
    ORG: {},
    WORKSPACE: {},
    APP_DB: {},
    SESSIONS: {},
    EMAIL_TO_USER: {},
    APP_KV: { get: vi.fn().mockResolvedValue(null) },
    NEXTJS_ENV: 'development',
    TOKEN_SIGNING_SECRET: 'test-secret',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    authDoMocks.isSignupIpBlocked.mockResolvedValue(false);
    authDoMocks.completePasswordSignup.mockResolvedValue({
      status: 'ready',
      userId: 'user-1',
      user: { email: 'person@example.com', name: 'Person' },
      orgId: 'org-1',
      workspaceId: 'ws-1',
    });
    authDoMocks.createSession.mockResolvedValue({
      signedToken: 'signed-token',
    });
    salesPromptMocks.getPromptKeyFromUrl.mockReturnValue(null);
    emailMocks.sendUserVerificationEmail.mockResolvedValue({ status: 'sent' });
    banMocks.getBanForEmail.mockResolvedValue(null);
  });

  it('passes CF-Connecting-IP through to user creation', async () => {
    const request = new Request('http://example.com/api/auth/signup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.10',
      },
      body: JSON.stringify({
        email: 'person@example.com',
        password: 'password123',
        name: 'Person',
      }),
    });

    const response = await action({
      request,
      context: { cloudflare: { env: fakeEnv } },
    } as never);

    expect(response.status).toBe(200);
    expect(authDoMocks.isSignupIpBlocked).toHaveBeenCalledWith(expect.anything(), '203.0.113.10');
    expect(authDoMocks.completePasswordSignup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: 'person@example.com',
        password: 'password123',
        name: 'Person',
        signupIp: '203.0.113.10',
      }),
    );
  });

  it('returns 403 before creating a user when the signup IP is blocked', async () => {
    authDoMocks.isSignupIpBlocked.mockResolvedValue(true);

    const request = new Request('http://example.com/api/auth/signup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.7, 10.0.0.1',
      },
      body: JSON.stringify({
        email: 'blocked@example.com',
        password: 'password123',
        name: 'Blocked',
      }),
    });

    const response = await action({
      request,
      context: { cloudflare: { env: fakeEnv } },
    } as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Signups from this IP address are blocked',
    });
    expect(authDoMocks.isSignupIpBlocked).toHaveBeenCalledWith(expect.anything(), '198.51.100.7');
    expect(authDoMocks.completePasswordSignup).not.toHaveBeenCalled();
  });

  it('returns an explicit disabled-state error before creating a password user in self-host mode', async () => {
    const request = new Request('https://selfhost.example/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'person@example.com',
        password: 'password123',
        name: 'Person',
      }),
    });

    const response = await action({
      request,
      context: {
        cloudflare: {
          env: { ...fakeEnv, CF_ACCOUNT_ID: 'selfhost' },
        },
      },
    } as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error:
        'Password signup is disabled in self-host mode because email verification cannot be delivered. Use the configured enterprise identity provider.',
    });
    expect(authDoMocks.completePasswordSignup).not.toHaveBeenCalled();
    expect(emailMocks.sendUserVerificationEmail).not.toHaveBeenCalled();
  });
});
