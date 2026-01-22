import type {
  User,
  Organization,
  OrgMembership,
  OrgRole,
  Workspace,
  WorkspaceWithAccess,
  WorkspaceAccessLevel,
  WorkspaceMember,
  AuditLogEntry,
  CreateApiTokenInput,
  AdminOverview,
  AdminUserSummary,
  AdminWorkspaceSummary,
  AdminWorkspaceDetail,
  AdminThreadWithContext,
  AdminAppSummary,
  AdminAppDetail,
  AdminInvitation,
  PaginatedResult,
  PaginationParams,
  Message,
  AppPreviewStatus,
} from '@/types';
import {
  type UserProfile,
  type OrgInfo,
  type OrgThread,
  UserDO,
  OrgDO,
} from '../../workers/main/src/auth';
import { WorkspaceDO, type WorkspaceInfo } from '../../workers/main/src/workspace';
import {
  type SessionData,
  getSession as getSessionKV,
  destroySession as destroySessionKV,
  createNewSession as createNewSessionKV,
  updateSession as updateSessionKV,
} from '../../workers/main/src/session-kv';
import type { ApiTokenData } from '../../workers/main/src/api-tokens';
import {
  createApiToken,
  validateApiToken as validateApiTokenKV,
  deleteApiToken as deleteApiTokenKV,
} from '../../workers/main/src/api-tokens';
import { getWorkspaceContainer } from '../../workers/main/src/workspace-container';
import {
  validateAndConsumeAuthState,
  createWorkerAuthToken,
  type WorkerAuthState as WorkerAuthStateKV,
} from '../../workers/main/src/worker-auth';

/**
 * Auth environment bindings required by this module.
 * This interface provides direct access to DOs without RPC.
 */
export interface AuthEnv {
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  SESSIONS: KVNamespace;
  EMAIL_TO_USER: KVNamespace;
  API_TOKENS: KVNamespace;
}

// Helper to get UserDO stub
function getUserStub(env: AuthEnv, userId: string): UserDO {
  return env.USER.get(env.USER.idFromName(userId)) as unknown as UserDO;
}

// Helper to get OrgDO stub
function getOrgStub(env: AuthEnv, orgId: string): OrgDO {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgDO;
}

// Helper to get WorkspaceDO stub
function getWorkspaceStub(env: AuthEnv, workspaceId: string): WorkspaceDO {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as unknown as WorkspaceDO;
}

// Convert UserProfile to User
function profileToUser(profile: UserProfile): User {
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    created_at: profile.created_at,
    is_superuser: profile.is_superuser,
    avatar: {
      color: profile.avatar_color,
      content: profile.avatar_content,
    },
    is_orphaned: profile.is_orphaned,
  };
}

// Convert OrgInfo to Organization
function orgInfoToOrg(info: OrgInfo): Organization {
  return {
    id: info.id,
    name: info.name,
    created_at: info.created_at,
    created_by: info.created_by,
    billing_status: info.billing_status,
    archived: info.archived,
    archived_at: info.archived_at,
    archived_by: info.archived_by,
  };
}

// Convert WorkspaceInfo to Workspace
function wsInfoToWorkspace(info: WorkspaceInfo): Workspace {
  return {
    id: info.id,
    org_id: info.org_id,
    name: info.name,
    description: info.description,
    created_by: info.created_by,
    created_at: info.created_at,
    avatar: {
      color: info.avatar_color,
      content: info.avatar_content,
    },
    archived: info.archived,
    archived_at: info.archived_at,
    archived_by: info.archived_by,
  };
}

// Session functions
export async function getSession(env: AuthEnv, sessionId: string): Promise<SessionData | null> {
  return getSessionKV(env.SESSIONS, sessionId);
}

export async function getSessionWithUser(
  env: AuthEnv,
  sessionId: string
): Promise<{ session: SessionData; user: UserProfile } | null> {
  const session = await getSessionKV(env.SESSIONS, sessionId);
  if (!session) return null;
  const stub = getUserStub(env, session.user_id);
  const user = await stub.getProfile();
  if (!user) return null;
  return { session, user };
}

export async function createSession(
  env: AuthEnv,
  userId: string,
  orgId: string,
  workspaceId: string | null = null
): Promise<{ sessionId: string; sessionData: SessionData }> {
  return createNewSessionKV(env.SESSIONS, userId, orgId, workspaceId);
}

