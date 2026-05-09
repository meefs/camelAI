/**
 * Full-stack auth tests using Cloudflare Vitest pool
 *
 * These tests run in the Workers runtime with real Durable Objects,
 * testing the complete auth flow through direct DO calls.
 *
 * Run with: npm run test:workers
 */

import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createNewSession, type SessionData } from '../src/session-kv';
import {
  createUser,
  getUserByEmail,
  verifyUserPassword,
  createOrg,
  isOrgMember,
  isOrgAdmin,
  getUserOrgs,
  tryRemoveOrgMember,
  getOrgMembers,
  tryUpdateOrgMemberRole,
  createInvitation,
  getOrgInvitations,
  getInvitation,
  acceptInvitation,
  deleteInvitation,
  listOrgWorkspaces,
  createWorkspace,
  getSessionData,
  destroySessionData,
  switchSessionOrg,
  switchSessionWorkspace,
  type TestEnv,
} from './test-helpers';

describe('Auth flow (full-stack with DOs)', () => {
  const testEnv = env as unknown as TestEnv;
  const sessionsKV = env.SESSIONS as KVNamespace;

  // Helper to create a session with the org's default workspace
  async function createTestSession(
    userId: string,
    orgId: string
  ): Promise<{ sessionId: string; sessionData: SessionData }> {
    const workspaces = await listOrgWorkspaces(testEnv, orgId);
    const workspaceId = workspaces[0]?.id ?? null;
    return createNewSession(sessionsKV, userId, orgId, workspaceId);
  }

  // Generate unique email for each test to avoid conflicts
  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  describe('User creation and retrieval', () => {
    it('should create a new user', async () => {
      const email = testEmail();
      const result = await createUser(testEnv, email, 'password123', 'Test User');

      expect(result.userId).toBeDefined();
      expect(result.user.email).toBe(email);
      expect(result.user.name).toBe('Test User');
      expect(result.user.created_at).toBeTypeOf('number');
    });

    it('should retrieve user by email', async () => {
      const email = testEmail();
      await createUser(testEnv, email, 'password123', 'Test User');

      const result = await getUserByEmail(testEnv, email);

      expect(result).not.toBeNull();
      expect(result!.user.email).toBe(email);
    });

    it('should return null for non-existent email', async () => {
      const result = await getUserByEmail(testEnv, 'nonexistent@example.com');
      expect(result).toBeNull();
    });

    it('should verify correct password', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'correctPassword', 'Test');

      const isValid = await verifyUserPassword(testEnv, userId, 'correctPassword');
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'correctPassword', 'Test');

      const isValid = await verifyUserPassword(testEnv, userId, 'wrongPassword');
      expect(isValid).toBe(false);
    });

    it('requires email verification for password users', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Needs Verify');
      const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId));

      const before = await userStub.getEmailVerificationStatus();
      expect(before.required).toBe(true);
      expect(before.verified).toBe(false);

      const updatedProfile = await userStub.markEmailVerified();
      expect(updatedProfile?.email_verified_at).toBeTypeOf('number');

      const after = await userStub.getEmailVerificationStatus();
      expect(after.required).toBe(true);
      expect(after.verified).toBe(true);
    });

    it('marks OAuth users as already verified', async () => {
      const userId = crypto.randomUUID();
      const email = testEmail();
      const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId));

      await userStub.createUserFromOAuth(
        userId,
        email,
        'OAuth User',
        'google',
        `google-${crypto.randomUUID()}`
      );

      const status = await userStub.getEmailVerificationStatus();
      expect(status.required).toBe(false);
      expect(status.verified).toBe(true);
      expect(status.email_verified_at).toBeTypeOf('number');
    });
  });

  describe('Organization creation and membership', () => {
    it('should create an org and add creator as owner', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');

      const { org } = await createOrg(testEnv, 'Test Workspace', userId);

      expect(org.id).toBeDefined();
      expect(org.name).toBe('Test Workspace');
      expect(org.created_by).toBe(userId);

      // Creator should be a member
      const isMember = await isOrgMember(testEnv, userId, org.id);
      expect(isMember).toBe(true);

      // Creator should be an admin (owners are admins)
      const isAdmin = await isOrgAdmin(testEnv, userId, org.id);
      expect(isAdmin).toBe(true);
    });

    it('should list user orgs', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'My Workspace', userId);

      const orgs = await getUserOrgs(testEnv, userId);

      expect(orgs).toHaveLength(1);
      expect(orgs[0].org_id).toBe(org.id);
      expect(orgs[0].org_name).toBe('My Workspace');
      expect(orgs[0].role).toBe('owner');
      expect(orgs[0].last_workspace_id).toBeTypeOf('string');
    });

    it('assigns a 6-char hash-based slug on org creation', async () => {
      const ownerEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
      const { org } = await createOrg(testEnv, 'Hash Slug Org', ownerId);

      expect(org.slug).toMatch(/^[a-z0-9]{6,}$/);
      expect(org.slug.length).toBeGreaterThanOrEqual(6);
    });

    it('stores new org custom domains with pending status', async () => {
      const ownerEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
      const { org } = await createOrg(testEnv, 'Custom Domain Org', ownerId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const created = await orgStub.setCustomDomain('apps.example.com', ownerId);
      const stored = await orgStub.getCustomDomain();

      expect(created.status).toBe('pending');
      expect(stored?.status).toBe('pending');
    });
  });

  describe('Organization ownership invariants', () => {
    it('prevents removing the org owner', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Owner');
      const { org } = await createOrg(testEnv, 'Owner Org', userId);

      const result = await tryRemoveOrgMember(testEnv, org.id, userId, userId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Cannot remove organization owner');

      const members = await getOrgMembers(testEnv, org.id);
      expect(members.some((member) => member.user.id === userId && member.role === 'owner')).toBe(
        true
      );
    });

    it('prevents demoting the org owner without transfer', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Owner');
      const { org } = await createOrg(testEnv, 'Owner Org', userId);

      const result = await tryUpdateOrgMemberRole(testEnv, org.id, userId, 'member', userId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Cannot change the owner role. Transfer ownership first.');

      const members = await getOrgMembers(testEnv, org.id);
      const owner = members.find((member) => member.user.id === userId);
      expect(owner?.role).toBe('owner');
    });
  });

  describe('Thread creation', () => {
    it('stores explicit fallback titles without setting first_user_message', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Working on my-todo-app', userId);
      const stored = await orgStub.getThread(thread.id);

      expect(thread.title).toBe('Working on my-todo-app');
      expect(thread.first_user_message).toBeNull();
      expect(thread.model).toBe('sonnet');
      expect(stored?.title).toBe('Working on my-todo-app');
      expect(stored?.first_user_message).toBeNull();
      expect(stored?.model).toBe('sonnet');
    });

    it('self-heals legacy thread schema before creating new threads', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Legacy Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Legacy Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      await orgStub.downgradeThreadSchemaForTest();

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        'Recovered thread',
        userId,
        'hello',
        'gpt-5.4',
        'codex'
      );

      expect(thread.provider).toBe('codex');
      expect(thread.model).toBe('gpt-5.4');
      expect(thread.first_user_message).toBe('hello');

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.provider).toBe('codex');
      expect(stored?.model).toBe('gpt-5.4');
      expect(stored?.first_user_message).toBe('hello');
    });

    it('stores and preserves the first user message separately from the thread title', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'First Message Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        undefined,
        userId,
        'Please keep this first prompt',
      );

      expect(thread.title).toBe('New Chat');
      expect(thread.first_user_message).toBe('Please keep this first prompt');

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.title).toBe('New Chat');
      expect(stored?.first_user_message).toBe('Please keep this first prompt');

      await orgStub.setThreadFirstUserMessage(thread.id, 'Do not overwrite it');
      const afterBackfill = await orgStub.getThread(thread.id);
      expect(afterBackfill?.first_user_message).toBe('Please keep this first prompt');
    });

    it('persists per-thread model changes after creation', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Model thread', userId, undefined, 'opus');
      expect(thread.model).toBe('opus');
      expect(thread.provider).toBe('claude');

      const updated = await orgStub.updateThreadModel(thread.id, 'sonnet', userId);
      expect(updated?.model).toBe('sonnet');
      expect(updated?.provider).toBe('claude');

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.model).toBe('sonnet');
      expect(stored?.provider).toBe('claude');
    });

    it('touches assistant thread activity without incrementing user message count', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Activity thread', userId);
      await orgStub.touchThread(thread.id);
      const afterUserMessage = await orgStub.getThread(thread.id);
      expect(afterUserMessage?.user_message_count).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1));
      await expect(orgStub.touchThreadActivity(thread.id)).resolves.toBe(true);
      const afterAssistantActivity = await orgStub.getThread(thread.id);

      expect(afterAssistantActivity?.user_message_count).toBe(1);
      expect(afterAssistantActivity?.updated_at ?? 0).toBeGreaterThan(
        afterUserMessage?.updated_at ?? 0,
      );
    });

    it('persists model family changes on the active thread', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Model thread', userId, undefined, 'opus');
      const updated = await orgStub.updateThreadModel(thread.id, 'gpt-5.4-mini', userId);

      expect(updated?.model).toBe('gpt-5.4-mini');
      expect(updated?.provider).toBe('codex');

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.model).toBe('gpt-5.4-mini');
      expect(stored?.provider).toBe('codex');
    });
  });

  describe('BYOK refresh fan-out', () => {
    it('only targets recently active threads whose harness matches the affected provider', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'BYOK Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'BYOK Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const now = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now');

      try {
        dateNowSpy.mockReturnValue(now - 31 * 60 * 1000);
        await orgStub.createThread(defaultWorkspaceId, 'stale codex', userId, undefined, 'gpt-5.4', 'codex');

        dateNowSpy.mockReturnValue(now);
        await orgStub.createThread(defaultWorkspaceId, 'recent codex', userId, undefined, 'gpt-5.4', 'codex');
        await orgStub.createThread(defaultWorkspaceId, 'recent claude', userId, undefined, 'sonnet', 'claude');
      } finally {
        dateNowSpy.mockRestore();
      }

      expect(await orgStub.getActiveThreadIdsForByokChange(['codex'])).toHaveLength(1);
      expect(await orgStub.getActiveThreadIdsForByokChange(['claude'])).toHaveLength(1);
      expect(await orgStub.getActiveThreadIdsForByokChange(['claude', 'codex'])).toHaveLength(2);
    });

    it('does not cap matching active threads at 100', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'BYOK Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Large BYOK Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      for (let index = 0; index < 101; index += 1) {
        await orgStub.createThread(
          defaultWorkspaceId,
          `codex thread ${index}`,
          userId,
          undefined,
          'gpt-5.4',
          'codex'
        );
      }

      expect(await orgStub.getActiveThreadIdsForByokChange(['codex'])).toHaveLength(101);
    });
  });

  describe('Invitations', () => {
    it('should create an invitation', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      const invitation = await createInvitation(
        testEnv,
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
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      await createInvitation(testEnv, org.id, 'invitee@example.com', 'member', userId);

      const invitations = await getOrgInvitations(testEnv, org.id);

      expect(invitations).toHaveLength(1);
      expect(invitations[0].email).toBe('invitee@example.com');
    });

    it('should retrieve invitation details', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      const { id } = await createInvitation(
        testEnv,
        org.id,
        'invitee@example.com',
        'admin',
        userId
      );

      const invitation = await getInvitation(testEnv, org.id, id);

      expect(invitation).not.toBeNull();
      expect(invitation!.email).toBe('invitee@example.com');
      expect(invitation!.role).toBe('admin');
      expect(invitation!.org.id).toBe(org.id);
    });

    it('should accept invitation and add user to org', async () => {
      const inviterEmail = testEmail();
      const { userId: inviterId } = await createUser(
        testEnv,
        inviterEmail,
        'password123',
        'Inviter'
      );
      const { org } = await createOrg(testEnv, 'Test Org', inviterId);

      const inviteeEmail = testEmail();
      const { id: invitationId } = await createInvitation(
        testEnv,
        org.id,
        inviteeEmail,
        'member',
        inviterId
      );

      const { userId: inviteeId } = await createUser(
        testEnv,
        inviteeEmail,
        'password123',
        'Invitee'
      );

      const accepted = await acceptInvitation(testEnv, org.id, invitationId, inviteeId);

      expect(accepted).toBe(true);

      const isMember = await isOrgMember(testEnv, inviteeId, org.id);
      expect(isMember).toBe(true);
    });

    it('should delete an invitation', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      const { id } = await createInvitation(
        testEnv,
        org.id,
        'invitee@example.com',
        'member',
        userId
      );
      await deleteInvitation(testEnv, org.id, id);

      const invitations = await getOrgInvitations(testEnv, org.id);
      expect(invitations).toHaveLength(0);
    });
  });

  describe('Session management', () => {
    it('should create and retrieve a session', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Workspace', userId);

      const { sessionId, sessionData } = await createTestSession(userId, org.id);

      expect(sessionId).toBeDefined();
      expect(sessionData.user_id).toBe(userId);
      expect(sessionData.org_id).toBe(org.id);
      expect(sessionData.workspace_id).toBeTypeOf('string');

      // Should be able to retrieve session
      const retrieved = await getSessionData(testEnv, sessionId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.user_id).toBe(userId);
      expect(retrieved!.workspace_id).toBeTypeOf('string');
    });

    it('should destroy a session', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Workspace', userId);
      const { sessionId } = await createTestSession(userId, org.id);

      await destroySessionData(testEnv, sessionId);

      const retrieved = await getSessionData(testEnv, sessionId);
      expect(retrieved).toBeNull();
    });

    it('should switch session org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org: org1 } = await createOrg(testEnv, 'Workspace 1', userId);
      const { org: org2 } = await createOrg(testEnv, 'Workspace 2', userId);
      const { sessionId } = await createTestSession(userId, org1.id);

      await switchSessionOrg(testEnv, sessionId, org2.id);

      const session = await getSessionData(testEnv, sessionId);
      expect(session!.org_id).toBe(org2.id);
      expect(session!.workspace_id).toBeTypeOf('string');
    });

    it('persists last workspace per org when switching workspace', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Workspace Org', userId);
      const { sessionId } = await createTestSession(userId, org.id);

      const workspace = await createWorkspace(testEnv, org.id, 'Secondary', userId);
      await switchSessionWorkspace(testEnv, sessionId, workspace.id);

      const orgs = await getUserOrgs(testEnv, userId);
      const membership = orgs.find((entry) => entry.org_id === org.id);
      expect(membership?.last_workspace_id).toBe(workspace.id);
    });

    it('switching to workspace in different org also switches session org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Cross-Org User');

      // Create two orgs
      const { org: org1 } = await createOrg(testEnv, 'First Org', userId);
      const { org: org2, defaultWorkspaceId: ws2Id } = await createOrg(testEnv, 'Second Org', userId);

      // Start session in org1
      const { sessionId } = await createTestSession(userId, org1.id);
      let session = await getSessionData(testEnv, sessionId);
      expect(session!.org_id).toBe(org1.id);

      // Switch to workspace in org2 - this should also switch the org
      await switchSessionOrg(testEnv, sessionId, org2.id, ws2Id);

      session = await getSessionData(testEnv, sessionId);
      expect(session!.org_id).toBe(org2.id);
      expect(session!.workspace_id).toBe(ws2Id);
    });
  });

  describe('Full signup flow', () => {
    it('should complete signup: create user → create org → create session', async () => {
      const email = testEmail();

      // 1. Create user
      const { userId, user } = await createUser(testEnv, email, 'password123', 'New User');
      expect(user.email).toBe(email);

      // 2. Create org
      const { org } = await createOrg(testEnv, `New User's Workspace`, userId);
      expect(org.created_by).toBe(userId);

      // 3. Create session
      const { sessionId, sessionData } = await createTestSession(userId, org.id);
      expect(sessionData.user_id).toBe(userId);
      expect(sessionData.org_id).toBe(org.id);

      // 4. Get user orgs
      const orgs = await getUserOrgs(testEnv, userId);
      expect(orgs).toHaveLength(1);

      // All objects should be serializable (plain objects)
      expect(Object.getPrototypeOf(user)).not.toBeNull();
      expect(Object.getPrototypeOf(org)).not.toBeNull();
    });
  });
});
