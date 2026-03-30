import type {
  User,
  Organization,
  OrgMembership,
  OrgRole,
  Workspace,
  WorkspaceWithAccess,
  WorkspaceAccessLevel,
  AuditLogEntry,
  AppPreviewStatus,
  Integration,
} from '@/types';
import { validateApiToken as validateApiTokenKV } from '../../workers/main/src/api-tokens';
import {
  createSignedSession,
  type SignedSessionData,
} from '../../workers/main/src/signed-session';
import { assertEmailDomainAllowed, getBlocklistFromKV } from './email-domain-blocklist';

import {
  type AuthEnv,
  type OrgThread,
  type SessionData,
  type ApiTokenData,
} from './auth-helpers';
import type { UserOrg, CustomDomain, CustomDomainStatus } from '../../workers/main/src/auth';

interface GetUserOrgsOptions {
  preloadedOrgInfoById?: Map<string, Promise<Organization | null> | Organization | null>;
  preloadedUserOrgs?: UserOrg[];
}

function isMissingRpcMethodError(error: unknown, methodName: string): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes(`does not implement "${methodName}"`)
  );
}

/**
 * Reset onboarding for a user, with a compatibility fallback for workers that
 * haven't reloaded the newer `resetOnboarding` RPC method yet.
 */
export async function resetOnboardingForUser(
  env: AuthEnv,
  userId: string
): Promise<void> {
  const stub = env.USER.get(env.USER.idFromName(userId));

  try {
    await stub.resetOnboarding();
    return;
  } catch (error) {
    if (!isMissingRpcMethodError(error, 'resetOnboarding')) {
      throw error;
    }
  }

  await stub.updateOnboarding({ completed_at: null });
}

// Session functions — signed cookies replace KV storage

/**
 * Create a new signed session token. Returns the HMAC-signed token string
 * that should be set as the session cookie value.
 */
export async function createSession(
  env: AuthEnv,
  userId: string,
  orgId: string,
  workspaceId: string | null = null,
  userInfo?: { name?: string | null; email?: string | null }
): Promise<{ signedToken: string; sessionData: SessionData }> {
  const now = Date.now();
  const sessionData: SessionData = {
    user_id: userId,
    org_id: orgId,
    workspace_id: workspaceId,
    created_at: now,
    last_accessed: now,
    user_name: userInfo?.name ?? null,
    user_email: userInfo?.email ?? null,
  };
  const signedSession: SignedSessionData = {
    user_id: userId,
    org_id: orgId,
    workspace_id: workspaceId,
    created_at: now,
    user_name: userInfo?.name ?? null,
    user_email: userInfo?.email ?? null,
  };
  const signedToken = await createSignedSession(env.TOKEN_SIGNING_SECRET, signedSession);
  return { signedToken, sessionData };
}

/**
 * Re-sign a session with updated org/workspace. Returns new signed token.
 */
export async function switchSessionOrg(
  env: AuthEnv,
  currentSession: SessionData,
  orgId: string,
  workspaceId: string | null = null
): Promise<string> {
  const signedSession: SignedSessionData = {
    user_id: currentSession.user_id,
    org_id: orgId,
    workspace_id: workspaceId,
    created_at: Date.now(),
    user_name: currentSession.user_name,
    user_email: currentSession.user_email,
  };
  const signedToken = await createSignedSession(env.TOKEN_SIGNING_SECRET, signedSession);
  // Update user's last workspace for this org
  if (workspaceId) {
    const stub = env.USER.get(env.USER.idFromName(currentSession.user_id));
    await stub.setOrgLastWorkspace(orgId, workspaceId);
  }
  return signedToken;
}

/**
 * Re-sign a session with updated workspace. Returns new signed token.
 */
