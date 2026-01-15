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
  Integration,
  CreateIntegrationInput,
  UpdateIntegrationInput,
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
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { withDoRpc } from '@/lib/do-rpc';
import type { UserProfile } from '../../workers/main/src/auth';
import {
  type SessionData,
  getSession as getSessionKV,
  destroySession as destroySessionKV,
  createNewSession as createNewSessionKV,
} from '../../workers/main/src/session-kv';
import type { ApiTokenData } from '../../workers/main/src/api-tokens';
import type { DoRpcService } from '../../workers/main/src/rpc-service';

interface AuthEnv {
  DO_RPC: DoRpcService;
  SESSIONS: KVNamespace;
}

async function withRpc<T>(fn: (rpc: DoRpcService) => Promise<T>): Promise<T> {
  const { env } = getCloudflareContext() as unknown as { env: AuthEnv };
  return withDoRpc(env.DO_RPC, fn);
}

function getSessionsKV(): KVNamespace {
  const { env } = getCloudflareContext() as unknown as { env: AuthEnv };
  return env.SESSIONS;
}

// Session functions - getSession and destroySession call KV directly (no RPC needed)
export async function getSession(sessionId: string): Promise<SessionData | null> {
  return getSessionKV(getSessionsKV(), sessionId);
}

export async function getSessionWithUser(
  sessionId: string
): Promise<{ session: SessionData; user: UserProfile } | null> {
  return withRpc((rpc) => rpc.getSessionWithUser(sessionId));
}

export async function createSession(
  userId: string,
  orgId: string,
  workspaceId: string | null = null
): Promise<{ sessionId: string; sessionData: SessionData }> {
  return createNewSessionKV(getSessionsKV(), userId, orgId, workspaceId);
}

export async function destroySession(sessionId: string): Promise<void> {
  return destroySessionKV(getSessionsKV(), sessionId);
}

export async function switchSessionOrg(
  sessionId: string,
  orgId: string,
  workspaceId: string | null = null
): Promise<void> {
  return withRpc((rpc) => rpc.switchSessionOrg(sessionId, orgId, workspaceId));
}

export async function switchSessionWorkspace(sessionId: string, workspaceId: string | null): Promise<void> {
  return withRpc((rpc) => rpc.switchSessionWorkspace(sessionId, workspaceId));
}

// User functions
export async function getUserByEmail(email: string): Promise<{ userId: string; user: UserProfile } | null> {
  return withRpc((rpc) => rpc.getUserByEmail(email));
}

export async function getUserById(userId: string): Promise<UserProfile | null> {
  return withRpc((rpc) => rpc.getUserById(userId));
}

export async function getUsersByIds(userIds: string[]): Promise<UserProfile[]> {
  return withRpc((rpc) => rpc.getUsersByIds(userIds));
}

export async function updateUserProfile(
  userId: string,
  updates: { name?: string | null; avatar?: { color: string; content: string } }
): Promise<User | null> {
  const profile = await withRpc((rpc) =>
    rpc.updateUserProfile(userId, {
      name: updates.name,
      avatar: updates.avatar,
    })
  );
  if (!profile) return null;
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

export async function createUser(
  email: string,
  password: string,
  name: string | null
): Promise<{ userId: string; user: UserProfile }> {
  return withRpc((rpc) => rpc.createUser(email, password, name));
}

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  return withRpc((rpc) => rpc.verifyUserPassword(userId, password));
}

export async function getUserOrgs(userId: string): Promise<OrgMembership[]> {
  return withRpc((rpc) => rpc.getUserOrgs(userId));
}

export async function addUserToOrg(userId: string, orgId: string, role: OrgRole): Promise<void> {
  return withRpc((rpc) => rpc.addUserToOrg(userId, orgId, role));
}

export async function removeUserFromOrg(userId: string, orgId: string): Promise<void> {
  return withRpc((rpc) => rpc.removeUserFromOrg(userId, orgId));
}

// Admin functions
export async function getAdminOverview(): Promise<AdminOverview> {
  return withRpc((rpc) => rpc.getAdminOverview());
}