export async function destroySession(env: AuthEnv, sessionId: string): Promise<void> {
  return destroySessionKV(env.SESSIONS, sessionId);
}

export async function switchSessionOrg(
  env: AuthEnv,
  sessionId: string,
  orgId: string,
  workspaceId: string | null = null
): Promise<void> {
  const session = await getSessionKV(env.SESSIONS, sessionId);
  if (!session) throw new Error('Session not found');
  session.org_id = orgId;
  session.workspace_id = workspaceId;
  await updateSessionKV(env.SESSIONS, sessionId, session);
  // Update user's last workspace for this org
  if (workspaceId) {
    const stub = getUserStub(env, session.user_id);
    await stub.setOrgLastWorkspace(orgId, workspaceId);
  }
}

export async function switchSessionWorkspace(env: AuthEnv, sessionId: string, workspaceId: string | null): Promise<void> {
  const session = await getSessionKV(env.SESSIONS, sessionId);
  if (!session) throw new Error('Session not found');
  session.workspace_id = workspaceId;
  await updateSessionKV(env.SESSIONS, sessionId, session);
  // Update user's last workspace for this org
  if (workspaceId && session.org_id) {
    const stub = getUserStub(env, session.user_id);
    await stub.setOrgLastWorkspace(session.org_id, workspaceId);
  }
}

// User functions
export async function getUserByEmail(env: AuthEnv, email: string): Promise<{ userId: string; user: UserProfile } | null> {
  const normalizedEmail = email.toLowerCase();
  const userId = await env.EMAIL_TO_USER.get(`email:${normalizedEmail}`);
  if (!userId) return null;
  const stub = getUserStub(env, userId);
  const user = await stub.getProfile();
  if (!user) return null;
  return { userId, user };
}

export async function getUserById(env: AuthEnv, userId: string): Promise<UserProfile | null> {
  const stub = getUserStub(env, userId);
  return stub.getProfile();
}

export async function getUsersByIds(env: AuthEnv, userIds: string[]): Promise<UserProfile[]> {
  const results = await Promise.all(
    userIds.map(async (userId) => {
      const stub = getUserStub(env, userId);
      return stub.getProfile();
    })
  );
  return results.filter((p): p is UserProfile => p !== null);
}

export async function updateUserProfile(
  env: AuthEnv,
  userId: string,
  updates: { name?: string | null; avatar?: { color: string; content: string } }
): Promise<User | null> {
  const stub = getUserStub(env, userId);
  const profile = await stub.updateProfile({
    name: updates.name,
    avatar_color: updates.avatar?.color,
    avatar_content: updates.avatar?.content,
  });
  if (!profile) return null;
  return profileToUser(profile);
}

export async function createUser(
  env: AuthEnv,
  email: string,
  password: string,
  name: string | null
): Promise<{ userId: string; user: UserProfile }> {
  const normalizedEmail = email.toLowerCase();
  const emailKvKey = `email:${normalizedEmail}`;

  // Check if email already exists
  const existingUserId = await env.EMAIL_TO_USER.get(emailKvKey);
  if (existingUserId) {
    throw new Error('An account with this email already exists');
  }

  const userId = crypto.randomUUID();

  // Claim the email
  await env.EMAIL_TO_USER.put(emailKvKey, userId);

  // Verify we still own it
  const verifyEmail = await env.EMAIL_TO_USER.get(emailKvKey);
  if (verifyEmail !== userId) {
    throw new Error('An account with this email already exists');
  }

  try {
    const stub = getUserStub(env, userId);
    const user = await stub.createUser(userId, normalizedEmail, password, name);
    return { userId, user };
  } catch (error) {
    // Clean up on failure
    await env.EMAIL_TO_USER.delete(emailKvKey);
    throw error;
  }
}

export async function verifyUserPassword(env: AuthEnv, userId: string, password: string): Promise<boolean> {
  const stub = getUserStub(env, userId);
  return stub.verifyPassword(password);
}

// OAuth functions
export async function getUserByOAuthProvider(
  env: AuthEnv,
  provider: 'google' | 'github',
  providerId: string
): Promise<{ userId: string; user: UserProfile } | null> {
  const oauthKvKey = `oauth:${provider}:${providerId}`;
  const userId = await env.EMAIL_TO_USER.get(oauthKvKey);
  if (!userId) return null;
  const stub = getUserStub(env, userId);
  const user = await stub.getProfile();
  if (!user) return null;
  return { userId, user };
}

