/**
 * Full-stack auth tests using Cloudflare Vitest pool
 *
 * These tests run in the Workers runtime with real Durable Objects,
 * testing the complete auth flow through RPC → DOs.
 *
 * Run with: npm run test:workers
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { DoRpcService } from '../src/rpc-service';

describe('Auth flow (full-stack with DOs)', () => {
  // Get the RPC service binding
  const rpc = env.DO_RPC as unknown as DoRpcService;

  // Generate unique email for each test to avoid conflicts
  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  describe('User creation and retrieval', () => {
    it('should create a new user', async () => {
      const email = testEmail();
      const result = await rpc.createUser(email, 'password123', 'Test User');

      expect(result.userId).toBeDefined();
      expect(result.user.email).toBe(email);
      expect(result.user.name).toBe('Test User');
      expect(result.user.created_at).toBeTypeOf('number');
    });

    it('should retrieve user by email', async () => {
      const email = testEmail();
      await rpc.createUser(email, 'password123', 'Test User');

      const result = await rpc.getUserByEmail(email);

      expect(result).not.toBeNull();
      expect(result!.user.email).toBe(email);
    });

    it('should return null for non-existent email', async () => {
      const result = await rpc.getUserByEmail('nonexistent@example.com');
      expect(result).toBeNull();
    });

    it('should verify correct password', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'correctPassword', 'Test');

      const isValid = await rpc.verifyUserPassword(userId, 'correctPassword');
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'correctPassword', 'Test');

      const isValid = await rpc.verifyUserPassword(userId, 'wrongPassword');
      expect(isValid).toBe(false);
    });
  });

  describe('Organization creation and membership', () => {
    it('should create an org and add creator as admin', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');

      const org = await rpc.createOrg('Test Workspace', userId);

      expect(org.id).toBeDefined();
      expect(org.name).toBe('Test Workspace');
      expect(org.created_by).toBe(userId);

      // Creator should be a member
      const isMember = await rpc.isOrgMember(userId, org.id);
      expect(isMember).toBe(true);

      // Creator should be an admin
      const isAdmin = await rpc.isOrgAdmin(userId, org.id);
      expect(isAdmin).toBe(true);
    });

    it('should list user orgs', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');
      const org = await rpc.createOrg('My Workspace', userId);

      const orgs = await rpc.getUserOrgs(userId);

      expect(orgs).toHaveLength(1);
      expect(orgs[0].org_id).toBe(org.id);
      expect(orgs[0].org_name).toBe('My Workspace');
      expect(orgs[0].role).toBe('admin');
    });
  });

  describe('Session management', () => {
    it('should create and retrieve a session', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');
      const org = await rpc.createOrg('Workspace', userId);

      const { sessionId, sessionData } = await rpc.createSession(userId, org.id);

      expect(sessionId).toBeDefined();
      expect(sessionData.user_id).toBe(userId);
      expect(sessionData.org_id).toBe(org.id);

      // Should be able to retrieve session
      const retrieved = await rpc.getSession(sessionId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.user_id).toBe(userId);
    });

    it('should destroy a session', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');
      const org = await rpc.createOrg('Workspace', userId);
      const { sessionId } = await rpc.createSession(userId, org.id);

      await rpc.destroySession(sessionId);

      const retrieved = await rpc.getSession(sessionId);
      expect(retrieved).toBeNull();
    });

    it('should switch session org', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');
      const org1 = await rpc.createOrg('Workspace 1', userId);
      const org2 = await rpc.createOrg('Workspace 2', userId);
      const { sessionId } = await rpc.createSession(userId, org1.id);

      await rpc.switchSessionOrg(sessionId, org2.id);

      const session = await rpc.getSession(sessionId);
      expect(session!.org_id).toBe(org2.id);
    });
  });

  describe('Full signup flow', () => {
    it('should complete signup: create user → create org → create session', async () => {
      const email = testEmail();

      // 1. Create user
      const { userId, user } = await rpc.createUser(email, 'password123', 'New User');
      expect(user.email).toBe(email);

      // 2. Create org
      const org = await rpc.createOrg(`New User's Workspace`, userId);
      expect(org.created_by).toBe(userId);

      // 3. Create session
      const { sessionId, sessionData } = await rpc.createSession(userId, org.id);
      expect(sessionData.user_id).toBe(userId);
      expect(sessionData.org_id).toBe(org.id);

      // 4. Get user orgs
      const orgs = await rpc.getUserOrgs(userId);
      expect(orgs).toHaveLength(1);

      // All objects should be serializable (plain objects)
      expect(Object.getPrototypeOf(user)).not.toBeNull();
      expect(Object.getPrototypeOf(org)).not.toBeNull();
    });
  });
});
