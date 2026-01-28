/**
 * Test helpers for direct DO calls
 *
 * These helpers replace the DoRpcService for tests, using direct DO namespace bindings.
 */

import type { UserDO, OrgDO, OrgRole, User } from '../src/auth';
import type { WorkspaceDO, Workspace, WorkspaceAccessLevel as WorkspaceAccessLevelDO } from '../src/workspace';
import { hashPassword, verifyPassword } from '../src/password';
import { getSession, updateSession, destroySession, type SessionData } from '../src/session-kv';
import { encryptCredentials, decryptCredentials } from '../../../src/lib/integration-crypto';
import { mapCredentialsToEnvVars } from '../src/integration-env';

export interface TestEnv {
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  EMAIL_TO_USER: KVNamespace;
  SESSIONS: KVNamespace;
  API_TOKENS: KVNamespace;
  INTEGRATION_SECRET_KEY?: string;
}

// Helper to generate unique IDs
function generateId(): string {
  return crypto.randomUUID();
}

// ============ User Operations ============

export async function createUser(
  env: TestEnv,
  email: string,
  password: string,
  name: string
): Promise<{ userId: string; user: User }> {
  const userId = generateId();
  const userStub = env.USER.get(env.USER.idFromName(userId));

  const user = await userStub.createUser(userId, email, password, name);

  // Store email -> userId mapping
  await env.EMAIL_TO_USER.put(email.toLowerCase(), userId);

  return { userId, user };
}

export async function getUserByEmail(
  env: TestEnv,
  email: string
): Promise<{ userId: string; user: User } | null> {
  const userId = await env.EMAIL_TO_USER.get(email.toLowerCase());
  if (!userId) return null;

  const userStub = env.USER.get(env.USER.idFromName(userId));
  const profile = await userStub.getProfile();
  if (!profile) return null;

  return { userId, user: profile };
}

export async function getUserById(
  env: TestEnv,
  userId: string
): Promise<User | null> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  return userStub.getProfile();
}

export async function verifyUserPassword(
  env: TestEnv,
  userId: string,
  password: string
): Promise<boolean> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  return userStub.verifyPassword(password);
}

export async function getUserOrgs(
  env: TestEnv,
  userId: string
): Promise<Array<{ org_id: string; org_name: string; role: OrgRole; last_workspace_id: string | null }>> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const orgs = await userStub.getOrgs();

  const result: Array<{ org_id: string; org_name: string; role: OrgRole; last_workspace_id: string | null }> = [];
  for (const org of orgs) {
    const orgStub = env.ORG.get(env.ORG.idFromName(org.org_id));
    const info = await orgStub.getInfo();
    if (info && !info.archived) {
      result.push({
        org_id: org.org_id,
        org_name: info.name,
        role: org.role,
        last_workspace_id: org.last_workspace_id,
      });
    }
  }
  return result;
}

export async function checkUserOrphaned(env: TestEnv, userId: string): Promise<void> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const orgs = await userStub.getOrgs();

  // Check if user has any non-archived orgs
  let hasOrg = false;
  for (const org of orgs) {
    const orgStub = env.ORG.get(env.ORG.idFromName(org.org_id));
    const info = await orgStub.getInfo();
    if (info && !info.archived) {
      hasOrg = true;
      break;
    }
  }

  await userStub.setOrphaned(!hasOrg);
}

export async function handleOrphanedUserLogin(
  env: TestEnv,
  userId: string
): Promise<{ org: { id: string; name: string }; workspace: { id: string; name: string } } | null> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const profile = await userStub.getProfile();
  if (!profile || !profile.is_orphaned) return null;

  // Create a new org for the orphaned user (which also creates default workspace)
  const { org, defaultWorkspaceId } = await createOrg(env, `${profile.name}'s Workspace`, userId);

  // Get default workspace info
  const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(defaultWorkspaceId));
  const workspace = await wsStub.getInfo();

  await userStub.setOrphaned(false);

  return {
    org: { id: org.id, name: org.name },
    workspace: { id: workspace!.id, name: workspace!.name },
  };
}

// ============ Organization Operations ============

export async function createOrg(
  env: TestEnv,
  name: string,
  createdBy: string
): Promise<{ org: { id: string; name: string; created_by: string }; defaultWorkspaceId: string }> {
  const orgId = generateId();
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  const { org, defaultWorkspaceId } = await orgStub.createOrg(orgId, name, createdBy);

  // Add org to user's orgs
  // Note: Org members have 'full' workspace access by default (no explicit record needed)
  const userStub = env.USER.get(env.USER.idFromName(createdBy));
  await userStub.addOrg(orgId, 'owner', defaultWorkspaceId);

  return { org: { id: org.id, name: org.name, created_by: org.created_by }, defaultWorkspaceId };
}