export async function createUserFromOAuth(
  env: AuthEnv,
  email: string,
  name: string | null,
  provider: 'google' | 'github',
  providerId: string
): Promise<{ userId: string; user: UserProfile }> {
  const normalizedEmail = email.toLowerCase();
  const emailKvKey = `email:${normalizedEmail}`;
  const oauthKvKey = `oauth:${provider}:${providerId}`;

  // Check if email already exists
  const existingUserId = await env.EMAIL_TO_USER.get(emailKvKey);
  if (existingUserId) {
    throw new Error('An account with this email already exists');
  }

  // Check if OAuth provider already linked
  const existingOAuthUserId = await env.EMAIL_TO_USER.get(oauthKvKey);
  if (existingOAuthUserId) {
    throw new Error('This OAuth account is already linked to another user');
  }

  const userId = crypto.randomUUID();

  // Claim the email and OAuth provider
  await Promise.all([
    env.EMAIL_TO_USER.put(emailKvKey, userId),
    env.EMAIL_TO_USER.put(oauthKvKey, userId),
  ]);

  // Verify we still own them
  const [verifyEmail, verifyOAuth] = await Promise.all([
    env.EMAIL_TO_USER.get(emailKvKey),
    env.EMAIL_TO_USER.get(oauthKvKey),
  ]);

  if (verifyEmail !== userId || verifyOAuth !== userId) {
    // Clean up and abort
    await Promise.all([
      env.EMAIL_TO_USER.delete(emailKvKey),
      env.EMAIL_TO_USER.delete(oauthKvKey),
    ]);
    throw new Error('An account with this email or OAuth provider already exists');
  }

  try {
    const stub = getUserStub(env, userId);
    const user = await stub.createUserFromOAuth(userId, normalizedEmail, name, provider, providerId);
    return { userId, user };
  } catch (error) {
    // Clean up on failure
    await Promise.all([
      env.EMAIL_TO_USER.delete(emailKvKey),
      env.EMAIL_TO_USER.delete(oauthKvKey),
    ]);
    throw error;
  }
}

export async function linkOAuthProvider(
  env: AuthEnv,
  userId: string,
  provider: 'google' | 'github',
  providerId: string
): Promise<void> {
  const oauthKvKey = `oauth:${provider}:${providerId}`;

  // Check if already linked to another user
  const existingUserId = await env.EMAIL_TO_USER.get(oauthKvKey);
  if (existingUserId && existingUserId !== userId) {
    throw new Error('This OAuth account is already linked to another user');
  }

  // Link in KV and DO
  await env.EMAIL_TO_USER.put(oauthKvKey, userId);
  const stub = getUserStub(env, userId);
  await stub.linkOAuthProvider(provider, providerId);
}

export async function getUserOAuthProviders(
  env: AuthEnv,
  userId: string
): Promise<Array<{ provider: string; provider_id: string; linked_at: number }>> {
  const stub = getUserStub(env, userId);
  return stub.getOAuthProviders();
}

export async function getUserOrgs(env: AuthEnv, userId: string): Promise<OrgMembership[]> {
  const userStub = getUserStub(env, userId);
  const userOrgs = await userStub.getOrgs();

  const memberships: OrgMembership[] = [];
  for (const uo of userOrgs) {
    const orgStub = getOrgStub(env, uo.org_id);
    const orgInfo = await orgStub.getInfo();
    if (orgInfo && !orgInfo.archived) {
      memberships.push({
        org_id: uo.org_id,
        org_name: orgInfo.name,
        role: uo.role,
        joined_at: uo.joined_at,
        last_workspace_id: uo.last_workspace_id ?? null,
      });
    }
  }

  return memberships;
}

export async function addUserToOrg(env: AuthEnv, userId: string, orgId: string, role: OrgRole): Promise<void> {
  const workspaces = await listOrgWorkspaces(env, orgId);
  const lastWorkspaceId = workspaces[0]?.id ?? null;
  const userStub = getUserStub(env, userId);
  await userStub.addOrg(orgId, role, lastWorkspaceId);
}

export async function removeUserFromOrg(env: AuthEnv, userId: string, orgId: string): Promise<void> {
  const userStub = getUserStub(env, userId);
  await userStub.removeOrg(orgId);
}

