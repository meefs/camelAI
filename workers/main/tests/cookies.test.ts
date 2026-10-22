import { describe, it, expect } from 'vitest';
import {
  createOAuthStateCookie,
  createSessionCookie,
  getOAuthStateFromRequest,
  type SignedOAuthStateData,
} from '../src/cookies';

const TEST_SECRET = 'test-signing-secret-for-cookie-tests';

describe('cookie security attributes', () => {
  it('does not mark localhost OAuth state cookies as Secure', async () => {
    const request = new Request('http://localhost:3001/api/auth/google', {
      headers: { host: 'localhost:3001' },
    });
    const state: SignedOAuthStateData = {
      provider: 'google',
      redirect_url: '/',
      nonce: 'nonce-123',
      created_at: Date.now(),
    };

    const cookie = await createOAuthStateCookie(state, TEST_SECRET, request);
    expect(cookie).toContain('chiridion_oauth_state=');
    expect(cookie).not.toContain('Secure');
  });

  it('does not mark localhost session cookies as Secure', () => {
    const request = new Request('http://localhost:3001/login', {
      headers: { host: 'localhost:3001' },
    });

    const cookie = createSessionCookie('session-token', request);
    expect(cookie).toContain('chiridion_session_local=session-token');
    expect(cookie).not.toContain('Secure');
  });

  it('marks forwarded https cookies as Secure', () => {
    const request = new Request('http://internal/api/auth/google', {
      headers: {
        host: 'dev-miguel.camelai.dev',
        'x-forwarded-proto': 'https',
      },
    });

    const cookie = createSessionCookie('session-token', request);
    expect(cookie).toContain('Secure');
  });
});

it('keeps the OAuth verifier cookie host-only and prevents subdomain cookie injection', async () => {
  const request = new Request('https://staging.camelai.dev/api/auth/google', { headers: { host: 'staging.camelai.dev' } });
  const state: SignedOAuthStateData = { provider: 'google', redirect_url: '/', nonce: 'state', created_at: Date.now(), code_verifier: 'private-verifier' };
  const cookie = await createOAuthStateCookie(state, TEST_SECRET, request);
  expect(cookie).toMatch(/^__Host-chiridion_oauth_state=/);
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Path=/');
  expect(cookie).not.toContain('Domain=');
  const cookiePair = cookie.split(';')[0];
  await expect(getOAuthStateFromRequest(new Request(request.url, { headers: { Cookie: cookiePair } }), TEST_SECRET)).resolves.toMatchObject({ code_verifier: 'private-verifier' });
  await expect(getOAuthStateFromRequest(new Request(request.url, { headers: { Cookie: cookiePair.replace('__Host-', '') } }), TEST_SECRET)).resolves.toBeNull();
});