export async function switchSessionWorkspace(
  env: AuthEnv,
  currentSession: SessionData,
  workspaceId: string | null
): Promise<string> {
  const signedSession: SignedSessionData = {
    user_id: currentSession.user_id,
    org_id: currentSession.org_id,
    workspace_id: workspaceId,
    created_at: Date.now(),
    user_name: currentSession.user_name,
    user_email: currentSession.user_email,
  };
  const signedToken = await createSignedSession(env.TOKEN_SIGNING_SECRET, signedSession);
  // Update user's last workspace for this org
  if (workspaceId && currentSession.org_id) {
    const stub = env.USER.get(env.USER.idFromName(currentSession.user_id));
    await stub.setOrgLastWorkspace(currentSession.org_id, workspaceId);
  }
  return signedToken;
}

// User functions
export async function getUserByEmail(env: AuthEnv, email: string): Promise<{ userId: string; user: User } | null> {
  const normalizedEmail = email.toLowerCase();
  const userId = await env.EMAIL_TO_USER.get(`email:${normalizedEmail}`);
  if (!userId) return null;
  const stub = env.USER.get(env.USER.idFromName(userId));
  const user = await stub.getProfile();
  if (!user) return null;
  return { userId, user };
}

export async function getUsersByIds(env: AuthEnv, userIds: string[]): Promise<(User & Disposable)[]> {
  const results = await Promise.all(
    userIds.map(async (userId) => {
      const stub = env.USER.get(env.USER.idFromName(userId));
      return stub.getProfile();
    })
  );
  return results.filter((p): p is User & Disposable => p !== null);
}

export async function updateUser(
  env: AuthEnv,
  userId: string,
  updates: { name?: string | null; avatar?: { color: string; content: string } }
): Promise<User | null> {
  const stub = env.USER.get(env.USER.idFromName(userId));
  const profile = await stub.updateProfile({
    name: updates.name,
    avatar: updates.avatar,
  });
  if (!profile) return null;
  return profile;
}

export async function createUser(
  env: AuthEnv,
  email: string,
  password: string,
  name: string | null,
  signupIp: string | null = null
): Promise<{ userId: string; user: User }> {
  const blocklist = await getBlocklistFromKV(env.APP_KV);
  assertEmailDomainAllowed(email, blocklist);

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
    const stub = env.USER.get(env.USER.idFromName(userId));
    const user = await stub.createUser(userId, normalizedEmail, password, name, signupIp);
    return { userId, user };
  } catch (error) {
    // Clean up on failure
    await env.EMAIL_TO_USER.delete(emailKvKey);
    throw error;
  }
}

export async function isSignupIpBlocked(
  env: AuthEnv,
  ip: string | null | undefined
): Promise<boolean> {
  const normalizedIp = ip?.trim();
  if (!normalizedIp || !env.ADMIN_INDEX) {
    return false;
  }

  const adminIndex = env.ADMIN_INDEX.get(env.ADMIN_INDEX.idFromName('admin_index'));
  return adminIndex.isSignupIpBlocked(normalizedIp);
}

export async function blockSignupIp(
  env: AuthEnv,
  ip: string,
  blockedBy: string | null = null,
  reason: string | null = null
): Promise<void> {
  if (!env.ADMIN_INDEX) {
    throw new Error('ADMIN_INDEX binding is not configured');
  }

  const adminIndex = env.ADMIN_INDEX.get(env.ADMIN_INDEX.idFromName('admin_index'));
  await adminIndex.blockSignupIp(ip, blockedBy, reason);
}

export async function unblockSignupIp(env: AuthEnv, ip: string): Promise<void> {
  if (!env.ADMIN_INDEX) {
    throw new Error('ADMIN_INDEX binding is not configured');
  }

  const adminIndex = env.ADMIN_INDEX.get(env.ADMIN_INDEX.idFromName('admin_index'));
  await adminIndex.unblockSignupIp(ip);
}

// OAuth functions
export async function createUserFromOAuth(
  env: AuthEnv,
  email: string,
  name: string | null,
  provider: 'google' | 'github',
  providerId: string
): Promise<{ userId: string; user: User }> {
  const blocklist = await getBlocklistFromKV(env.APP_KV);
  assertEmailDomainAllowed(email, blocklist);

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
    const stub = env.USER.get(env.USER.idFromName(userId));
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
  const stub = env.USER.get(env.USER.idFromName(userId));
  await stub.linkOAuthProvider(provider, providerId);
}