// Admin functions that operate on single DOs (real implementations)
export async function adminUpdateUser(
  env: AuthEnv,
  userId: string,
  updates: { name?: string | null; avatar?: { color: string; content: string } }
): Promise<User | null> {
  const stub = getUserStub(env, userId);
  // Note: is_superuser is determined by email domain, not manually set
  const profile = await stub.updateProfile({
    name: updates.name,
    avatar_color: updates.avatar?.color,
    avatar_content: updates.avatar?.content,
  });
  if (!profile) return null;
  return profileToUser(profile);
}

export async function adminUpdateWorkspace(
  env: AuthEnv,
  workspaceId: string,
  updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } },
  actorId: string
): Promise<Workspace | null> {
  const stub = getWorkspaceStub(env, workspaceId);
  const info = await stub.updateWorkspace({
    name: updates.name,
    description: updates.description,
    avatar_color: updates.avatar?.color,
    avatar_content: updates.avatar?.content,
  }, actorId);
  if (!info) return null;
  return wsInfoToWorkspace(info);
}

export async function adminArchiveWorkspace(env: AuthEnv, workspaceId: string, actorId: string): Promise<Workspace | null> {
  const stub = getWorkspaceStub(env, workspaceId);
  const info = await stub.archive(actorId);
  if (!info) return null;
  return wsInfoToWorkspace(info);
}

export async function adminTransferOrgOwnership(
  env: AuthEnv,
  orgId: string,
  newOwnerId: string,
  actorId: string
): Promise<void> {
  const orgStub = getOrgStub(env, orgId);
  const members = await orgStub.getMembers();
  const currentOwner = members.find((member) => member.role === 'owner');
  if (!currentOwner) {
    throw new Error('Organization has no owner');
  }

  await orgStub.adminTransferOwnership(actorId, newOwnerId);

  const newOwnerStub = getUserStub(env, newOwnerId);
  await newOwnerStub.updateOrgRole(orgId, 'owner');

  const oldOwnerStub = getUserStub(env, currentOwner.user_id);
  await oldOwnerStub.updateOrgRole(orgId, 'admin');
}

export async function adminAddOrgMember(
  env: AuthEnv,
  orgId: string,
  userId: string,
  role: 'admin' | 'member',
  actorId: string
): Promise<void> {
  const orgStub = getOrgStub(env, orgId);
  await orgStub.addMember(userId, role, actorId);
  const workspaces = await listOrgWorkspaces(env, orgId);
  const lastWorkspaceId = workspaces[0]?.id ?? null;
  const userStub = getUserStub(env, userId);
  await userStub.addOrg(orgId, role, lastWorkspaceId);
  await userStub.setOrphaned(false);
}

export async function adminForceOrphanUser(env: AuthEnv, userId: string, _actorId: string): Promise<void> {
  const userStub = getUserStub(env, userId);
  const orgs = await userStub.getOrgs();
  // Remove from all orgs
  for (const org of orgs) {
    const orgStub = getOrgStub(env, org.org_id);
    await orgStub.removeMember(userId, userId);
    await userStub.removeOrg(org.org_id);
  }
  await userStub.setOrphaned(true);
}

export async function adminDeleteInvitation(env: AuthEnv, orgId: string, invitationId: string): Promise<void> {
  const stub = getOrgStub(env, orgId);
  await stub.deleteInvitation(invitationId);
}

// Organization functions
export async function getOrg(env: AuthEnv, orgId: string): Promise<Organization | null> {
  const stub = getOrgStub(env, orgId);
  const info = await stub.getInfo();
  if (!info) return null;
  return orgInfoToOrg(info);
}

export async function createOrg(env: AuthEnv, name: string, createdBy: string): Promise<Organization> {
  const orgId = crypto.randomUUID();
  const orgStub = getOrgStub(env, orgId);
  // createOrg now creates the default workspace internally
  const { org: info, defaultWorkspaceId } = await orgStub.createOrg(orgId, name, createdBy);

  // Add to user's orgs with the default workspace
  const userStub = getUserStub(env, createdBy);
  await userStub.addOrg(orgId, 'owner', defaultWorkspaceId);

  return orgInfoToOrg(info);
}

export async function updateOrgName(env: AuthEnv, orgId: string, name: string, actorId: string): Promise<void> {
  const stub = getOrgStub(env, orgId);
  await stub.updateName(name, actorId);
}

