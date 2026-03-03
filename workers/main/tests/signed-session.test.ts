import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createSignedSession,
  parseSignedSession,
  createSignedOAuthState,
  parseSignedOAuthState,
  type SignedSessionData,
  type SignedOAuthStateData,
} from '../src/signed-session';

const TEST_SECRET = 'test-signing-secret-for-unit-tests';

describe('Signed Session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips session data', async () => {
    const data: SignedSessionData = {
      user_id: 'user-123',
      org_id: 'org-456',
      workspace_id: 'ws-789',
      created_at: Date.now(),
      user_name: 'Test User',
      user_email: 'test@example.com',
    };

    const token = await createSignedSession(TEST_SECRET, data);
    expect(token.startsWith('ss_')).toBe(true);

    const parsed = await parseSignedSession(TEST_SECRET, token);
    expect(parsed).not.toBeNull();
    expect(parsed!.user_id).toBe('user-123');
    expect(parsed!.org_id).toBe('org-456');
    expect(parsed!.workspace_id).toBe('ws-789');
    expect(parsed!.user_name).toBe('Test User');
    expect(parsed!.user_email).toBe('test@example.com');
  });

  it('handles null workspace_id', async () => {
    const data: SignedSessionData = {
      user_id: 'user-123',
      org_id: 'org-456',
      workspace_id: null,
      created_at: Date.now(),
    };

    const token = await createSignedSession(TEST_SECRET, data);
    const parsed = await parseSignedSession(TEST_SECRET, token);
    expect(parsed).not.toBeNull();
    expect(parsed!.workspace_id).toBeNull();
  });

  it('rejects tampered tokens', async () => {
    const data: SignedSessionData = {
      user_id: 'user-123',
      org_id: 'org-456',
      workspace_id: null,
      created_at: Date.now(),
    };

    const token = await createSignedSession(TEST_SECRET, data);
    // Flip a character in the payload
    const tampered = token.slice(0, 5) + 'X' + token.slice(6);
    const parsed = await parseSignedSession(TEST_SECRET, tampered);
    expect(parsed).toBeNull();
  });

  it('rejects wrong secret', async () => {
    const data: SignedSessionData = {
      user_id: 'user-123',
      org_id: 'org-456',
      workspace_id: null,
      created_at: Date.now(),
    };

    const token = await createSignedSession(TEST_SECRET, data);
    const parsed = await parseSignedSession('wrong-secret', token);
    expect(parsed).toBeNull();
  });

  it('rejects expired sessions (30+ days)', async () => {
    const data: SignedSessionData = {
      user_id: 'user-123',
      org_id: 'org-456',
      workspace_id: null,
      created_at: Date.now() - 31 * 24 * 60 * 60 * 1000,
    };

    const token = await createSignedSession(TEST_SECRET, data);
    const parsed = await parseSignedSession(TEST_SECRET, token);
    expect(parsed).toBeNull();
  });

  it('accepts sessions within 30 days', async () => {
    const data: SignedSessionData = {
      user_id: 'user-123',
      org_id: 'org-456',
      workspace_id: null,
      created_at: Date.now() - 29 * 24 * 60 * 60 * 1000,
    };

    const token = await createSignedSession(TEST_SECRET, data);
    const parsed = await parseSignedSession(TEST_SECRET, token);
    expect(parsed).not.toBeNull();
  });

  it('rejects wrong prefix', async () => {
    const data: SignedSessionData = {
      user_id: 'user-123',
      org_id: 'org-456',
      workspace_id: null,
      created_at: Date.now(),
    };

    const token = await createSignedSession(TEST_SECRET, data);
    // Replace ss_ with os_
    const wrongPrefix = 'os_' + token.slice(3);
    const parsed = await parseSignedSession(TEST_SECRET, wrongPrefix);
    expect(parsed).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await parseSignedSession(TEST_SECRET, '')).toBeNull();
    expect(await parseSignedSession(TEST_SECRET, 'ss_')).toBeNull();
    expect(await parseSignedSession(TEST_SECRET, 'ss_nodot')).toBeNull();
    expect(await parseSignedSession(TEST_SECRET, 'random-string')).toBeNull();
  });
});

describe('Signed OAuth State', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips OAuth state data', async () => {
    const data: SignedOAuthStateData = {
      provider: 'google',
      redirect_url: '/chat',
      nonce: 'test-nonce-123',
      created_at: Date.now(),
    };

    const token = await createSignedOAuthState(TEST_SECRET, data);
    expect(token.startsWith('os_')).toBe(true);

    const parsed = await parseSignedOAuthState(TEST_SECRET, token);
    expect(parsed).not.toBeNull();
    expect(parsed!.provider).toBe('google');
    expect(parsed!.redirect_url).toBe('/chat');
    expect(parsed!.nonce).toBe('test-nonce-123');
  });

  it('rejects expired OAuth state (5+ minutes)', async () => {
    const data: SignedOAuthStateData = {
      provider: 'google',
      redirect_url: '/',
      nonce: 'test-nonce',
      created_at: Date.now() - 6 * 60 * 1000,
    };

    const token = await createSignedOAuthState(TEST_SECRET, data);
    const parsed = await parseSignedOAuthState(TEST_SECRET, token);
    expect(parsed).toBeNull();
  });

  it('accepts OAuth state within 5 minutes', async () => {
    const data: SignedOAuthStateData = {
      provider: 'github',
      redirect_url: '/',
      nonce: 'test-nonce',
      created_at: Date.now() - 4 * 60 * 1000,
    };

    const token = await createSignedOAuthState(TEST_SECRET, data);
    const parsed = await parseSignedOAuthState(TEST_SECRET, token);
    expect(parsed).not.toBeNull();
    expect(parsed!.provider).toBe('github');
  });

  it('rejects tampered OAuth state', async () => {
    const data: SignedOAuthStateData = {
      provider: 'google',
      redirect_url: '/',
      nonce: 'test-nonce',
      created_at: Date.now(),
    };

    const token = await createSignedOAuthState(TEST_SECRET, data);
    const tampered = token.slice(0, 5) + 'X' + token.slice(6);
    const parsed = await parseSignedOAuthState(TEST_SECRET, tampered);
    expect(parsed).toBeNull();
  });

  it('session tokens cannot be parsed as OAuth state', async () => {
    const sessionData: SignedSessionData = {
      user_id: 'user-123',
      org_id: 'org-456',
      workspace_id: null,
      created_at: Date.now(),
    };

    const sessionToken = await createSignedSession(TEST_SECRET, sessionData);
    const parsed = await parseSignedOAuthState(TEST_SECRET, sessionToken);
    expect(parsed).toBeNull();
  });
});