export async function adminUpdateUser(
  userId: string,
  updates: { name?: string | null; is_superuser?: boolean; avatar?: { color: string; content: string } }
): Promise<User | null> {
  const profile = await withRpc((rpc) => rpc.adminUpdateUser(userId, updates));
  if (!profile) return null;
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

export async function adminGetAllOrgs(): Promise<Array<Organization & { member_count: number; workspace_count: number }>> {
  return withRpc((rpc) => rpc.adminGetAllOrgs());
}

export async function adminGetAllThreads(): Promise<AdminThreadWithContext[]> {
  return withRpc((rpc) => rpc.adminGetAllThreads());
}

export async function adminGetThreadWithMessages(threadId: string): Promise<{
  thread: { id: string; title: string; created_by: string; created_at: number; updated_at: number };
  messages: Message[];
  org_id: string;
  workspace_id: string;
  org_name: string;
  workspace_name: string;
  preview_workers: string[];
} | null> {
  return withRpc((rpc) => rpc.adminGetThreadWithMessages(threadId));
}

export async function adminUpdateThread(
  threadId: string,
  updates: { title?: string }
): Promise<{ id: string; title: string; created_by: string; created_at: number; updated_at: number } | null> {
  return withRpc((rpc) => rpc.adminUpdateThread(threadId, updates));
}

// Paginated admin functions
export async function adminGetUsersPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminUserSummary>> {
  return withRpc((rpc) => rpc.adminGetUsersPaginated(params));
}

export async function adminGetOrgsPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<Organization & { member_count: number; workspace_count: number }>> {
  return withRpc((rpc) => rpc.adminGetOrgsPaginated(params));
}

export async function adminGetWorkspacesPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminWorkspaceSummary>> {
  return withRpc((rpc) => rpc.adminGetWorkspacesPaginated(params));
}

export async function adminGetThreadsPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminThreadWithContext>> {
  return withRpc((rpc) => rpc.adminGetThreadsPaginated(params));
}

export async function adminGetAppsPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminAppSummary>> {
  return withRpc((rpc) => rpc.adminGetAppsPaginated(params));
}

export async function adminGetAppDetail(scriptName: string): Promise<AdminAppDetail | null> {
  return withRpc((rpc) => rpc.adminGetAppDetail(scriptName));
}

export async function adminGetAppCount(): Promise<number> {
  return withRpc((rpc) => rpc.adminGetAppCount());
}

export async function adminGetInvitationsPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminInvitation>> {
  return withRpc((rpc) => rpc.adminGetInvitationsPaginated(params));
}

export async function adminGetWorkspaceDetail(workspaceId: string): Promise<AdminWorkspaceDetail | null> {
  return withRpc((rpc) => rpc.adminGetWorkspaceDetail(workspaceId));
}

export async function adminUpdateWorkspace(
  workspaceId: string,
  updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } },
  actorId: string
): Promise<Workspace | null> {
  return withRpc((rpc) => rpc.adminUpdateWorkspace(workspaceId, updates, actorId));
}

export async function adminArchiveWorkspace(workspaceId: string, actorId: string): Promise<Workspace | null> {
  return withRpc((rpc) => rpc.adminArchiveWorkspace(workspaceId, actorId));
}

export async function adminTransferOrgOwnership(
  orgId: string,
  newOwnerId: string,
  actorId: string
): Promise<void> {
  return withRpc((rpc) => rpc.adminTransferOrgOwnership(orgId, newOwnerId, actorId));
}

export async function adminAddOrgMember(
  orgId: string,
  userId: string,
  role: 'admin' | 'member',
  actorId: string
): Promise<void> {
  return withRpc((rpc) => rpc.adminAddOrgMember(orgId, userId, role, actorId));
}

export async function adminForceOrphanUser(userId: string, actorId: string): Promise<void> {
  return withRpc((rpc) => rpc.adminForceOrphanUser(userId, actorId));
}

export async function adminDeleteInvitation(orgId: string, invitationId: string): Promise<void> {
  return withRpc((rpc) => rpc.adminDeleteInvitation(orgId, invitationId));
}

// Organization functions
export async function getOrg(orgId: string): Promise<Organization | null> {
  return withRpc((rpc) => rpc.getOrg(orgId));
}

export async function createOrg(name: string, createdBy: string): Promise<Organization> {
  return withRpc((rpc) => rpc.createOrg(name, createdBy));
}

export async function updateOrgName(orgId: string, name: string, actorId: string): Promise<void> {
  return withRpc((rpc) => rpc.updateOrgName(orgId, name, actorId));
}

export async function getOrgMembers(orgId: string): Promise<Array<{ user: User; role: OrgRole; joined_at: number }>> {
  return withRpc((rpc) => rpc.getOrgMembers(orgId));
}

export async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  return withRpc((rpc) => rpc.isOrgMember(userId, orgId));
}

export async function isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
  return withRpc((rpc) => rpc.isOrgAdmin(userId, orgId));
}

export async function removeOrgMember(orgId: string, userId: string, actorId: string): Promise<void> {
  return withRpc((rpc) => rpc.removeOrgMember(orgId, userId, actorId));
}

