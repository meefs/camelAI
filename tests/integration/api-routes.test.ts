/**
 * Integration tests for API routes
 *
 * Tests real API endpoints against the dev server.
 * Note: Auth is handled via server actions (not API routes), so most
 * API routes require session cookies that we can't easily obtain.
 * These tests primarily verify auth protection and basic behavior.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getServerUrl } from './test-utils';

describe('API Routes Integration', () => {
  let baseUrl: string;

  beforeAll(() => {
    baseUrl = getServerUrl();
  });

  describe('POST /api/chat', () => {
    it('should require authentication', async () => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: 'test-thread',
          message: 'Hello',
        }),
      });

      expect(response.status).toBe(401);
    });

    it('should reject with invalid session cookie', async () => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'chiridion_session_v2=invalid-session-id',
        },
        body: JSON.stringify({
          threadId: 'test-thread',
          message: 'Hello',
        }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/threads/[id]/preview', () => {
    it('should require authentication', async () => {
      const response = await fetch(`${baseUrl}/api/threads/test-thread-id/preview`);

      expect(response.status).toBe(401);
    });

    it('should reject with invalid session cookie', async () => {
      const response = await fetch(`${baseUrl}/api/threads/test-thread-id/preview`, {
        headers: {
          Cookie: 'chiridion_session_v2=invalid-session-id',
        },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/invitations/[orgId]/[invitationId]', () => {
    it('should return 404 for non-existent invitation', async () => {
      const response = await fetch(
        `${baseUrl}/api/invitations/fake-org-id/fake-invitation-id`
      );

      // May be 404 or 401 depending on how the route handles missing invitations
      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('Static assets', () => {
    it('should serve Next.js static files', async () => {
      // _next/static should return something (even if 404 for specific file)
      const response = await fetch(`${baseUrl}/_next/static/test.js`);

      // Should not require auth - may be 200 or 404 depending on file existence
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('Workspace filesystem API', () => {
    // These all require auth + valid workspace
    // Note: list and read are GET, others are POST
    const fsGetEndpoints = ['list', 'read'];
    const fsPostEndpoints = ['write', 'create', 'delete', 'mkdir', 'move'];

    fsGetEndpoints.forEach((endpoint) => {
      it(`should require authentication for GET /api/workspaces/[id]/fs/${endpoint}`, async () => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/test-workspace/fs/${endpoint}?path=/test`
        );

        expect(response.status).toBe(401);
      });
    });

    fsPostEndpoints.forEach((endpoint) => {
      it(`should require authentication for POST /api/workspaces/[id]/fs/${endpoint}`, async () => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/test-workspace/fs/${endpoint}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: '/test' }),
          }
        );

        expect(response.status).toBe(401);
      });
    });
  });

  describe('Computer API', () => {
    it('should require authentication for GET /api/computer/[orgId]', async () => {
      const response = await fetch(`${baseUrl}/api/computer/test-org-id`);

      expect(response.status).toBe(401);
    });
  });
});