export async function getUserOrgs(
  env: AuthEnv,
  userId: string,
  options?: GetUserOrgsOptions
): Promise<OrgMembership[]> {
  const userOrgs =
    options?.preloadedUserOrgs ??
    (await env.USER.get(env.USER.idFromName(userId)).getOrgs());
  const preloadedOrgInfoById = options?.preloadedOrgInfoById;

  // Fetch all org info in parallel instead of sequential loop
  const orgInfos = await Promise.all(
    userOrgs.map(async (uo) => {
      const preloadedOrgInfo = preloadedOrgInfoById?.get(uo.org_id);
      const orgInfo = preloadedOrgInfo
        ? await preloadedOrgInfo
        : await env.ORG.get(env.ORG.idFromName(uo.org_id)).getInfo();
      return { uo, orgInfo };
    })
  );

  return orgInfos
    .filter(({ orgInfo }) => orgInfo && !orgInfo.archived)
    .map(({ uo, orgInfo }) => ({
      org_id: uo.org_id,
      org_name: orgInfo!.name,
      role: uo.role,
      joined_at: uo.joined_at,
      last_workspace_id: uo.last_workspace_id ?? null,
    }));
}

// Admin functions that operate on single DOs (real implementations)
export async function adminUpdateUser(
  env: AuthEnv,
  userId: string,
  updates: { name?: string | null; avatar?: { color: string; content: string }; is_superuser?: boolean }
): Promise<User | null> {
  const stub = env.USER.get(env.USER.idFromName(userId));
  const profile = await stub.updateProfile({
    name: updates.name,
    avatar: updates.avatar,
    is_superuser: updates.is_superuser,
  });
  if (!profile) return null;
  return profile;
}



export async function adminTransferOrgOwnership(
  env: AuthEnv,
  orgId: string,
  newOwnerId: string,
  actorId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const members = await orgStub.getMembers();
  const currentOwner = members.find((member) => member.role === 'owner');
  if (!currentOwner) {
    throw new Error('Organization has no owner');
  }
  if (newOwnerId === currentOwner.user_id) {
    return;
  }

  await orgStub.adminTransferOwnership(actorId, newOwnerId);

  const newOwnerStub = env.USER.get(env.USER.idFromName(newOwnerId));
  await newOwnerStub.updateOrgRole(orgId, 'owner');

  const oldOwnerStub = env.USER.get(env.USER.idFromName(currentOwner.user_id));
  await oldOwnerStub.updateOrgRole(orgId, 'admin');
}

export async function adminAddOrgMember(
  env: AuthEnv,
  orgId: string,
  userId: string,
  role: 'admin' | 'member',
  actorId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.addMember(userId, role, actorId);
  const workspaces = await listOrgWorkspaces(env, orgId);
  const lastWorkspaceId = workspaces[0]?.id ?? null;
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.addOrg(orgId, role, lastWorkspaceId);
  await userStub.setOrphaned(false);
}

export async function adminForceOrphanUser(env: AuthEnv, userId: string, _actorId: string): Promise<void> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const orgs = await userStub.getOrgs();
  // Remove from all orgs
  for (const org of orgs) {
    const orgStub = env.ORG.get(env.ORG.idFromName(org.org_id));
    await orgStub.removeMember(userId, userId);
    await userStub.removeOrg(org.org_id);
  }
  await userStub.setOrphaned(true);
}


// Organization functions
export async function getOrg(env: AuthEnv, orgId: string): Promise<Organization | null> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await stub.getInfo();
  if (!info) return null;
  return info;
}