export async function getOrgMembers(env: AuthEnv, orgId: string): Promise<Array<{ user: User; role: OrgRole; joined_at: number }>> {
  const stub = getOrgStub(env, orgId);
  const members = await stub.getMembers();
  const results: Array<{ user: User; role: OrgRole; joined_at: number }> = [];
  for (const member of members) {
    const userStub = getUserStub(env, member.user_id);
    const profile = await userStub.getProfile();
    if (profile) {
      results.push({
        user: profileToUser(profile),
        role: member.role,
        joined_at: member.joined_at,
      });
    }
  }
  return results;
}

export async function isOrgMember(env: AuthEnv, userId: string, orgId: string): Promise<boolean> {
  const stub = getOrgStub(env, orgId);
  const info = await stub.getInfo();
  if (!info || info.archived) return false;
  return stub.isMember(userId);
}

export async function isOrgAdmin(env: AuthEnv, userId: string, orgId: string): Promise<boolean> {
  const stub = getOrgStub(env, orgId);
  const info = await stub.getInfo();
  if (!info || info.archived) return false;
  const member = await stub.getMember(userId);
  return member?.role === 'owner' || member?.role === 'admin';
}

export async function removeOrgMember(env: AuthEnv, orgId: string, userId: string, actorId: string): Promise<void> {
  const stub = getOrgStub(env, orgId);
  await stub.removeMember(userId, actorId);
  // Also remove from user's org list
  const userStub = getUserStub(env, userId);
  await userStub.removeOrg(orgId);
}

export async function updateOrgMemberRole(env: AuthEnv, orgId: string, userId: string, role: OrgRole, actorId: string): Promise<void> {
  const stub = getOrgStub(env, orgId);
  await stub.updateMemberRole(userId, role, actorId);
}

export async function transferOrgOwnership(env: AuthEnv, orgId: string, newOwnerId: string, actorId: string): Promise<void> {
  const stub = getOrgStub(env, orgId);
  await stub.transferOwnership(newOwnerId, actorId);
  // Update user roles
  const newOwnerStub = getUserStub(env, newOwnerId);
  await newOwnerStub.updateOrgRole(orgId, 'owner');
  const oldOwnerStub = getUserStub(env, actorId);
  await oldOwnerStub.updateOrgRole(orgId, 'admin');
}

export async function archiveOrg(env: AuthEnv, orgId: string, actorId: string): Promise<void> {
  const stub = getOrgStub(env, orgId);
  await stub.archiveOrg(actorId);
}

export async function listOrgWorkspaces(env: AuthEnv, orgId: string): Promise<Workspace[]> {
  const stub = getOrgStub(env, orgId);
  const workspaceIds = await stub.getWorkspaces();
  const results: Workspace[] = [];
  for (const ws of workspaceIds) {
    if (ws.archived) continue;
    const wsStub = getWorkspaceStub(env, ws.id);
    const info = await wsStub.getInfo();
    if (info && !info.archived) {
      results.push(wsInfoToWorkspace(info));
    }
  }
  return results;
}

export async function listUserWorkspaces(env: AuthEnv, userId: string, orgId: string): Promise<WorkspaceWithAccess[]> {
  const isMember = await isOrgMember(env, userId, orgId);
  if (!isMember) return [];

  const workspaces = await listOrgWorkspaces(env, orgId);
  const results: WorkspaceWithAccess[] = [];
  for (const workspace of workspaces) {
    const wsStub = getWorkspaceStub(env, workspace.id);
    const memberAccess = await wsStub.getMemberAccess(userId);
    const accessLevel = memberAccess?.access_level ?? 'full';
    if (accessLevel !== 'none') {
      results.push({ ...workspace, access_level: accessLevel });
    }
  }
  return results;
}

export async function listUserWorkspacesAcrossOrgs(
  env: AuthEnv,
  userId: string,
  orgs?: OrgMembership[]
): Promise<WorkspaceWithAccess[]> {
  const memberships = orgs ?? (await getUserOrgs(env, userId));
  if (memberships.length === 0) return [];

  const workspaces = await Promise.all(
    memberships.map((membership) => listUserWorkspaces(env, userId, membership.org_id))
  );
  return workspaces.flat();
}

export async function getWorkspace(env: AuthEnv, workspaceId: string): Promise<Workspace | null> {
  const stub = getWorkspaceStub(env, workspaceId);
  const info = await stub.getInfo();
  if (!info || info.archived) return null;
  return wsInfoToWorkspace(info);
}

