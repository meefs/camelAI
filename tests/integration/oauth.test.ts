/**
 * Integration tests for OAuth routes
 *
 * These tests verify the OAuth initiation routes are accessible and return
 * expected responses. Full OAuth flow testing requires configured providers.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getServerUrl } from './test-utils';

describe('OAuth Routes Integration', () => {
  let baseUrl: string;

  beforeAll(() => {
    baseUrl = getServerUrl();
  });

  describe('GET /api/auth/google', () => {
    it('should exist and respond (not 404)', async () => {
      const response = await fetch(`${baseUrl}/api/auth/google`, {
        redirect: 'manual', // Don't follow redirects
      });

      // Should NOT be 404 - route must exist
      expect(response.status).not.toBe(404);

      // Expected responses:
      // - 302/307: Redirect to Google OAuth (if GOOGLE_CLIENT_ID is set)
      // - 503: Google sign-in not configured (if GOOGLE_CLIENT_ID is missing)
      expect([302, 307, 503]).toContain(response.status);
    });

    it('should redirect to Google if configured', async () => {
      const response = await fetch(`${baseUrl}/api/auth/google`, {
        redirect: 'manual',
      });

      if (response.status === 302 || response.status === 307) {
        const location = response.headers.get('location');
        expect(location).toContain('accounts.google.com');
      }
    });
  });

  describe('GET /api/auth/github', () => {
    it('should exist and respond (not 404)', async () => {
      const response = await fetch(`${baseUrl}/api/auth/github`, {
        redirect: 'manual',
      });

      // Should NOT be 404 - route must exist
      expect(response.status).not.toBe(404);

      // Expected responses:
      // - 302/307: Redirect to GitHub OAuth (if GITHUB_CLIENT_ID is set)
      // - 503: GitHub sign-in not configured (if GITHUB_CLIENT_ID is missing)
      expect([302, 307, 503]).toContain(response.status);
    });

    it('should redirect to GitHub if configured', async () => {
      const response = await fetch(`${baseUrl}/api/auth/github`, {
        redirect: 'manual',
      });

      if (response.status === 302 || response.status === 307) {
        const location = response.headers.get('location');
        expect(location).toContain('github.com');
      }
    });

    it('should return 503 with helpful message if not configured', async () => {
      const response = await fetch(`${baseUrl}/api/auth/github`, {
        redirect: 'manual',
      });

      if (response.status === 503) {
        const body = (await response.json()) as { error?: string };
        expect(body).toHaveProperty('error');
        expect(body.error).toContain('not configured');
      }
    });
  });

  describe('GET /api/auth/invalid-provider', () => {
    it('should return 400 for invalid provider', async () => {
      const response = await fetch(`${baseUrl}/api/auth/invalid-provider`, {
        redirect: 'manual',
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body).toHaveProperty('error');
      expect(body.error).toContain('Invalid OAuth provider');
    });
  });

  describe('OAuth callback routes', () => {
    it('GET /api/auth/google/callback should exist', async () => {
      const response = await fetch(`${baseUrl}/api/auth/google/callback`, {
        redirect: 'manual',
      });

      // Without code/state params, should redirect to login with error
      // Should NOT be 404
      expect(response.status).not.toBe(404);
    });

    it('GET /api/auth/github/callback should exist', async () => {
      const response = await fetch(`${baseUrl}/api/auth/github/callback`, {
        redirect: 'manual',
      });

      // Without code/state params, should redirect to login with error
      // Should NOT be 404
      expect(response.status).not.toBe(404);
    });

    it('callback without params should redirect to login with error', async () => {
      const response = await fetch(`${baseUrl}/api/auth/github/callback`, {
        redirect: 'manual',
      });

      // Should be a redirect to login page
      expect([302, 307]).toContain(response.status);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('error=');
    });
  });
});
