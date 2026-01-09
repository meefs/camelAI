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
    it('should create an org and add creator as owner', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');

      const org = await rpc.createOrg('Test Workspace', userId);

      expect(org.id).toBeDefined();
      expect(org.name).toBe('Test Workspace');
      expect(org.created_by).toBe(userId);

      // Creator should be a member
      const isMember = await rpc.isOrgMember(userId, org.id);
      expect(isMember).toBe(true);

      // Creator should be an admin (owners are admins)
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
      expect(orgs[0].role).toBe('owner');
      expect(orgs[0].last_workspace_id).toBeTypeOf('string');
    });
  });

  describe('Organization ownership invariants', () => {
    it('prevents removing the org owner', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Owner');
      const org = await rpc.createOrg('Owner Org', userId);

      const result = await rpc.tryRemoveOrgMember(org.id, userId, userId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Cannot remove organization owner');

      const members = await rpc.getOrgMembers(org.id);
      expect(members.some((member) => member.user.id === userId && member.role === 'owner')).toBe(
        true
      );
    });

    it('prevents demoting the org owner without transfer', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Owner');
      const org = await rpc.createOrg('Owner Org', userId);

      const result = await rpc.tryUpdateOrgMemberRole(org.id, userId, 'member', userId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Cannot change the owner role. Transfer ownership first.');

      const members = await rpc.getOrgMembers(org.id);
      const owner = members.find((member) => member.user.id === userId);
      expect(owner?.role).toBe('owner');
    });
  });

  describe('Invitations', () => {
    it('should create an invitation', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');
      const org = await rpc.createOrg('Test Org', userId);

      const invitation = await rpc.createInvitation(
        org.id,
        'invitee@example.com',
        'member',
        userId
      );

      expect(invitation.id).toBeDefined();
      expect(invitation.expires_at).toBeGreaterThan(Date.now());
    });

    it('should persist invitations across requests', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');
      const org = await rpc.createOrg('Test Org', userId);

      await rpc.createInvitation(org.id, 'invitee@example.com', 'member', userId);

      const invitations = await rpc.getOrgInvitations(org.id);

      expect(invitations).toHaveLength(1);
      expect(invitations[0].email).toBe('invitee@example.com');
    });

    it('should retrieve invitation details', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');
      const org = await rpc.createOrg('Test Org', userId);

      const { id } = await rpc.createInvitation(
        org.id,
        'invitee@example.com',
        'admin',
        userId
      );

      const invitation = await rpc.getInvitation(org.id, id);

      expect(invitation).not.toBeNull();
      expect(invitation!.email).toBe('invitee@example.com');
      expect(invitation!.role).toBe('admin');
      expect(invitation!.org.id).toBe(org.id);
    });

    it('should accept invitation and add user to org', async () => {
      const inviterEmail = testEmail();
      const { userId: inviterId } = await rpc.createUser(
        inviterEmail,
        'password123',
        'Inviter'
      );
      const org = await rpc.createOrg('Test Org', inviterId);

      const inviteeEmail = testEmail();
      const { id: invitationId } = await rpc.createInvitation(
        org.id,
        inviteeEmail,
        'member',
        inviterId
      );

      const { userId: inviteeId } = await rpc.createUser(
        inviteeEmail,
        'password123',
        'Invitee'
      );

      const accepted = await rpc.acceptInvitation(org.id, invitationId, inviteeId);

      expect(accepted).toBe(true);

      const isMember = await rpc.isOrgMember(inviteeId, org.id);
      expect(isMember).toBe(true);
    });

    it('should delete an invitation', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');
      const org = await rpc.createOrg('Test Org', userId);

      const { id } = await rpc.createInvitation(
        org.id,
        'invitee@example.com',
        'member',
        userId
      );
      await rpc.deleteInvitation(org.id, id);

      const invitations = await rpc.getOrgInvitations(org.id);
      expect(invitations).toHaveLength(0);
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
      expect(sessionData.workspace_id).toBeTypeOf('string');

      // Should be able to retrieve session
      const retrieved = await rpc.getSession(sessionId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.user_id).toBe(userId);
      expect(retrieved!.workspace_id).toBeTypeOf('string');
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
      expect(session!.workspace_id).toBeTypeOf('string');
    });

    it('persists last workspace per org when switching workspace', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Test User');
      const org = await rpc.createOrg('Workspace Org', userId);
      const { sessionId } = await rpc.createSession(userId, org.id);

      const workspace = await rpc.createWorkspace(org.id, 'Secondary', userId);
      await rpc.switchSessionWorkspace(sessionId, workspace.id);

      const orgs = await rpc.getUserOrgs(userId);
      const membership = orgs.find((entry) => entry.org_id === org.id);
      expect(membership?.last_workspace_id).toBe(workspace.id);
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
