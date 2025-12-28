/**
 * Unit tests for auth middleware
 *
 * Run with: npm run test:run -- tests/middleware.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Mock NextResponse
vi.mock('next/server', () => ({
  NextResponse: {
    next: vi.fn(() => ({ type: 'next' })),
    redirect: vi.fn((url: URL) => ({ type: 'redirect', url: url.toString() })),
  },
}));

// Import middleware after mocking
import { middleware } from '../src/middleware';

// Helper to create mock NextRequest
function createMockRequest(
  pathname: string,
  options: { hasSession?: boolean } = {}
): NextRequest {
  const url = new URL(pathname, 'http://localhost:3000');

  return {
    nextUrl: url,
    url: url.toString(),
    cookies: {
      get: (name: string) => {
        if (name === 'session' && options.hasSession) {
          return { name: 'session', value: 'mock-session-token' };
        }
        return undefined;
      },
    },
  } as unknown as NextRequest;
}

describe('Auth Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Public routes', () => {
    it('should allow access to /login without session', () => {
      const request = createMockRequest('/login');
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });

    it('should allow access to /signup without session', () => {
      const request = createMockRequest('/signup');
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });

    it('should allow access to API routes without session', () => {
      const request = createMockRequest('/api/auth/login');
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });

    it('should allow access to _next routes without session', () => {
      const request = createMockRequest('/_next/static/chunk.js');
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });

    it('should allow access to invitation routes without session', () => {
      const request = createMockRequest('/invitations/org123/invite456');
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });
  });

  describe('Protected routes without session', () => {
    it('should redirect / to login without session', () => {
      const request = createMockRequest('/');
      middleware(request);

      expect(NextResponse.redirect).toHaveBeenCalled();
      const redirectCall = vi.mocked(NextResponse.redirect).mock.calls[0][0] as URL;
      expect(redirectCall.pathname).toBe('/login');
      expect(redirectCall.searchParams.get('redirect')).toBe('/');
    });

    it('should redirect /chat/123 to login without session', () => {
      const request = createMockRequest('/chat/123');
      middleware(request);

      expect(NextResponse.redirect).toHaveBeenCalled();
      const redirectCall = vi.mocked(NextResponse.redirect).mock.calls[0][0] as URL;
      expect(redirectCall.pathname).toBe('/login');
      expect(redirectCall.searchParams.get('redirect')).toBe('/chat/123');
    });

    it('should redirect /settings/integrations to login without session', () => {
      const request = createMockRequest('/settings/integrations');
      middleware(request);

      expect(NextResponse.redirect).toHaveBeenCalled();
      const redirectCall = vi.mocked(NextResponse.redirect).mock.calls[0][0] as URL;
      expect(redirectCall.pathname).toBe('/login');
      expect(redirectCall.searchParams.get('redirect')).toBe('/settings/integrations');
    });

    it('should redirect /history to login without session', () => {
      const request = createMockRequest('/history');
      middleware(request);

      expect(NextResponse.redirect).toHaveBeenCalled();
      const redirectCall = vi.mocked(NextResponse.redirect).mock.calls[0][0] as URL;
      expect(redirectCall.pathname).toBe('/login');
      expect(redirectCall.searchParams.get('redirect')).toBe('/history');
    });
  });

  describe('Protected routes with session', () => {
    it('should allow access to / with session', () => {
      const request = createMockRequest('/', { hasSession: true });
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });

    it('should allow access to /chat/123 with session', () => {
      const request = createMockRequest('/chat/123', { hasSession: true });
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });

    it('should allow access to /settings/integrations with session', () => {
      const request = createMockRequest('/settings/integrations', { hasSession: true });
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });

    it('should allow access to /history with session', () => {
      const request = createMockRequest('/history', { hasSession: true });
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });
  });

  describe('Public routes with session', () => {
    it('should allow access to /login even with session', () => {
      const request = createMockRequest('/login', { hasSession: true });
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });

    it('should allow access to /signup even with session', () => {
      const request = createMockRequest('/signup', { hasSession: true });
      middleware(request);

      expect(NextResponse.next).toHaveBeenCalled();
      expect(NextResponse.redirect).not.toHaveBeenCalled();
    });
  });
});