export async function getOrg(
  env: TestEnv,
  orgId: string
): Promise<{ id: string; name: string; created_by: string; archived?: boolean } | null> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await orgStub.getInfo();
  if (!info) return null;
  return { id: info.id, name: info.name, created_by: info.created_by, archived: info.archived };
}

export async function updateOrgName(
  env: TestEnv,
  orgId: string,
  name: string,
  actorId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.updateName(name, actorId);
}

export async function isOrgMember(env: TestEnv, userId: string, orgId: string): Promise<boolean> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  return userStub.hasOrg(orgId);
}

export async function isOrgAdmin(env: TestEnv, userId: string, orgId: string): Promise<boolean> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  return orgStub.isAdmin(userId);
}

export async function getOrgMembers(
  env: TestEnv,
  orgId: string
): Promise<Array<{ user: { id: string; name: string; email: string }; role: OrgRole }>> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const members = await orgStub.getMembers();

  const result: Array<{ user: { id: string; name: string; email: string }; role: OrgRole }> = [];
  for (const member of members) {
    const userStub = env.USER.get(env.USER.idFromName(member.user_id));
    const profile = await userStub.getProfile();
    if (profile) {
      result.push({
        user: { id: member.user_id, name: profile.name, email: profile.email },
        role: member.role,
      });
    }
  }
  return result;
}

export async function removeOrgMember(
  env: TestEnv,
  orgId: string,
  userId: string,
  actorId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  // Revoke workspace access for all workspaces in the org
  const workspaces = await orgStub.getWorkspaces();
  for (const ws of workspaces) {
    if (ws.archived) continue;
    const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
    await workspaceStub.setMemberAccess(userId, 'none', actorId);
  }

  await orgStub.removeMember(userId, actorId);

  // Remove org from user's orgs
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.removeOrg(orgId);

  // Check if user is now orphaned
  await checkUserOrphaned(env, userId);
}

export async function tryRemoveOrgMember(
  env: TestEnv,
  orgId: string,
  userId: string,
  actorId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  // Check if trying to remove the owner
  const isOwner = await orgStub.isOwner(userId);
  if (isOwner) {
    return { ok: false, error: 'Cannot remove organization owner' };
  }

  await removeOrgMember(env, orgId, userId, actorId);
  return { ok: true };
}

export async function updateOrgMemberRole(
  env: TestEnv,
  orgId: string,
  userId: string,
  role: OrgRole,
  actorId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.updateMemberRole(userId, role, actorId);

  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.updateOrgRole(orgId, role);
}

export async function tryUpdateOrgMemberRole(
  env: TestEnv,
  orgId: string,
  userId: string,
  role: OrgRole,
  actorId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  // Check if trying to change the owner's role
  const isOwner = await orgStub.isOwner(userId);
  if (isOwner && role !== 'owner') {
    return { ok: false, error: 'Cannot change the owner role. Transfer ownership first.' };
  }

  await updateOrgMemberRole(env, orgId, userId, role, actorId);
  return { ok: true };
}

export async function transferOrgOwnership(
  env: TestEnv,
  orgId: string,
  newOwnerId: string,
  actorId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.transferOwnership(actorId, newOwnerId);

  // Update roles in user DOs
  const actorUserStub = env.USER.get(env.USER.idFromName(actorId));
  await actorUserStub.updateOrgRole(orgId, 'admin');

  const newOwnerUserStub = env.USER.get(env.USER.idFromName(newOwnerId));
  await newOwnerUserStub.updateOrgRole(orgId, 'owner');
}

export async function archiveOrg(
  env: TestEnv,
  orgId: string,
  actorId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  // Archive all workspaces (update both WorkspaceDO and OrgDO)
  const workspaces = await orgStub.getWorkspaces();
  for (const ws of workspaces) {
    if (ws.archived) continue;
    const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
    await workspaceStub.archive(actorId);
    await orgStub.archiveWorkspace(ws.id);
  }

  // Get members before archiving
  const members = await orgStub.getMembers();

  // Remove non-owner members from the org (owner stays for audit)
  for (const member of members) {
    if (member.role !== 'owner') {
      try {
        await orgStub.removeMember(member.user_id, actorId);
      } catch {
        // Ignore if can't remove (e.g., owner)
      }
    }
  }

  // Archive the org
  await orgStub.archiveOrg(actorId);

  // Remove org from all members' user profiles
  for (const member of members) {
    const userStub = env.USER.get(env.USER.idFromName(member.user_id));
    await userStub.removeOrg(orgId);
    await checkUserOrphaned(env, member.user_id);
  }
}