export async function updateOrgMemberRole(orgId: string, userId: string, role: OrgRole, actorId: string): Promise<void> {
  return withRpc((rpc) => rpc.updateOrgMemberRole(orgId, userId, role, actorId));
}

export async function transferOrgOwnership(orgId: string, newOwnerId: string, actorId: string): Promise<void> {
  return withRpc((rpc) => rpc.transferOrgOwnership(orgId, newOwnerId, actorId));
}

export async function archiveOrg(orgId: string, actorId: string): Promise<void> {
  return withRpc((rpc) => rpc.archiveOrg(orgId, actorId));
}

export async function listOrgWorkspaces(orgId: string): Promise<Workspace[]> {
  return withRpc((rpc) => rpc.listOrgWorkspaces(orgId));
}

export async function listUserWorkspaces(userId: string, orgId: string): Promise<WorkspaceWithAccess[]> {
  return withRpc((rpc) => rpc.listUserWorkspaces(userId, orgId));
}

export async function listUserWorkspacesAcrossOrgs(
  userId: string,
  orgs?: OrgMembership[]
): Promise<WorkspaceWithAccess[]> {
  const memberships = orgs ?? (await getUserOrgs(userId));
  if (memberships.length === 0) return [];

  const workspaces = await Promise.all(
    memberships.map((membership) => listUserWorkspaces(userId, membership.org_id))
  );
  return workspaces.flat();
}

export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  return withRpc((rpc) => rpc.getWorkspace(workspaceId));
}

export async function createWorkspace(
  orgId: string,
  name: string,
  createdBy: string,
  description?: string | null
): Promise<Workspace> {
  return withRpc((rpc) => rpc.createWorkspace(orgId, name, createdBy, description ?? null));
}

export async function updateWorkspace(
  workspaceId: string,
  updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } },
  actorId: string
): Promise<Workspace | null> {
  return withRpc((rpc) => rpc.updateWorkspace(workspaceId, updates, actorId));
}

export async function archiveWorkspace(workspaceId: string, actorId: string): Promise<Workspace | null> {
  return withRpc((rpc) => rpc.archiveWorkspace(workspaceId, actorId));
}

export async function getWorkspaceAccess(workspaceId: string, userId: string): Promise<WorkspaceAccessLevel> {
  return withRpc((rpc) => rpc.getWorkspaceAccess(workspaceId, userId));
}

export async function setWorkspaceAccess(
  workspaceId: string,
  userId: string,
  accessLevel: WorkspaceAccessLevel,
  actorId: string
): Promise<void> {
  return withRpc((rpc) => rpc.setWorkspaceAccess(workspaceId, userId, accessLevel, actorId));
}

export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  return withRpc((rpc) => rpc.listWorkspaceMembers(workspaceId));
}

export async function checkUserOrphaned(userId: string): Promise<boolean> {
  return withRpc((rpc) => rpc.checkUserOrphaned(userId));
}

export async function handleOrphanedUserLogin(
  userId: string
): Promise<{ org: Organization; workspace: WorkspaceWithAccess } | null> {
  return withRpc((rpc) => rpc.handleOrphanedUserLogin(userId));
}

export async function getOrgAuditLog(
  orgId: string,
  limit?: number,
  offset?: number
): Promise<AuditLogEntry[]> {
  return withRpc((rpc) => rpc.getOrgAuditLog(orgId, limit, offset));
}

export async function getWorkspaceAuditLog(
  workspaceId: string,
  limit?: number,
  offset?: number
): Promise<AuditLogEntry[]> {
  return withRpc((rpc) => rpc.getWorkspaceAuditLog(workspaceId, limit, offset));
}

// Invitation functions
export async function createInvitation(
  orgId: string,
  email: string,
  role: OrgRole,
  invitedBy: string
): Promise<{ id: string; expires_at: number }> {
  return withRpc((rpc) => rpc.createInvitation(orgId, email, role, invitedBy));
}

export async function getInvitation(orgId: string, invitationId: string): Promise<{
  id: string;
  email: string;
  role: OrgRole;
  org: Organization;
} | null> {
  return withRpc((rpc) => rpc.getInvitation(orgId, invitationId));
}

export async function acceptInvitation(orgId: string, invitationId: string, userId: string): Promise<boolean> {
  return withRpc((rpc) => rpc.acceptInvitation(orgId, invitationId, userId));
}

export async function getOrgInvitations(orgId: string): Promise<Array<{
  id: string;
  email: string;
  role: OrgRole;
  created_at: number;
  expires_at: number;
}>> {
  return withRpc((rpc) => rpc.getOrgInvitations(orgId));
}

export async function deleteInvitation(orgId: string, invitationId: string): Promise<void> {
  return withRpc((rpc) => rpc.deleteInvitation(orgId, invitationId));
}

