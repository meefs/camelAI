/**
 * Tests for auth context building with parallel DO calls.
 *
 * These tests verify that the auth-do.ts functions properly fetch
 * user, org, and workspace data - including the Promise.all parallelization
 * for fetching multiple orgs/workspaces.
 *
 * Run with: bun run test:workers
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createNewSession } from '../src/session-kv';
import {
  createUser,
  createOrg,
  getUserOrgs,
  listUserWorkspaces,
  listUserWorkspacesAcrossOrgs,
  createWorkspace,
  createInvitation,
  acceptInvitation,
  listOrgWorkspaces,
  type TestEnv,
} from './test-helpers';

describe('Auth context building (parallel DO calls)', () => {
  const testEnv = env as unknown as TestEnv;
  const sessionsKV = env.SESSIONS as KVNamespace;

  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  async function createTestSession(userId: string, orgId: string) {
    const workspaces = await listOrgWorkspaces(testEnv, orgId);
    const workspaceId = workspaces[0]?.id ?? null;
    return createNewSession(sessionsKV, userId, orgId, workspaceId);
  }

  describe('getUserOrgs with parallelization', () => {
    it('should fetch all user orgs with their info in parallel', async () => {
      // Create user and their first org
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Multi-Org User');
      const { org: org1 } = await createOrg(testEnv, 'First Org', userId);

      // Create additional orgs
      const { org: org2 } = await createOrg(testEnv, 'Second Org', userId);
      const { org: org3 } = await createOrg(testEnv, 'Third Org', userId);

      // Fetch all orgs - this uses Promise.all internally
      const allOrgs = await getUserOrgs(testEnv, userId);

      expect(allOrgs.length).toBe(3);
      expect(allOrgs.map(o => o.org_name)).toContain('First Org');
      expect(allOrgs.map(o => o.org_name)).toContain('Second Org');
      expect(allOrgs.map(o => o.org_name)).toContain('Third Org');
    });

    it('should handle user with single org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Single Org User');
      const { org } = await createOrg(testEnv, 'My Org', userId);

      const orgs = await getUserOrgs(testEnv, userId);

      expect(orgs.length).toBe(1);
      expect(orgs[0].role).toBe('owner');
      expect(orgs[0].org_name).toBe('My Org');
    });
  });

  describe('listUserWorkspaces', () => {
    it('should fetch workspaces for a specific org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Workspace User');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', userId);

      // Default workspace is created with org
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);

      expect(workspaces.length).toBeGreaterThanOrEqual(1);
      expect(workspaces[0].id).toBe(defaultWorkspaceId);
      expect(workspaces[0].access_level).toBe('full');
    });

    it('should fetch multiple workspaces in an org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Multi WS User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      // Create additional workspaces (note: createWorkspace(env, orgId, name, createdBy))
      await createWorkspace(testEnv, org.id, 'Workspace 2', userId);
      await createWorkspace(testEnv, org.id, 'Workspace 3', userId);

      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);

      expect(workspaces.length).toBe(3);
      // All workspaces should have full access
      expect(workspaces.every(w => w.access_level === 'full')).toBe(true);
    });
  });

  describe('listUserWorkspacesAcrossOrgs', () => {
    it('should fetch workspaces across all orgs in parallel', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Cross Org User');

      // Create first org with workspace
      const { org: org1 } = await createOrg(testEnv, 'Org 1', userId);

      // Create second org with workspace
      const { org: org2 } = await createOrg(testEnv, 'Org 2', userId);

      // Create third org with workspace
      const { org: org3 } = await createOrg(testEnv, 'Org 3', userId);

      const orgs = await getUserOrgs(testEnv, userId);

      // Fetch all workspaces across all orgs - uses Promise.all internally
      const allWorkspaces = await listUserWorkspacesAcrossOrgs(testEnv, userId, orgs);

      expect(allWorkspaces.length).toBe(3); // One default workspace per org
      expect(allWorkspaces.map(w => w.org_id).sort()).toEqual(
        orgs.map(o => o.org_id).sort()
      );
    });

    it('should include workspaces from orgs where user is member (not owner)', async () => {
      // Create owner and their org
      const ownerEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
      const { org: ownerOrg } = await createOrg(testEnv, 'Owner Org', ownerId);

      // Create member and their org
      const memberEmail = testEmail();
      const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
      const { org: memberOrg } = await createOrg(testEnv, 'Member Org', memberId);

      // Invite member to owner's org
      const invitation = await createInvitation(testEnv, ownerOrg.id, memberEmail, 'member', ownerId);
      expect(invitation).not.toBeNull();

      // Accept invitation
      const accepted = await acceptInvitation(testEnv, ownerOrg.id, invitation!.id, memberId);
      expect(accepted).toBe(true);

      // Get member's orgs and workspaces
      const memberOrgs = await getUserOrgs(testEnv, memberId);
      const memberOrgIds = memberOrgs.map(o => o.org_id);

      // Member should now have access to both their own org and owner's org
      expect(memberOrgIds).toContain(ownerOrg.id);
      expect(memberOrgIds).toContain(memberOrg.id);

      // Fetch all workspaces for member
      const allWorkspaces = await listUserWorkspacesAcrossOrgs(testEnv, memberId, memberOrgs);

      // Member should see workspaces from both orgs
      expect(allWorkspaces.length).toBe(2);
    });
  });

  describe('Session and auth context integration', () => {
    it('should create session with correct org and workspace', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Session User');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', userId);

      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspaceId = workspaces[0].id;

      const { sessionId, sessionData } = await createTestSession(userId, org.id);

      expect(sessionData.user_id).toBe(userId);
      expect(sessionData.org_id).toBe(org.id);
      expect(sessionData.workspace_id).toBe(workspaceId);
    });

    it('should handle user switching between orgs', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Org Switcher');

      // Create two orgs
      const { org: org1, defaultWorkspaceId: ws1Id } = await createOrg(testEnv, 'First Org', userId);
      const { org: org2, defaultWorkspaceId: ws2Id } = await createOrg(testEnv, 'Second Org', userId);

      const orgs = await getUserOrgs(testEnv, userId);
      expect(orgs.length).toBe(2);

      // Get workspaces for each org
      const ws1 = await listUserWorkspaces(testEnv, userId, org1.id);
      const ws2 = await listUserWorkspaces(testEnv, userId, org2.id);

      expect(ws1.length).toBeGreaterThanOrEqual(1);
      expect(ws2.length).toBeGreaterThanOrEqual(1);
      // Workspaces from different orgs have different IDs
      expect(ws1[0].id).toBe(ws1Id);
      expect(ws2[0].id).toBe(ws2Id);
      expect(ws1[0].id).not.toBe(ws2[0].id);
    });
  });
});