export async function getOrgAuditLog(
  env: TestEnv,
  orgId: string
): Promise<Array<{ action: string; actor_id: string; target_id: string | null; details: Record<string, unknown> | null }>> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const audit = await orgStub.getAuditLog();
  return audit.map((entry) => ({
    action: entry.action,
    actor_id: entry.actor_id,
    target_id: entry.target_id,
    details: entry.details ? JSON.parse(entry.details) : null,
  }));
}

// ============ Invitation Operations ============

export async function createInvitation(
  env: TestEnv,
  orgId: string,
  email: string,
  role: OrgRole,
  actorId: string
): Promise<{ id: string; expires_at: number }> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await orgStub.createInvitation(email, role, actorId);
  return { id: invitation.id, expires_at: invitation.expires_at };
}

export async function getOrgInvitations(
  env: TestEnv,
  orgId: string
): Promise<Array<{ id: string; email: string; role: OrgRole }>> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitations = await orgStub.getInvitations();
  return invitations.map((inv) => ({ id: inv.id, email: inv.email, role: inv.role }));
}

export async function getInvitation(
  env: TestEnv,
  orgId: string,
  invitationId: string
): Promise<{ id: string; email: string; role: OrgRole; org: { id: string; name: string } } | null> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await orgStub.getInvitation(invitationId);
  if (!invitation) return null;

  const orgInfo = await orgStub.getInfo();
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    org: { id: orgId, name: orgInfo?.name || '' },
  };
}

export async function acceptInvitation(
  env: TestEnv,
  orgId: string,
  invitationId: string,
  userId: string
): Promise<boolean> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await orgStub.getInvitation(invitationId);
  if (!invitation) return false;

  const accepted = await orgStub.acceptInvitation(invitationId, userId);
  if (!accepted) return false;

  // Grant default workspace access
  const workspaces = await orgStub.getWorkspaces();
  for (const ws of workspaces) {
    if (ws.archived) continue;
    const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
    await workspaceStub.setMemberAccess(userId, 'full', userId);
  }

  // Add org to user's orgs
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const defaultWorkspaceId = workspaces.find((ws) => !ws.archived)?.id || null;
  await userStub.addOrg(orgId, invitation.role, defaultWorkspaceId);
  await userStub.setOrphaned(false);

  return true;
}

export async function deleteInvitation(
  env: TestEnv,
  orgId: string,
  invitationId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.deleteInvitation(invitationId);
}

// ============ Workspace Operations ============

export async function createWorkspace(
  env: TestEnv,
  orgId: string,
  name: string,
  createdBy: string,
  description?: string
): Promise<{ id: string; org_id: string; name: string }> {
  const workspaceId = generateId();
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  await workspaceStub.createWorkspace(workspaceId, orgId, name, createdBy, description);

  // Register workspace with org
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.addWorkspace(workspaceId, name, Date.now(), createdBy);

  // Grant access to all org members
  const members = await orgStub.getMembers();
  for (const member of members) {
    await workspaceStub.setMemberAccess(member.user_id, 'full', createdBy);
  }

  return { id: workspaceId, org_id: orgId, name };
}

export async function getWorkspace(
  env: TestEnv,
  workspaceId: string
): Promise<Workspace | null> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await workspaceStub.getInfo();
  if (!info || info.archived) return null;
  return info;
}

export async function updateWorkspace(
  env: TestEnv,
  workspaceId: string,
  updates: { name?: string; description?: string },
  actorId: string
): Promise<Workspace | null> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  return workspaceStub.updateWorkspace(updates, actorId);
}

export async function listOrgWorkspaces(
  env: TestEnv,
  orgId: string
): Promise<Array<{ id: string; name: string }>> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const workspaces = await orgStub.getWorkspaces();
  return workspaces
    .filter((ws) => !ws.archived)
    .map((ws) => ({ id: ws.id, name: ws.name }));
}