export async function archiveOrg(env: AuthEnv, orgId: string, actorId: string): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  // Archive all workspaces first (before marking org archived, so partial
  // failures don't leave an archived org with unarchived workspaces)
  const workspaces = await orgStub.getWorkspaces(true);
  await Promise.all(
    workspaces.filter((ws) => !ws.archived).map(async (ws) => {
      const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
      await wsStub.archive(actorId);
    })
  );

  // Remove non-owner members from OrgDO (owner stays for audit trail).
  // Remove org from ALL users' UserDO (including owner) so they can't access it.
  const members = await orgStub.getMembers();
  await Promise.all(
    members.map(async (member) => {
      if (member.role !== 'owner') {
        await orgStub.removeMember(member.user_id, actorId);
      }
      const userStub = env.USER.get(env.USER.idFromName(member.user_id));
      await userStub.removeOrg(orgId);
      await checkUserOrphaned(env, member.user_id);
    })
  );

  // Mark the org as archived last, after all cleanup is done
  await orgStub.archiveOrg(actorId);
}

export async function createOrg(env: AuthEnv, name: string, createdBy: string): Promise<{ org: Organization; defaultWorkspaceId: string }> {
  const orgId = crypto.randomUUID();
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  // createOrg now creates the default workspace internally
  const { org: info, defaultWorkspaceId } = await orgStub.createOrg(orgId, name, createdBy);

  // Add to user's orgs with the default workspace
  const userStub = env.USER.get(env.USER.idFromName(createdBy));
  await userStub.addOrg(orgId, 'owner', defaultWorkspaceId);

  return { org: info, defaultWorkspaceId };
}


export async function getOrgMembers(env: AuthEnv, orgId: string): Promise<Array<{ user: User; role: OrgRole; joined_at: number }>> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const members = await stub.getMembers();

  // Fetch all user profiles in parallel instead of sequential loop
  const profileResults = await Promise.all(
    members.map(async (member) => {
      const userStub = env.USER.get(env.USER.idFromName(member.user_id));
      const profile = await userStub.getProfile();
      return { member, profile };
    })
  );

  return profileResults
    .filter(({ profile }) => profile !== null)
    .map(({ member, profile }) => ({
      user: profile!,
      role: member.role,
      joined_at: member.joined_at,
    }));
}

export async function getOrgMembersWithWorkspaceAccess(
  env: AuthEnv,
  orgId: string
): Promise<Array<{ user: User; role: OrgRole; joined_at: number; workspaceAccess: Record<string, WorkspaceAccessLevel> }>> {
  const [members, workspaces] = await Promise.all([
    getOrgMembers(env, orgId),
    listOrgWorkspaces(env, orgId),
  ]);

  const workspaceMembers = await Promise.all(
    workspaces.map(async (ws) => {
      const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
      const allMembers = await wsStub.listMembers();
      const accessMap = new Map(allMembers.map((m) => [m.user_id, m.access_level]));
      return { workspaceId: ws.id, accessMap };
    })
  );

  return members.map((member) => {
    const workspaceAccess: Record<string, WorkspaceAccessLevel> = {};
    for (const ws of workspaceMembers) {
      workspaceAccess[ws.workspaceId] = ws.accessMap.get(member.user.id) ?? 'full';
    }
    return {
      ...member,
      workspaceAccess,
    };
  });
}

export async function isOrgMember(env: AuthEnv, userId: string, orgId: string): Promise<boolean> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await stub.getInfo();
  if (!info || info.archived) return false;
  return stub.isMember(userId);
}

export async function isOrgAdmin(env: AuthEnv, userId: string, orgId: string): Promise<boolean> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await stub.getInfo();
  if (!info || info.archived) return false;
  const member = await stub.getMember(userId);
  return member?.role === 'owner' || member?.role === 'admin';
}

export async function removeOrgMember(env: AuthEnv, orgId: string, userId: string, actorId: string): Promise<void> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));

  // Remove from all workspaces in the org
  const workspaces = await stub.getWorkspaces();
  await Promise.all(
    workspaces.filter((ws) => !ws.archived).map(async (ws) => {
      const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
      await wsStub.removeMember(userId, actorId);
    })
  );

  await stub.removeMember(userId, actorId);

  // Remove from user's org list
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.removeOrg(orgId);

  // Proactively check if user is now orphaned
  await checkUserOrphaned(env, userId);
}

export async function updateOrgMemberRole(env: AuthEnv, orgId: string, userId: string, role: OrgRole, actorId: string): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.updateMemberRole(userId, role, actorId);

  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.updateOrgRole(orgId, role);
}