export async function createWorkspace(
  env: AuthEnv,
  orgId: string,
  name: string,
  createdBy: string,
  description?: string | null
): Promise<Workspace> {
  const workspaceId = crypto.randomUUID();
  const stub = getWorkspaceStub(env, workspaceId);
  const info = await stub.createWorkspace(workspaceId, orgId, name, createdBy, description ?? null);
  return wsInfoToWorkspace(info);
}

export async function updateWorkspace(
  env: AuthEnv,
  workspaceId: string,
  updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } },
  actorId: string
): Promise<Workspace | null> {
  const stub = getWorkspaceStub(env, workspaceId);
  const info = await stub.updateWorkspace({
    name: updates.name,
    description: updates.description,
    avatar_color: updates.avatar?.color,
    avatar_content: updates.avatar?.content,
  }, actorId);
  if (!info) return null;
  return wsInfoToWorkspace(info);
}

export async function archiveWorkspace(env: AuthEnv, workspaceId: string, actorId: string): Promise<Workspace | null> {
  const stub = getWorkspaceStub(env, workspaceId);
  const info = await stub.archive(actorId);
  if (!info) return null;
  return wsInfoToWorkspace(info);
}

export async function getWorkspaceAccess(env: AuthEnv, workspaceId: string, userId: string): Promise<WorkspaceAccessLevel> {
  const wsStub = getWorkspaceStub(env, workspaceId);
  const info = await wsStub.getInfo();
  if (!info || info.archived) return 'none';

  const isMember = await isOrgMember(env, userId, info.org_id);
  if (!isMember) return 'none';

  const access = await wsStub.getMemberAccess(userId);
  return access?.access_level ?? 'full';
}

/**
 * Warm up a workspace container asynchronously.
 * Note: This simplified version doesn't background the warmup.
 * For full background warmup support, use the worker-level implementation.
 */
export async function warmupWorkspace(
  env: AuthEnv,
  workspaceId: string,
  userId: string
): Promise<{ status: 'warm' | 'warming' | 'unauthorized' }> {
  // Check access first (cheap - just KV/DO lookups)
  const accessLevel = await getWorkspaceAccess(env, workspaceId, userId);
  if (accessLevel === 'none') {
    return { status: 'unauthorized' };
  }

  const wsStub = getWorkspaceStub(env, workspaceId);
  const info = await wsStub.getInfo();
  if (!info) {
    return { status: 'unauthorized' };
  }

  // Return warming status - actual warmup happens when the container is accessed
  // Full background warmup requires ExecutionContext.waitUntil which isn't available here
  return { status: 'warming' };
}

export async function setWorkspaceAccess(
  env: AuthEnv,
  workspaceId: string,
  userId: string,
  accessLevel: WorkspaceAccessLevel,
  actorId: string
): Promise<void> {
  const stub = getWorkspaceStub(env, workspaceId);
  await stub.setMemberAccess(userId, accessLevel, actorId);
}

export async function listWorkspaceMembers(env: AuthEnv, workspaceId: string): Promise<WorkspaceMember[]> {
  const stub = getWorkspaceStub(env, workspaceId);
  return stub.listMembers();
}

export async function checkUserOrphaned(env: AuthEnv, userId: string): Promise<boolean> {
  const userStub = getUserStub(env, userId);
  const profile = await userStub.getProfile();
  if (!profile) return false;

  const orgs = await userStub.getOrgs();
  const hasMemberships = orgs.length > 0;
  if (!hasMemberships && !profile.is_orphaned) {
    await userStub.setOrphaned(true);
    return true;
  }
  if (hasMemberships && profile.is_orphaned) {
    await userStub.setOrphaned(false);
    return false;
  }
  return profile.is_orphaned;
}

export async function handleOrphanedUserLogin(
  env: AuthEnv,
  userId: string
): Promise<{ org: Organization; workspace: WorkspaceWithAccess } | null> {
  const userStub = getUserStub(env, userId);
  const profile = await userStub.getProfile();
  if (!profile?.is_orphaned) return null;

  const baseName = profile.name?.trim() || 'My';
  const orgName = `${baseName}'s Organization`;
  const org = await createOrg(env, orgName, userId);

  const workspaces = await listUserWorkspaces(env, userId, org.id);
  const workspace = workspaces[0];
  if (!workspace) {
    throw new Error('Failed to create default workspace');
  }

  await userStub.setOrphaned(false);

  return { org, workspace };
}