export async function listUserWorkspaces(
  env: TestEnv,
  userId: string,
  orgId: string
): Promise<Array<{ id: string; name: string; access_level: WorkspaceAccessLevelDO }>> {
  // First check if user is an org member
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const isOrgMember = await userStub.hasOrg(orgId);
  if (!isOrgMember) {
    return [];
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const workspaces = await orgStub.getWorkspaces();

  const result: Array<{ id: string; name: string; access_level: WorkspaceAccessLevelDO }> = [];
  for (const ws of workspaces) {
    if (ws.archived) continue;
    const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
    const member = await workspaceStub.getMemberAccess(userId);
    // If no explicit record exists, org members have 'full' access by default
    const access = member?.access_level ?? 'full';
    if (access !== 'none') {
      result.push({ id: ws.id, name: ws.name, access_level: access });
    }
  }
  return result;
}

export async function listUserWorkspacesAcrossOrgs(
  env: TestEnv,
  userId: string
): Promise<Array<{ id: string; name: string; org_id: string; access_level: WorkspaceAccessLevelDO }>> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const orgs = await userStub.getOrgs();

  const result: Array<{ id: string; name: string; org_id: string; access_level: WorkspaceAccessLevelDO }> = [];
  for (const org of orgs) {
    const orgStub = env.ORG.get(env.ORG.idFromName(org.org_id));
    const workspaces = await orgStub.getWorkspaces();

    for (const ws of workspaces) {
      if (ws.archived) continue;
      const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
      const member = await workspaceStub.getMemberAccess(userId);
      const access = member?.access_level ?? 'full';
      if (access !== 'none') {
        result.push({ id: ws.id, name: ws.name, org_id: org.org_id, access_level: access });
      }
    }
  }
  return result;
}

export async function archiveWorkspace(
  env: TestEnv,
  workspaceId: string,
  actorId: string
): Promise<void> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await workspaceStub.getInfo();
  if (!info) return;

  await workspaceStub.archive(actorId);

  // Update org's workspace list
  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  await orgStub.archiveWorkspace(workspaceId);

  // Clear last_workspace_id for users who had this as their last workspace
  const members = await orgStub.getMembers();
  for (const member of members) {
    const userStub = env.USER.get(env.USER.idFromName(member.user_id));
    const orgs = await userStub.getOrgs();
    const orgEntry = orgs.find((o) => o.org_id === info.org_id);
    if (orgEntry?.last_workspace_id === workspaceId) {
      // Find another workspace
      const otherWorkspaces = await listUserWorkspaces(env, member.user_id, info.org_id);
      const newWorkspaceId = otherWorkspaces[0]?.id || null;
      await userStub.setOrgLastWorkspace(info.org_id, newWorkspaceId);
    }
  }
}

export async function tryArchiveWorkspace(
  env: TestEnv,
  workspaceId: string,
  actorId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await workspaceStub.getInfo();
  if (!info) return { ok: false, error: 'Workspace not found' };

  // Check if this is the only workspace
  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  const workspaces = await orgStub.getWorkspaces();
  const activeWorkspaces = workspaces.filter((ws) => !ws.archived);
  if (activeWorkspaces.length <= 1) {
    return { ok: false, error: 'Cannot archive the only workspace in an organization' };
  }

  await archiveWorkspace(env, workspaceId, actorId);
  return { ok: true };
}

export async function getWorkspaceAuditLog(
  env: TestEnv,
  workspaceId: string
): Promise<Array<{ action: string; actor_id: string }>> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const audit = await workspaceStub.getAuditLog();
  return audit.map((entry) => ({ action: entry.action, actor_id: entry.actor_id }));
}

// ============ Workspace Access Operations ============

export async function setWorkspaceAccess(
  env: TestEnv,
  workspaceId: string,
  userId: string,
  access: WorkspaceAccessLevelDO,
  actorId: string
): Promise<void> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  await workspaceStub.setMemberAccess(userId, access, actorId);
}

export async function getWorkspaceAccess(
  env: TestEnv,
  workspaceId: string,
  userId: string
): Promise<WorkspaceAccessLevelDO> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await workspaceStub.getInfo();
  if (!info) return 'none';

  // Check if user is an org member
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const isOrgMember = await userStub.hasOrg(info.org_id);
  if (!isOrgMember) {
    return 'none';
  }

  const member = await workspaceStub.getMemberAccess(userId);
  // If no explicit record exists, org members have 'full' access by default
  return member?.access_level ?? 'full';
}

export async function listWorkspaceMembers(
  env: TestEnv,
  workspaceId: string
): Promise<Array<{ user_id: string; access_level: WorkspaceAccessLevelDO }>> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  return workspaceStub.listMembers();
}

// ============ Workspace Integration Operations ============