export async function transferOrgOwnership(env: AuthEnv, orgId: string, newOwnerId: string, actorId: string): Promise<void> {
  if (newOwnerId === actorId) {
    throw new Error('Cannot transfer ownership to yourself');
  }
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  await stub.transferOwnership(actorId, newOwnerId);
  // Update user roles
  const newOwnerStub = env.USER.get(env.USER.idFromName(newOwnerId));
  await newOwnerStub.updateOrgRole(orgId, 'owner');
  const oldOwnerStub = env.USER.get(env.USER.idFromName(actorId));
  await oldOwnerStub.updateOrgRole(orgId, 'admin');
}


export async function listOrgWorkspaces(env: AuthEnv, orgId: string, includeArchived = false): Promise<Workspace[]> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const workspaceIds = await stub.getWorkspaces(includeArchived);

  const infos = await Promise.all(
    workspaceIds.map(async (ws) => {
      const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
      return wsStub.getInfo();
    })
  );

  if (includeArchived) {
    return infos.filter((info) => info !== null) as Workspace[];
  }
  return infos.filter((info) => info !== null && !info.archived) as Workspace[];
}

export async function listUserWorkspaces(env: AuthEnv, userId: string, orgId: string): Promise<WorkspaceWithAccess[]> {
  const isMember = await isOrgMember(env, userId, orgId);
  if (!isMember) return [];

  const workspaces = await listOrgWorkspaces(env, orgId);

  // Assume 'full' access for all workspaces. The default is 'full' (no record = full access),
  // and explicit 'none' restrictions are rare. Actual access is verified lazily by
  // requireWorkspaceAccess() when the user tries to access a specific workspace.
  //
  // NOTE: This optimization assumes binary access ('full' or 'none'). If we add granular
  // access levels (e.g., 'viewer', 'editor'), we should store access info in OrgDO for
  // batch loading, or add a listUserWorkspaceAccess() method to avoid N RPC calls.
  return workspaces.map((workspace) => ({ ...workspace, access_level: 'full' as const }));
}

/**
 * List org workspaces skipping membership check — caller must have already
 * validated that the user belongs to the org (e.g. via getUserOrgs).
 */
async function listOrgWorkspacesForMember(env: AuthEnv, orgId: string): Promise<WorkspaceWithAccess[]> {
  const workspaces = await listOrgWorkspaces(env, orgId);
  return workspaces.map((workspace) => ({ ...workspace, access_level: 'full' as const }));
}

export async function listUserWorkspacesAcrossOrgs(
  env: AuthEnv,
  userId: string,
  orgs?: OrgMembership[]
): Promise<WorkspaceWithAccess[]> {
  const memberships = orgs ?? (await getUserOrgs(env, userId));
  if (memberships.length === 0) return [];

  // When orgs are pre-validated (passed in), skip redundant isOrgMember checks
  const workspaces = await Promise.all(
    orgs
      ? memberships.map((membership) => listOrgWorkspacesForMember(env, membership.org_id))
      : memberships.map((membership) => listUserWorkspaces(env, userId, membership.org_id))
  );
  return workspaces.flat();
}

export async function getWorkspace(env: AuthEnv, workspaceId: string): Promise<Workspace | null> {
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await stub.getInfo();
  if (!info || info.archived) return null;
  return info;
}

export async function createWorkspace(
  env: AuthEnv,
  orgId: string,
  name: string,
  createdBy: string,
  description?: string | null
): Promise<Workspace> {
  const workspaceId = crypto.randomUUID();
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  // WorkspaceDO.createWorkspace registers with OrgDO internally (addWorkspace)
  const info = await stub.createWorkspace(workspaceId, orgId, name, createdBy, description ?? null);

  // Grant full access to all existing org members
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const members = await orgStub.getMembers();
  await Promise.all(
    members.map(async (member) => {
      await stub.setMemberAccess(member.user_id, 'full', createdBy);
    })
  );

  return info;
}