export async function getOrgAuditLog(
  env: AuthEnv,
  orgId: string,
  limit = 100,
  offset = 0
): Promise<AuditLogEntry[]> {
  const stub = getOrgStub(env, orgId);
  const entries = await stub.getAuditLog(limit, offset);
  return entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    actor_id: entry.actor_id,
    target_id: entry.target_id,
    details: entry.details ? JSON.parse(entry.details) : null,
    created_at: entry.created_at,
  }));
}

export async function getWorkspaceAuditLog(
  env: AuthEnv,
  workspaceId: string,
  limit = 100,
  offset = 0
): Promise<AuditLogEntry[]> {
  const stub = getWorkspaceStub(env, workspaceId);
  const entries = await stub.getAuditLog(limit, offset);
  return entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    actor_id: entry.actor_id,
    target_id: entry.target_id,
    details: entry.details ? JSON.parse(entry.details) : null,
    created_at: entry.created_at,
  }));
}

// Invitation functions
export async function createInvitation(
  env: AuthEnv,
  orgId: string,
  email: string,
  role: OrgRole,
  invitedBy: string
): Promise<{ id: string; expires_at: number }> {
  if (role === 'owner') {
    throw new Error('Cannot invite as owner');
  }
  const stub = getOrgStub(env, orgId);
  const invitation = await stub.createInvitation(email, role, invitedBy);
  return { id: invitation.id, expires_at: invitation.expires_at };
}

export async function getInvitation(env: AuthEnv, orgId: string, invitationId: string): Promise<{
  id: string;
  email: string;
  role: OrgRole;
  org: Organization;
} | null> {
  const orgStub = getOrgStub(env, orgId);
  const invitation = await orgStub.getInvitation(invitationId);
  if (!invitation) return null;

  const orgInfo = await orgStub.getInfo();
  if (!orgInfo) return null;

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    org: orgInfoToOrg(orgInfo),
  };
}

export async function acceptInvitation(env: AuthEnv, orgId: string, invitationId: string, userId: string): Promise<boolean> {
  const orgStub = getOrgStub(env, orgId);
  const invitation = await orgStub.getInvitation(invitationId);
  if (!invitation) return false;

  const accepted = await orgStub.acceptInvitation(invitationId, userId);
  if (!accepted) return false;

  const workspaces = await listOrgWorkspaces(env, orgId);
  const lastWorkspaceId = workspaces[0]?.id ?? null;
  const userStub = getUserStub(env, userId);
  await userStub.addOrg(orgId, invitation.role, lastWorkspaceId);
  await userStub.setOrphaned(false);

  return true;
}

export async function getOrgInvitations(env: AuthEnv, orgId: string): Promise<Array<{
  id: string;
  email: string;
  role: OrgRole;
  created_at: number;
  expires_at: number;
}>> {
  const stub = getOrgStub(env, orgId);
  const invitations = await stub.getInvitations();
  const now = Date.now();
  return invitations.filter((inv) => inv.expires_at > now).map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    created_at: inv.created_at,
    expires_at: inv.expires_at,
  }));
}

export async function deleteInvitation(env: AuthEnv, orgId: string, invitationId: string): Promise<void> {
  const stub = getOrgStub(env, orgId);
  await stub.deleteInvitation(invitationId);
}

export async function resetWorkspaceContainer(
  _env: AuthEnv,
  _workspaceId: string
): Promise<{ success: boolean; containerId: string }> {
  throw new Error('resetWorkspaceContainer not yet implemented - requires container bindings');
}

export async function restartOrgContainers(
  _env: AuthEnv,
  _orgId: string
): Promise<{ restarted: number; failed: number }> {
  throw new Error('restartOrgContainers not yet implemented - requires container bindings');
}

// API Token functions
export async function createOrgApiToken(
  env: AuthEnv,
  orgId: string,
  userId: string,
  input: CreateApiTokenInput
): Promise<{ tokenId: string; tokenData: ApiTokenData }> {
  const scopes = input.scopes || ['proxy'];
  const expiresAt = input.expires_in_days
    ? Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000
    : null;

  return createApiToken(env.API_TOKENS, {
    orgId,
    userId,
    name: input.name,
    scopes,
    integrationId: input.integration_id || null,
    expiresAt,
  });
}

