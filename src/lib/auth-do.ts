import type {
  User,
  Organization,
  OrgMembership,
  Integration,
  CreateIntegrationInput,
  UpdateIntegrationInput,
  CreateApiTokenInput,
  AdminOverview,
  AdminUserSummary,
  PaginatedResult,
  PaginationParams,
  Thread,
  Message,
} from '@/types';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { withDoRpc } from '@/lib/do-rpc';
import type { SessionData, UserProfile } from '../../workers/main/src/auth';
import type { ApiTokenData } from '../../workers/main/src/api-tokens';
import type { DoRpcService } from '../../workers/main/src/rpc-service';

interface AuthEnv {
  DO_RPC: DoRpcService;
}

async function withRpc<T>(fn: (rpc: DoRpcService) => Promise<T>): Promise<T> {
  const { env } = getCloudflareContext() as unknown as { env: AuthEnv };
  return withDoRpc(env.DO_RPC, fn);
}

// Session functions
export async function getSession(sessionId: string): Promise<SessionData | null> {
  return withRpc((rpc) => rpc.getSession(sessionId));
}

export async function getSessionWithUser(
  sessionId: string
): Promise<{ session: SessionData; user: UserProfile } | null> {
  return withRpc((rpc) => rpc.getSessionWithUser(sessionId));
}

export async function createSession(
  userId: string,
  orgId: string
): Promise<{ sessionId: string; sessionData: SessionData }> {
  return withRpc((rpc) => rpc.createSession(userId, orgId));
}

export async function destroySession(sessionId: string): Promise<void> {
  return withRpc((rpc) => rpc.destroySession(sessionId));
}

export async function switchSessionOrg(sessionId: string, orgId: string): Promise<void> {
  return withRpc((rpc) => rpc.switchSessionOrg(sessionId, orgId));
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

export async function addUserToOrg(userId: string, orgId: string, role: 'admin' | 'member'): Promise<void> {
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
  updates: { name?: string; is_superuser?: boolean }
): Promise<User | null> {
  const profile = await withRpc((rpc) => rpc.adminUpdateUser(userId, updates));
  if (!profile) return null;
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    created_at: profile.created_at,
    is_superuser: profile.is_superuser,
  };
}

export async function adminGetAllOrgs(): Promise<Array<Organization & { member_count: number }>> {
  return withRpc((rpc) => rpc.adminGetAllOrgs());
}

export async function adminGetAllThreads(): Promise<Array<{
  id: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  org_id: string;
}>> {
  return withRpc((rpc) => rpc.adminGetAllThreads());
}

export async function adminGetThreadWithMessages(threadId: string): Promise<{
  thread: { id: string; title: string; created_by: string; created_at: number; updated_at: number };
  messages: Message[];
  org_id: string;
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
): Promise<PaginatedResult<Organization & { member_count: number }>> {
  return withRpc((rpc) => rpc.adminGetOrgsPaginated(params));
}

export async function adminGetThreadsPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<Thread & { org_id: string }>> {
  return withRpc((rpc) => rpc.adminGetThreadsPaginated(params));
}

// Organization functions
export async function getOrg(orgId: string): Promise<Organization | null> {
  return withRpc((rpc) => rpc.getOrg(orgId));
}

export async function createOrg(name: string, createdBy: string): Promise<Organization> {
  return withRpc((rpc) => rpc.createOrg(name, createdBy));
}

export async function updateOrgName(orgId: string, name: string): Promise<void> {
  return withRpc((rpc) => rpc.updateOrgName(orgId, name));
}

export async function getOrgMembers(orgId: string): Promise<Array<{ user: User; role: 'admin' | 'member'; joined_at: number }>> {
  return withRpc((rpc) => rpc.getOrgMembers(orgId));
}

export async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  return withRpc((rpc) => rpc.isOrgMember(userId, orgId));
}

export async function isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
  return withRpc((rpc) => rpc.isOrgAdmin(userId, orgId));
}

export async function removeOrgMember(orgId: string, userId: string): Promise<void> {
  return withRpc((rpc) => rpc.removeOrgMember(orgId, userId));
}

export async function updateOrgMemberRole(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
  return withRpc((rpc) => rpc.updateOrgMemberRole(orgId, userId, role));
}

// Invitation functions
export async function createInvitation(
  orgId: string,
  email: string,
  role: 'admin' | 'member',
  invitedBy: string
): Promise<{ id: string; expires_at: number }> {
  return withRpc((rpc) => rpc.createInvitation(orgId, email, role, invitedBy));
}

export async function getInvitation(orgId: string, invitationId: string): Promise<{
  id: string;
  email: string;
  role: 'admin' | 'member';
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
  role: 'admin' | 'member';
  created_at: number;
  expires_at: number;
}>> {
  return withRpc((rpc) => rpc.getOrgInvitations(orgId));
}

export async function deleteInvitation(orgId: string, invitationId: string): Promise<void> {
  return withRpc((rpc) => rpc.deleteInvitation(orgId, invitationId));
}

// Integration functions
export async function getOrgIntegrations(orgId: string): Promise<Integration[]> {
  return withRpc((rpc) => rpc.getOrgIntegrations(orgId));
}

export async function getOrgIntegration(orgId: string, integrationId: string): Promise<Integration | null> {
  return withRpc((rpc) => rpc.getOrgIntegration(orgId, integrationId));
}

export async function createOrgIntegration(
  orgId: string,
  userId: string,
  input: CreateIntegrationInput
): Promise<Integration> {
  return withRpc((rpc) => rpc.createOrgIntegration(orgId, userId, input));
}

export async function updateOrgIntegration(
  orgId: string,
  integrationId: string,
  input: UpdateIntegrationInput
): Promise<Integration | null> {
  return withRpc((rpc) => rpc.updateOrgIntegration(orgId, integrationId, input));
}

export async function deleteOrgIntegration(orgId: string, integrationId: string): Promise<void> {
  return withRpc((rpc) => rpc.deleteOrgIntegration(orgId, integrationId));
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