export async function archiveWorkspace(
  env: AuthEnv,
  workspaceId: string,
  actorId: string
): Promise<void> {
  const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await wsStub.getInfo();
  if (!info) return;

  // Archive in WorkspaceDO
  await wsStub.archive(actorId);

  // Update org's workspace list
  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  await orgStub.archiveWorkspace(workspaceId);

  // Clear last_workspace_id for users who had this as their active workspace
  const members = await orgStub.getMembers();
  await Promise.all(
    members.map(async (member) => {
      const userStub = env.USER.get(env.USER.idFromName(member.user_id));
      const orgs = await userStub.getOrgs();
      const orgEntry = orgs.find((o) => o.org_id === info.org_id);
      if (orgEntry?.last_workspace_id === workspaceId) {
        // Reassign to the first active workspace where access is not explicitly blocked.
        const workspaceRows = await orgStub.getWorkspaces();
        let newWorkspaceId: string | null = null;
        for (const workspace of workspaceRows) {
          const candidateStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace.id));
          const memberAccess = await candidateStub.getMemberAccess(member.user_id);
          if ((memberAccess?.access_level ?? 'full') !== 'none') {
            newWorkspaceId = workspace.id;
            break;
          }
        }
        await userStub.setOrgLastWorkspace(info.org_id, newWorkspaceId);
      }
    })
  );
}

export async function updateWorkspace(
  env: AuthEnv,
  workspaceId: string,
  updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } },
  actorId: string
): Promise<Workspace | null> {
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await stub.updateWorkspace({
    name: updates.name,
    description: updates.description,
    avatar: updates.avatar,
  }, actorId);
  if (!info) return null;
  return info;
}


export async function getWorkspaceAccess(env: AuthEnv, workspaceId: string, userId: string): Promise<WorkspaceAccessLevel> {
  const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await wsStub.getInfo();
  if (!info || info.archived) return 'none';

  const isMember = await isOrgMember(env, userId, info.org_id);
  if (!isMember) return 'none';

  const access = await wsStub.getMemberAccess(userId);
  return access?.access_level ?? 'full';
}

export async function setWorkspaceAccess(
  env: AuthEnv,
  workspaceId: string,
  userId: string,
  accessLevel: WorkspaceAccessLevel,
  actorId: string
): Promise<void> {
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  await stub.setMemberAccess(userId, accessLevel, actorId);
}

export async function listWorkspaceIntegrations(env: AuthEnv, workspaceId: string): Promise<Integration[]> {
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const records = await stub.getIntegrations();
  return records.map((r) => ({
    id: r.id,
    integration_type: r.integration_type,
    name: r.name,
    category: r.category as Integration['category'],
    auth_method: r.auth_method as Integration['auth_method'],
    config: r.config ? JSON.parse(r.config) : {},
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    has_credentials: !!r.credentials_encrypted,
  }));
}

export async function checkUserOrphaned(env: AuthEnv, userId: string): Promise<boolean> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
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
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const profile = await userStub.getProfile();
  if (!profile?.is_orphaned) return null;

  const baseName = profile.name?.trim() || 'My';
  const orgName = `${baseName}'s Organization`;
  const { org, defaultWorkspaceId } = await createOrg(env, orgName, userId);

  // Get the default workspace info
  const workspace = await getWorkspace(env, defaultWorkspaceId);
  if (!workspace) {
    throw new Error('Failed to create default workspace');
  }

  await userStub.setOrphaned(false);

  return { org, workspace: { ...workspace, access_level: 'full' } };
}

export async function getOrgAuditLog(
  env: AuthEnv,
  orgId: string,
  limit = 100,
  offset = 0
): Promise<AuditLogEntry[]> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
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
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
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
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await stub.createInvitation(email, role, invitedBy);
  return { id: invitation.id, expires_at: invitation.expires_at };
}

export async function getInvitation(env: AuthEnv, orgId: string, invitationId: string): Promise<{
  id: string;
  email: string;
  role: OrgRole;
  org: Organization;
} | null> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await orgStub.getInvitation(invitationId);
  if (!invitation) return null;

  const orgInfo = await orgStub.getInfo();
  if (!orgInfo || orgInfo.archived) return null;

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    org: orgInfo,
  };
}