export async function validateApiToken(env: AuthEnv, tokenId: string): Promise<ApiTokenData | null> {
  return validateApiTokenKV(env.API_TOKENS, tokenId);
}

export async function deleteOrgApiToken(env: AuthEnv, tokenId: string): Promise<void> {
  await deleteApiTokenKV(env.API_TOKENS, tokenId);
}

// Worker script functions
export interface WorkerScriptAccess {
  script_name: string;
  workspace_id: string;
  org_id: string;
  is_public: boolean;
}

export async function getWorkerAccessInfo(env: AuthEnv, scriptName: string): Promise<WorkerScriptAccess | null> {
  // Look up from denormalized global index (single KV read, no DO query)
  const data = await env.API_TOKENS.get(`script_org:${scriptName}`);
  if (!data) return null;

  const { org_id, is_public } = JSON.parse(data) as { org_id: string; is_public: boolean };
  return {
    script_name: scriptName,
    workspace_id: '', // Not needed for access check, avoids DO lookup
    org_id,
    is_public,
  };
}

export interface WorkerScript {
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: AppPreviewStatus | null;
  preview_error: string | null;
}

export async function listWorkerScripts(env: AuthEnv, orgId: string): Promise<WorkerScript[]> {
  const stub = getOrgStub(env, orgId);
  return stub.listWorkerScripts();
}

export async function listWorkerScriptsByWorkspace(env: AuthEnv, workspaceId: string): Promise<WorkerScript[]> {
  const wsStub = getWorkspaceStub(env, workspaceId);
  const info = await wsStub.getInfo();
  if (!info) return [];
  const orgStub = getOrgStub(env, info.org_id);
  return orgStub.listWorkerScriptsByWorkspace(workspaceId);
}

export async function getWorkerScript(
  env: AuthEnv,
  orgId: string,
  scriptName: string
): Promise<WorkerScript | null> {
  const stub = getOrgStub(env, orgId);
  return stub.getWorkerScript(scriptName);
}

export async function deleteWorkerScript(
  env: AuthEnv,
  orgId: string,
  scriptName: string,
  actorId: string
): Promise<boolean> {
  const stub = getOrgStub(env, orgId);
  const result = await stub.deleteWorkerScript(scriptName, actorId);
  if (result) {
    // Remove from global script→org index
    await env.API_TOKENS.delete(`script_org:${scriptName}`);
  }
  return result;
}

export async function setWorkerScriptPublic(
  env: AuthEnv,
  orgId: string,
  scriptName: string,
  isPublic: boolean,
  actorId: string
): Promise<WorkerScript | null> {
  const stub = getOrgStub(env, orgId);
  const script = await stub.setWorkerScriptPublic(scriptName, isPublic, actorId);
  if (script) {
    // Update the denormalized KV index
    await env.API_TOKENS.put(
      `script_org:${scriptName}`,
      JSON.stringify({ org_id: orgId, is_public: script.is_public })
    );
  }
  return script;
}

export async function adminSetAppPublic(
  env: AuthEnv,
  orgId: string,
  scriptName: string,
  isPublic: boolean,
  actorId: string
): Promise<WorkerScript | null> {
  return setWorkerScriptPublic(env, orgId, scriptName, isPublic, actorId);
}

export async function adminDeleteApp(
  env: AuthEnv,
  orgId: string,
  scriptName: string,
  actorId: string
): Promise<boolean> {
  return deleteWorkerScript(env, orgId, scriptName, actorId);
}

// Worker cross-domain auth functions
export interface WorkerAuthState {
  return_url: string;
  script_name: string;
  required_org_id: string;
  created_at: number;
}

export interface WorkerAuthToken {
  user_id: string;
  org_id: string;
  state: string;
  script_name: string;
  created_at: number;
}

export interface DispatcherSession {
  user_id: string;
  org_id: string;
  created_at: number;
  last_accessed: number;
}

export async function validateAndConsumeWorkerAuthState(env: AuthEnv, state: string): Promise<WorkerAuthState | null> {
  return validateAndConsumeAuthState(env.API_TOKENS, state);
}

export async function createWorkerAuthTokenFn(
  env: AuthEnv,
  userId: string,
  orgId: string,
  state: string,
  scriptName: string
): Promise<string> {
  return createWorkerAuthToken(env.API_TOKENS, {
    user_id: userId,
    org_id: orgId,
    state,
    script_name: scriptName,
  });
}
