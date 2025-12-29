/**
 * Unit tests for admin auth helpers
 *
 * Run with: npm run test:run -- tests/admin-auth.test.ts
 *
 * These tests validate the authorization logic for the admin panel.
 * The actual `requireSuperuser` function uses Next.js server-only APIs,
 * so we test a reimplementation of the logic here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Types matching the actual implementation
interface SessionData {
  user_id: string;
  org_id: string;
  created_at: number;
  last_accessed: number;
  expires_at: number;
}

interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
}

// Mock functions representing the auth layer
const mockGetSessionId = vi.fn<[], Promise<string | null>>();
const mockGetSession = vi.fn<[string], Promise<SessionData | null>>();
const mockGetUserById = vi.fn<[string], Promise<UserProfile | null>>();

/**
 * Reimplementation of requireSuperuser logic for testing
 * Mirrors the actual implementation in src/lib/admin-auth.ts
 */
async function requireSuperuser(): Promise<
  | { authorized: true; userId: string }
  | { authorized: false; status: number; error: string }
> {
  const sessionId = await mockGetSessionId();
  if (!sessionId) {
    return { authorized: false, status: 401, error: 'Unauthorized' };
  }

  const session = await mockGetSession(sessionId);
  if (!session) {
    return { authorized: false, status: 401, error: 'Unauthorized' };
  }

  const user = await mockGetUserById(session.user_id);
  if (!user) {
    return { authorized: false, status: 401, error: 'Unauthorized' };
  }

  if (!user.is_superuser) {
    return { authorized: false, status: 403, error: 'Forbidden' };
  }

  return { authorized: true, userId: user.id };
}

describe('requireSuperuser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return 401 when no session cookie exists', async () => {
    mockGetSessionId.mockResolvedValue(null);

    const result = await requireSuperuser();

    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.status).toBe(401);
      expect(result.error).toBe('Unauthorized');
    }
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('should return 401 when session is invalid/expired', async () => {
    mockGetSessionId.mockResolvedValue('invalid-session-id');
    mockGetSession.mockResolvedValue(null);

    const result = await requireSuperuser();

    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.status).toBe(401);
    }
    expect(mockGetSession).toHaveBeenCalledWith('invalid-session-id');
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('should return 401 when user does not exist', async () => {
    mockGetSessionId.mockResolvedValue('valid-session-id');
    mockGetSession.mockResolvedValue({
      user_id: 'deleted-user-123',
      org_id: 'org-123',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 86400000,
    });
    mockGetUserById.mockResolvedValue(null);

    const result = await requireSuperuser();

    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.status).toBe(401);
    }
  });

  it('should return 403 Forbidden when user is not a superuser', async () => {
    mockGetSessionId.mockResolvedValue('valid-session-id');
    mockGetSession.mockResolvedValue({
      user_id: 'user-123',
      org_id: 'org-123',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 86400000,
    });
    mockGetUserById.mockResolvedValue({
      id: 'user-123',
      email: 'regular@example.com',
      name: 'Regular User',
      created_at: Date.now(),
      is_superuser: false,
    });

    const result = await requireSuperuser();

    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.status).toBe(403);
      expect(result.error).toBe('Forbidden');
    }
  });

  it('should return authorized with userId when user is a superuser', async () => {
    mockGetSessionId.mockResolvedValue('valid-session-id');
    mockGetSession.mockResolvedValue({
      user_id: 'superuser-123',
      org_id: 'org-123',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 86400000,
    });
    mockGetUserById.mockResolvedValue({
      id: 'superuser-123',
      email: 'admin@example.com',
      name: 'Admin User',
      created_at: Date.now(),
      is_superuser: true,
    });

    const result = await requireSuperuser();

    expect(result.authorized).toBe(true);
    if (result.authorized) {
      expect(result.userId).toBe('superuser-123');
    }
  });

  it('should call auth functions in correct order', async () => {
    mockGetSessionId.mockResolvedValue('session-id');
    mockGetSession.mockResolvedValue({
      user_id: 'user-id',
      org_id: 'org-id',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 86400000,
    });
    mockGetUserById.mockResolvedValue({
      id: 'user-id',
      email: 'test@example.com',
      name: null,
      created_at: Date.now(),
      is_superuser: true,
    });

    await requireSuperuser();

    // Verify calls were made in order with correct args
    expect(mockGetSessionId).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledWith('session-id');
    expect(mockGetUserById).toHaveBeenCalledTimes(1);
    expect(mockGetUserById).toHaveBeenCalledWith('user-id');
  });
});

describe('Superuser email allowlist', () => {
  // Tests the email allowlist logic from worker/auth.ts
  const SUPERUSER_EMAILS = new Set([
    'admin@example.com',
    '1033072+Vercantez@users.noreply.github.com',
    'admin-test@example.com',
  ]);

  function isSuperuserEmail(email: string | null): boolean {
    if (!email) return false;
    return SUPERUSER_EMAILS.has(email.toLowerCase());
  }

  it('should return true for allowlisted emails', () => {
    expect(isSuperuserEmail('admin@example.com')).toBe(true);
    expect(isSuperuserEmail('1033072+Vercantez@users.noreply.github.com')).toBe(true);
    expect(isSuperuserEmail('admin-test@example.com')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isSuperuserEmail('ILLIANA@CAMELAI.COM')).toBe(true);
    expect(isSuperuserEmail('Miguel@CamelAI.com')).toBe(true);
    expect(isSuperuserEmail('ADMIN-TEST@EXAMPLE.COM')).toBe(true);
  });

  it('should return false for non-allowlisted emails', () => {
    expect(isSuperuserEmail('other@example.com')).toBe(false);
    expect(isSuperuserEmail('admin@example.com')).toBe(false);
    expect(isSuperuserEmail('illiana@otherdomain.com')).toBe(false);
  });

  it('should return false for null or empty email', () => {
    expect(isSuperuserEmail(null)).toBe(false);
    expect(isSuperuserEmail('')).toBe(false);
  });

  it('should handle edge cases', () => {
    // Email with extra spaces should fail (not trimmed)
    expect(isSuperuserEmail(' admin@example.com ')).toBe(false);
    // Partial match should fail
    expect(isSuperuserEmail('admin@example.com.evil.com')).toBe(false);
  });
});