// Integration functions
export async function getWorkspaceIntegrations(workspaceId: string): Promise<Integration[]> {
  return withRpc((rpc) => rpc.getWorkspaceIntegrations(workspaceId));
}

export async function getWorkspaceIntegration(
  workspaceId: string,
  integrationId: string
): Promise<Integration | null> {
  return withRpc((rpc) => rpc.getWorkspaceIntegration(workspaceId, integrationId));
}

export async function createWorkspaceIntegration(
  workspaceId: string,
  userId: string,
  input: CreateIntegrationInput
): Promise<Integration> {
  return withRpc((rpc) => rpc.createWorkspaceIntegration(workspaceId, userId, input));
}

export async function updateWorkspaceIntegration(
  workspaceId: string,
  integrationId: string,
  actorId: string,
  input: UpdateIntegrationInput
): Promise<Integration | null> {
  return withRpc((rpc) => rpc.updateWorkspaceIntegration(workspaceId, integrationId, actorId, input));
}

export async function deleteWorkspaceIntegration(
  workspaceId: string,
  integrationId: string,
  actorId: string
): Promise<void> {
  return withRpc((rpc) => rpc.deleteWorkspaceIntegration(workspaceId, integrationId, actorId));
}

export async function resetWorkspaceContainer(
  workspaceId: string
): Promise<{ success: boolean; containerId: string }> {
  return withRpc((rpc) => rpc.resetWorkspaceContainer(workspaceId));
}

export async function restartOrgContainers(
  orgId: string
): Promise<{ restarted: number; failed: number }> {
  return withRpc((rpc) => rpc.restartOrgContainers(orgId));
}

// API Token functions
export async function createOrgApiToken(
  orgId: string,
  userId: string,
  input: CreateApiTokenInput
): Promise<{ tokenId: string; tokenData: ApiTokenData }> {
  return withRpc((rpc) => rpc.createOrgApiToken(orgId, userId, input));
}

export async function validateApiToken(tokenId: string): Promise<ApiTokenData | null> {
  return withRpc((rpc) => rpc.validateApiToken(tokenId));
}

export async function deleteApiToken(tokenId: string): Promise<void> {
  return withRpc((rpc) => rpc.deleteApiToken(tokenId));
}

// Worker script functions
export interface WorkerScriptAccess {
  script_name: string;
  workspace_id: string;
  org_id: string;
  is_public: boolean;
}

export async function getWorkerAccessInfo(scriptName: string): Promise<WorkerScriptAccess | null> {
  return withRpc((rpc) => rpc.getWorkerAccessInfo(scriptName));
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

export async function listWorkerScripts(orgId: string): Promise<WorkerScript[]> {
  return withRpc((rpc) => rpc.listWorkerScripts(orgId));
}

export async function listWorkerScriptsByWorkspace(workspaceId: string): Promise<WorkerScript[]> {
  return withRpc((rpc) => rpc.listWorkerScriptsByWorkspace(workspaceId));
}

export async function getWorkerScript(
  orgId: string,
  scriptName: string
): Promise<WorkerScript | null> {
  return withRpc((rpc) => rpc.getWorkerScript(orgId, scriptName));
}

export async function deleteWorkerScript(
  orgId: string,
  scriptName: string,
  actorId: string
): Promise<boolean> {
  return withRpc((rpc) => rpc.deleteWorkerScript(orgId, scriptName, actorId));
}

export async function setWorkerScriptPublic(
  orgId: string,
  scriptName: string,
  isPublic: boolean,
  actorId: string
): Promise<WorkerScript | null> {
  return withRpc((rpc) => rpc.setWorkerScriptPublic(orgId, scriptName, isPublic, actorId));
}

export async function adminSetAppPublic(
  orgId: string,
  scriptName: string,
  isPublic: boolean,
  actorId: string
): Promise<WorkerScript | null> {
  return withRpc((rpc) => rpc.setWorkerScriptPublic(orgId, scriptName, isPublic, actorId));
}

export async function adminDeleteApp(
  orgId: string,
  scriptName: string,
  actorId: string
): Promise<boolean> {
  return withRpc((rpc) => rpc.deleteWorkerScript(orgId, scriptName, actorId));
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

export async function validateAndConsumeWorkerAuthState(state: string): Promise<WorkerAuthState | null> {
  return withRpc((rpc) => rpc.validateAndConsumeAuthStateRpc(state));
}

export async function createWorkerAuthToken(
  userId: string,
  orgId: string,
  state: string,
  scriptName: string
): Promise<string> {
  return withRpc((rpc) => rpc.createWorkerAuthTokenRpc(userId, orgId, state, scriptName));
}