export async function createWorkspaceIntegration(
  env: TestEnv,
  workspaceId: string,
  actorId: string,
  data: {
    integration_type: string;
    name: string;
    config: Record<string, unknown>;
    credentials?: Record<string, string>;
    category?: string;
    auth_method?: string;
  }
): Promise<{ id: string; has_credentials: boolean }> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));

  let credentialsEncrypted: string | null = null;
  if (data.credentials && Object.keys(data.credentials).length > 0) {
    const secretKey = env.INTEGRATION_SECRET_KEY || 'test-secret-key-for-integration-tests';
    credentialsEncrypted = await encryptCredentials(data.credentials, secretKey);
  }

  const integrationId = generateId();
  await workspaceStub.createIntegration(
    integrationId,
    data.integration_type,
    data.name,
    data.category ?? 'general',
    data.auth_method ?? 'api_key',
    JSON.stringify(data.config),
    credentialsEncrypted ?? '',
    actorId
  );

  return { id: integrationId, has_credentials: !!credentialsEncrypted };
}

export async function updateWorkspaceIntegration(
  env: TestEnv,
  workspaceId: string,
  integrationId: string,
  actorId: string,
  data: { name?: string }
): Promise<{ name: string } | null> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as DurableObjectStub<
    WorkspaceDO & { getIntegration(id: string): Promise<{ name: string } | null> }
  >;
  await workspaceStub.updateIntegration(integrationId, data, actorId);
  // Fetch the updated integration to return the new values
  const updated = await workspaceStub.getIntegration(integrationId);
  if (!updated) return null;
  return { name: updated.name };
}

export async function deleteWorkspaceIntegration(
  env: TestEnv,
  workspaceId: string,
  integrationId: string,
  actorId: string
): Promise<void> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  await workspaceStub.deleteIntegration(integrationId, actorId);
}

export async function getWorkspaceIntegrations(
  env: TestEnv,
  workspaceId: string
): Promise<Array<{ id: string; name: string }>> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const integrations = await workspaceStub.getIntegrations();
  return integrations.map((i) => ({ id: i.id, name: i.name }));
}

export async function getWorkspaceIntegrationEnvVars(
  env: TestEnv,
  workspaceId: string
): Promise<Record<string, string>> {
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const records = await workspaceStub.getIntegrations();
  const secretKey = env.INTEGRATION_SECRET_KEY || 'test-secret-key-for-integration-tests';

  const envVars: Record<string, string> = {};
  for (const record of records) {
    if (record.enabled !== 1) continue;
    if (!record.credentials_encrypted) continue;

    const credentials = await decryptCredentials(record.credentials_encrypted, secretKey);
    const config = JSON.parse(record.config) as Record<string, unknown>;
    Object.assign(envVars, mapCredentialsToEnvVars(record.name, record.integration_type, credentials, config));
  }

  return envVars;
}

// ============ Session Operations ============

export async function getSessionData(
  env: TestEnv,
  sessionId: string
): Promise<SessionData | null> {
  return getSession(env.SESSIONS, sessionId);
}

export async function destroySessionData(
  env: TestEnv,
  sessionId: string
): Promise<void> {
  await destroySession(env.SESSIONS, sessionId);
}

export async function switchSessionOrg(
  env: TestEnv,
  sessionId: string,
  orgId: string
): Promise<void> {
  const session = await getSession(env.SESSIONS, sessionId);
  if (!session) return;

  // Get a workspace for this org
  const userStub = env.USER.get(env.USER.idFromName(session.user_id));
  const orgs = await userStub.getOrgs();
  const orgEntry = orgs.find((o) => o.org_id === orgId);
  let workspaceId = orgEntry?.last_workspace_id || null;

  if (!workspaceId) {
    const workspaces = await listUserWorkspaces(env, session.user_id, orgId);
    workspaceId = workspaces[0]?.id || null;
  }

  await updateSession(env.SESSIONS, sessionId, { org_id: orgId, workspace_id: workspaceId });
}

export async function switchSessionWorkspace(
  env: TestEnv,
  sessionId: string,
  workspaceId: string
): Promise<void> {
  const session = await getSession(env.SESSIONS, sessionId);
  if (!session) return;

  await updateSession(env.SESSIONS, sessionId, { workspace_id: workspaceId });

  // Update last_workspace_id in user's org membership
  const userStub = env.USER.get(env.USER.idFromName(session.user_id));
  await userStub.setOrgLastWorkspace(session.org_id, workspaceId);
}