export async function acceptInvitation(env: AuthEnv, orgId: string, invitationId: string, userId: string): Promise<boolean> {
  // Validate invitation exists and org is not archived
  const validatedInvitation = await getInvitation(env, orgId, invitationId);
  if (!validatedInvitation) return false;

  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const acceptedInvitation = await orgStub.acceptInvitation(invitationId, userId);
  if (!acceptedInvitation) return false;

  const workspaces = await listOrgWorkspaces(env, orgId);
  const lastWorkspaceId = workspaces[0]?.id ?? null;

  // Apply workspace access from invitation, or default to 'full' for all
  const presetAccess = acceptedInvitation.workspace_access;
  await Promise.all(
    workspaces.map(async (ws) => {
      const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
      const access = presetAccess?.[ws.id] ?? 'full';
      await wsStub.setMemberAccess(userId, access, userId);
    })
  );

  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.addOrg(orgId, acceptedInvitation.role, lastWorkspaceId);
  await userStub.setOrphaned(false);

  return true;
}

export async function getOrgInvitations(env: AuthEnv, orgId: string): Promise<Array<{
  id: string;
  email: string;
  role: OrgRole;
  invited_by: string;
  created_at: number;
  expires_at: number;
  workspace_access?: Record<string, 'full' | 'none'> | null;
}>> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitations = await stub.getInvitations();
  const now = Date.now();
  return invitations.filter((inv) => inv.expires_at > now).map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    invited_by: inv.invited_by,
    created_at: inv.created_at,
    expires_at: inv.expires_at,
    workspace_access: inv.workspace_access ?? null,
  }));
}

export async function updateInvitationWorkspaceAccess(
  env: AuthEnv,
  orgId: string,
  invitationId: string,
  workspaceId: string,
  access: 'full' | 'none'
): Promise<boolean> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await stub.getInvitation(invitationId);
  if (!invitation) return false;

  const current = invitation.workspace_access ?? {};
  if (access === 'full') {
    delete current[workspaceId];
  } else {
    current[workspaceId] = access;
  }

  // If all entries are removed, set to null (default = all access)
  const updated = Object.keys(current).length > 0 ? current : null;
  return stub.updateInvitationWorkspaceAccess(invitationId, updated);
}


// API Token functions
export async function validateApiToken(env: AuthEnv, tokenId: string): Promise<ApiTokenData | null> {
  return validateApiTokenKV(env.APP_KV, tokenId);
}

// Worker script functions
export interface WorkerScriptAccess {
  script_name: string;
  workspace_id: string;
  org_id: string;
  is_public: boolean;
}

// KV key prefixes
const SCRIPT_PREFIX = 'script:';
const SCRIPT_ORG_PREFIX_LEGACY = 'script_org:';
const CUSTOM_DOMAIN_ZONE_PREFIX = 'custom_domain_zone:';

/**
 * Get worker access info by dispatch script name.
 * Tries new format first, falls back to legacy.
 */
export async function getWorkerAccessInfo(
  env: AuthEnv,
  dispatchScriptName: string,
  legacyScriptName?: string
): Promise<WorkerScriptAccess | null> {
  // Try new format first: script:{script-name}--{org-slug}
  let data = await env.APP_KV.get(`${SCRIPT_PREFIX}${dispatchScriptName}`);
  if (data) {
    const { org_id, is_public } = JSON.parse(data) as { org_id: string; is_public: boolean };
    return {
      script_name: dispatchScriptName,
      workspace_id: '', // Not needed for access check, avoids DO lookup
      org_id,
      is_public,
    };
  }

  // Fall back to legacy format: script_org:{script-name}
  if (legacyScriptName) {
    data = await env.APP_KV.get(`${SCRIPT_ORG_PREFIX_LEGACY}${legacyScriptName}`);
    if (data) {
      const { org_id, is_public } = JSON.parse(data) as { org_id: string; is_public: boolean };
      return {
        script_name: legacyScriptName,
        workspace_id: '', // Not needed for access check, avoids DO lookup
        org_id,
        is_public,
      };
    }
  }

  return null;
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
  custom_domain_hostname: string | null;
  custom_domain_cf_hostname_id: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
  custom_domain_error: string | null;
  custom_domain_updated_at: number | null;
}

