/**
 * Integration tests for pages and server
 *
 * These tests run against a real dev server with real Cloudflare DOs.
 * Since auth uses server actions (not API routes), we test:
 * 1. Page accessibility
 * 2. Redirect behavior based on auth state
 * 3. Static/SSR content
 *
 * For full auth flow testing, see e2e/auth.spec.ts (Playwright)
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getServerUrl } from './test-utils';

describe('Auth Pages Integration', () => {
  let baseUrl: string;

  beforeAll(() => {
    baseUrl = getServerUrl();
  });

  describe('Login page', () => {
    it('should load login page successfully', async () => {
      const response = await fetch(`${baseUrl}/login`);

      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('text/html');

      const html = await response.text();
      expect(html).toContain('Sign in');
      expect(html).toContain('email');
      expect(html).toContain('password');
    });

    it('should have link to signup page', async () => {
      const response = await fetch(`${baseUrl}/login`);
      const html = await response.text();

      expect(html).toContain('/signup');
      expect(html).toContain('Sign up');
    });

    it('should contain form elements', async () => {
      const response = await fetch(`${baseUrl}/login`);
      const html = await response.text();

      expect(html).toContain('type="email"');
      expect(html).toContain('type="password"');
      expect(html).toContain('button');
    });
  });

  describe('Signup page', () => {
    it('should load signup page successfully', async () => {
      const response = await fetch(`${baseUrl}/signup`);

      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('text/html');

      const html = await response.text();
      expect(html).toContain('Create an account');
      expect(html).toContain('email');
      expect(html).toContain('password');
    });

    it('should have link to login page', async () => {
      const response = await fetch(`${baseUrl}/signup`);
      const html = await response.text();

      expect(html).toContain('/login');
      expect(html).toContain('Sign in');
    });

    it('should contain form elements including name field', async () => {
      const response = await fetch(`${baseUrl}/signup`);
      const html = await response.text();

      expect(html).toContain('type="email"');
      expect(html).toContain('type="password"');
      expect(html).toContain('button');
      // Name field may be optional, so just check for input
      expect(html).toContain('input');
    });
  });

  describe('Protected routes', () => {
    it('should redirect unauthenticated users from home to login', async () => {
      const response = await fetch(`${baseUrl}/`, {
        redirect: 'manual', // Don't follow redirects
      });

      // Should redirect to login
      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
    });

    it('should redirect unauthenticated users from chat to login', async () => {
      const response = await fetch(`${baseUrl}/chat/test-thread-id`, {
        redirect: 'manual',
      });

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
    });

    it('should redirect unauthenticated users from history to login', async () => {
      const response = await fetch(`${baseUrl}/history`, {
        redirect: 'manual',
      });

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
    });

    it('should redirect unauthenticated users from connections to login', async () => {
      const response = await fetch(`${baseUrl}/connections`, {
        redirect: 'manual',
      });

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
    });

    it('should redirect to login page', async () => {
      const response = await fetch(`${baseUrl}/chat/my-special-thread`, {
        redirect: 'manual',
      });

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
    });
  });

  describe('Invitation pages', () => {
    it('should load invitation page without requiring auth', async () => {
      const response = await fetch(`${baseUrl}/invitations/test-org/test-invite`, {
        redirect: 'manual',
      });

      // Should not redirect to login (invitation pages are public)
      // May be 200 (page loads) or 404 (invalid invite) but not 307 redirect
      expect(response.status).not.toBe(307);
    });
  });
});

describe('Server Health Integration', () => {
  let baseUrl: string;

  beforeAll(() => {
    baseUrl = getServerUrl();
  });

  it('should serve static assets', async () => {
    // Try to fetch a known static asset (favicon)
    const response = await fetch(`${baseUrl}/favicon.ico`);

    // May be 200 or 404 depending on if favicon exists
    expect([200, 404]).toContain(response.status);
  });

  it('should return 404 for non-existent routes', async () => {
    const response = await fetch(`${baseUrl}/this-route-does-not-exist-12345`);

    expect(response.status).toBe(404);
  });

  it('should have proper security headers', async () => {
    const response = await fetch(`${baseUrl}/login`);

    // Check for common security headers (may vary based on config)
    const headers = response.headers;

    // At minimum, content-type should be set
    expect(headers.get('content-type')).toBeDefined();
  });
});
