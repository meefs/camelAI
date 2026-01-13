/**
 * Workspace Durable Object tests using Cloudflare Vitest pool
 *
 * Run with: npm run test:workers
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { DoRpcService } from '../src/rpc-service';
import type { WorkspaceInfo, WorkspaceIntegrationRecord } from '../src/workspace';
import { createNewSession, type SessionData } from '../src/session-kv';

describe('Workspace DO (full-stack with DOs)', () => {
  const rpc = env.DO_RPC as unknown as DoRpcService;
  const sessionsKV = env.SESSIONS as KVNamespace;

  // Helper to create a session with the org's default workspace
  async function createTestSession(
    userId: string,
    orgId: string
  ): Promise<{ sessionId: string; sessionData: SessionData }> {
    const workspaces = await rpc.listOrgWorkspaces(orgId);
    const workspaceId = workspaces[0]?.id ?? null;
    return createNewSession(sessionsKV, userId, orgId, workspaceId);
  }

  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  it('creates a workspace and lists it under the org', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Workspace Owner');
    const org = await rpc.createOrg('Workspace Org', userId);

    const workspace = await rpc.createWorkspace(org.id, 'Design', userId, 'Design workspace');

    expect(workspace.id).toBeDefined();
    expect(workspace.org_id).toBe(org.id);
    expect(workspace.name).toBe('Design');

    const orgWorkspaces = await rpc.listOrgWorkspaces(org.id);
    expect(orgWorkspaces.some((entry) => entry.id === workspace.id)).toBe(true);
  });

  it('updates workspace metadata and records audit log entries', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Workspace Owner');
    const org = await rpc.createOrg('Audit Org', userId);

    const workspace = await rpc.createWorkspace(org.id, 'Initial', userId);
    const updated = await rpc.updateWorkspace(
      workspace.id,
      { name: 'Renamed', description: 'Updated description' },
      userId
    );

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Renamed');
    expect(updated!.description).toBe('Updated description');

    const audit = await rpc.getWorkspaceAuditLog(workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('workspace_created');
    expect(actions).toContain('workspace_updated');
  });

  it('archives workspace and preserves metadata for audit', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Archive Owner');
    const org = await rpc.createOrg('Archive Org', userId);

    const workspace = await rpc.createWorkspace(org.id, 'Archive Workspace', userId);
    await rpc.archiveWorkspace(workspace.id, userId);

    const fromApi = await rpc.getWorkspace(workspace.id);
    expect(fromApi).toBeNull();

    const userWorkspaces = await rpc.listUserWorkspaces(userId, org.id);
    expect(userWorkspaces.some((entry) => entry.id === workspace.id)).toBe(false);

    const orgWorkspaces = await rpc.listOrgWorkspaces(org.id);
    expect(orgWorkspaces.some((entry) => entry.id === workspace.id)).toBe(false);

    const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace.id)) as DurableObjectStub<{
      getInfo: () => Promise<WorkspaceInfo | null>;
    }>;
    const info = await workspaceStub.getInfo();
    expect(info?.archived).toBe(true);
    expect(info?.name).toBe('Archive Workspace');

    const audit = await rpc.getWorkspaceAuditLog(workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('workspace_archived');
  });

  describe('Workspace archive edge cases', () => {
    it('blocks archiving the only workspace in an org', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Solo Owner');
      const org = await rpc.createOrg('Solo Org', userId);

      const workspaces = await rpc.listOrgWorkspaces(org.id);
      expect(workspaces).toHaveLength(1);

      const result = await rpc.tryArchiveWorkspace(workspaces[0].id, userId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Cannot archive the only workspace in an organization');
    });

    it('keeps archived workspace entries archived after metadata updates', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Archive Owner');
      const org = await rpc.createOrg('Archive Metadata Org', userId);

      const workspace = await rpc.createWorkspace(org.id, 'Archive Me', userId);

      await rpc.archiveWorkspace(workspace.id, userId);
      const updated = await rpc.updateWorkspace(workspace.id, { name: 'Renamed Archived' }, userId);

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Renamed Archived');
      expect(updated!.archived).toBe(true);
    });

    it('repairs session workspace when the current workspace is archived', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Session Owner');
      const org = await rpc.createOrg('Session Org', userId);

      const secondWorkspace = await rpc.createWorkspace(org.id, 'Second', userId);
      const { sessionId } = await createTestSession(userId, org.id);

      const session = await rpc.getSession(sessionId);
      const defaultWorkspaceId = session?.workspace_id;
      expect(defaultWorkspaceId).toBeTruthy();
      expect(defaultWorkspaceId).not.toBe(secondWorkspace.id);

      await rpc.archiveWorkspace(defaultWorkspaceId!, userId);

      const repaired = await rpc.getSession(sessionId);
      expect(repaired?.workspace_id).toBe(secondWorkspace.id);
    });

    it('clears last_workspace_id when the workspace is archived', async () => {
      const email = testEmail();
      const { userId } = await rpc.createUser(email, 'password123', 'Org Owner');
      const org = await rpc.createOrg('Last Workspace Org', userId);
      const secondWorkspace = await rpc.createWorkspace(org.id, 'Second', userId);
      const { sessionId } = await createTestSession(userId, org.id);

      await rpc.switchSessionWorkspace(sessionId, secondWorkspace.id);

      let orgs = await rpc.getUserOrgs(userId);
      expect(orgs[0]?.last_workspace_id).toBe(secondWorkspace.id);

      await rpc.archiveWorkspace(secondWorkspace.id, userId);

      orgs = await rpc.getUserOrgs(userId);
      expect(orgs[0]?.last_workspace_id).not.toBe(secondWorkspace.id);
    });
  });

  it('manages workspace access levels', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Access Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    const workspaces = await rpc.listUserWorkspaces(ownerId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    await rpc.setWorkspaceAccess(workspace.id, memberId, 'read_only', ownerId);
    const access = await rpc.getWorkspaceAccess(workspace.id, memberId);
    expect(access).toBe('read_only');

    const memberWorkspaces = await rpc.listUserWorkspaces(memberId, org.id);
    expect(memberWorkspaces.some((entry) => entry.id === workspace.id && entry.access_level === 'read_only')).toBe(true);

    await rpc.setWorkspaceAccess(workspace.id, memberId, 'none', ownerId);
    const removedAccess = await rpc.getWorkspaceAccess(workspace.id, memberId);
    expect(removedAccess).toBe('none');
    const afterRemoval = await rpc.listUserWorkspaces(memberId, org.id);
    expect(afterRemoval.some((entry) => entry.id === workspace.id)).toBe(false);
  });

  it('revokes workspace access when org membership is removed', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Membership Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    const workspaces = await rpc.listUserWorkspaces(ownerId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const accessBefore = await rpc.getWorkspaceAccess(workspace.id, memberId);
    expect(accessBefore).toBe('full');

    await rpc.removeOrgMember(org.id, memberId, ownerId);

    const accessAfter = await rpc.getWorkspaceAccess(workspace.id, memberId);
    expect(accessAfter).toBe('none');

    const memberWorkspaces = await rpc.listUserWorkspaces(memberId, org.id);
    expect(memberWorkspaces).toHaveLength(0);
  });

  it('creates integration and stores encrypted credentials', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Integration Owner');
    const org = await rpc.createOrg('Integration Org', userId);
    const workspaces = await rpc.listUserWorkspaces(userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await rpc.createWorkspaceIntegration(workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    expect(integration.has_credentials).toBe(true);

    const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace.id)) as DurableObjectStub<{
      getIntegration: (id: string) => Promise<WorkspaceIntegrationRecord | null>;
    }>;
    const record = await workspaceStub.getIntegration(integration.id);
    expect(record?.credentials_encrypted).toBeTruthy();
    expect(record?.credentials_encrypted).not.toBe('secret-key');

    const audit = await rpc.getWorkspaceAuditLog(workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('integration_created');
  });

  it('updates integration and logs audit entry', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Integration Owner');
    const org = await rpc.createOrg('Integration Audit Org', userId);
    const workspaces = await rpc.listUserWorkspaces(userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await rpc.createWorkspaceIntegration(workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    const updated = await rpc.updateWorkspaceIntegration(workspace.id, integration.id, userId, {
      name: 'Airtable Updated',
    });
    expect(updated?.name).toBe('Airtable Updated');

    const audit = await rpc.getWorkspaceAuditLog(workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('integration_updated');
  });

  it('deletes integration (soft delete) and logs audit entry', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Integration Owner');
    const org = await rpc.createOrg('Integration Delete Org', userId);
    const workspaces = await rpc.listUserWorkspaces(userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await rpc.createWorkspaceIntegration(workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    await rpc.deleteWorkspaceIntegration(workspace.id, integration.id, userId);

    const audit = await rpc.getWorkspaceAuditLog(workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('integration_deleted');
  });

  it('does not expose deleted integrations in container env vars', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Env Vars Owner');
    const org = await rpc.createOrg('Env Vars Delete Org', userId);
    const workspaces = await rpc.listUserWorkspaces(userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await rpc.createWorkspaceIntegration(workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable Env',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    await rpc.deleteWorkspaceIntegration(workspace.id, integration.id, userId);

    const envVars = await rpc.getWorkspaceIntegrationEnvVars(workspace.id);
    expect(envVars.INT_AIRTABLE_API_KEY).toBeUndefined();
  });

  it('getIntegrations excludes soft-deleted entries', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Integration Owner');
    const org = await rpc.createOrg('Integration List Org', userId);
    const workspaces = await rpc.listUserWorkspaces(userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await rpc.createWorkspaceIntegration(workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    await rpc.deleteWorkspaceIntegration(workspace.id, integration.id, userId);

    const integrations = await rpc.getWorkspaceIntegrations(workspace.id);
    expect(integrations).toHaveLength(0);
  });

  it('lists workspace members with access levels', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Member Access Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    const workspaces = await rpc.listUserWorkspaces(ownerId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    await rpc.setWorkspaceAccess(workspace.id, memberId, 'read_only', ownerId);
    const members = await rpc.listWorkspaceMembers(workspace.id);
    const record = members.find((entry) => entry.user_id === memberId);
    expect(record?.access_level).toBe('read_only');
  });

  it('exposes integration env vars for container', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Integration Owner');
    const org = await rpc.createOrg('Env Vars Org', userId);
    const workspaces = await rpc.listUserWorkspaces(userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    await rpc.createWorkspaceIntegration(workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    const envVars = await rpc.getWorkspaceIntegrationEnvVars(workspace.id);
    expect(envVars.INT_AIRTABLE_API_KEY).toBe('secret-key');
  });

  it('logs access changes in workspace audit log', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Access Audit Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    const workspaces = await rpc.listUserWorkspaces(ownerId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    await rpc.setWorkspaceAccess(workspace.id, memberId, 'read_only', ownerId);
    await rpc.setWorkspaceAccess(workspace.id, memberId, 'none', ownerId);
    await rpc.setWorkspaceAccess(workspace.id, memberId, 'full', ownerId);

    const audit = await rpc.getWorkspaceAuditLog(workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('access_granted');
    expect(actions).toContain('access_changed');
    expect(actions).toContain('access_revoked');
  });
});