export async function listWorkerScriptsByWorkspace(env: AuthEnv, workspaceId: string): Promise<WorkerScript[]> {
  const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await wsStub.getInfo();
  if (!info) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  return orgStub.listWorkerScriptsByWorkspace(workspaceId);
}

export async function getWorkerScript(
  env: AuthEnv,
  orgId: string,
  scriptName: string
): Promise<WorkerScript | null> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return stub.getWorkerScript(scriptName);
}

export async function deleteWorkerScript(
  env: AuthEnv,
  orgId: string,
  scriptName: string,
  actorId: string
): Promise<boolean> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const result = await stub.deleteWorkerScript(scriptName, actorId);
  if (result) {
    // Get org slug to build dispatch script name
    const orgInfo = await stub.getInfo();
    const orgSlug = orgInfo?.slug;
    if (orgSlug) {
      const dispatchScriptName = `${scriptName}--${orgSlug}`;
      // Remove from new format KV index
      await env.APP_KV.delete(`${SCRIPT_PREFIX}${dispatchScriptName}`);
    }
    // Also remove legacy format for backwards compatibility
    await env.APP_KV.delete(`${SCRIPT_ORG_PREFIX_LEGACY}${scriptName}`);
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
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const script = await stub.setWorkerScriptPublic(scriptName, isPublic, actorId);
  if (script) {
    // Get org slug to build dispatch script name
    const orgInfo = await stub.getInfo();
    const orgSlug = orgInfo?.slug;
    if (orgSlug) {
      const dispatchScriptName = `${scriptName}--${orgSlug}`;
      // Update the new format KV index
      await env.APP_KV.put(
        `${SCRIPT_PREFIX}${dispatchScriptName}`,
        JSON.stringify({ org_id: orgId, org_slug: orgSlug, is_public: script.is_public })
      );
    }
    // Also update legacy format for backwards compatibility
    await env.APP_KV.put(
      `${SCRIPT_ORG_PREFIX_LEGACY}${scriptName}`,
      JSON.stringify({ org_id: orgId, is_public: script.is_public })
    );
  }
  return script;
}

// ── Custom Domains (org-scoped wildcard) ─────────────────────────────

export async function setOrgCustomDomain(
  env: AuthEnv,
  orgId: string,
  domain: string,
  actorId: string,
): Promise<CustomDomain> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));

  // Capture old domain for KV cleanup after successful commit
  const existing = await stub.getCustomDomain();
  const oldDomain = existing?.domain;

  const customDomain = await stub.setCustomDomain(domain, actorId);

  // Write new KV index, then clean up old one
  const orgInfo = await stub.getInfo();
  const orgSlug = orgInfo?.slug;
  if (orgSlug) {
    await env.APP_KV.put(
      `${CUSTOM_DOMAIN_ZONE_PREFIX}${domain}`,
      JSON.stringify({ org_id: orgId, org_slug: orgSlug })
    );
  }

  // Only delete old KV entry after new one is committed
  if (oldDomain && oldDomain !== domain) {
    await env.APP_KV.delete(`${CUSTOM_DOMAIN_ZONE_PREFIX}${oldDomain}`);
  }

  return customDomain;
}

export async function removeOrgCustomDomain(
  env: AuthEnv,
  orgId: string,
  actorId: string
): Promise<CustomDomain | null> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const removed = await stub.removeCustomDomain(actorId);
  if (removed) {
    await env.APP_KV.delete(`${CUSTOM_DOMAIN_ZONE_PREFIX}${removed.domain}`);
  }
  return removed;
}

export async function getOrgCustomDomain(
  env: AuthEnv,
  orgId: string
): Promise<CustomDomain | null> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return stub.getCustomDomain();
}
