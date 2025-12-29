import { getCloudflareContext } from '@opennextjs/cloudflare';
import type {
  User,
  Organization,
  OrgMembership,
  UserProject,
  Integration,
  CreateIntegrationInput,
  UpdateIntegrationInput,
  CreateApiTokenInput,
  AdminOverview,
  AdminUserSummary,
  PaginatedResult,
  PaginationParams,
  Thread,
  Project,
} from '@/types';
import type { SessionData, UserProfile } from '../../worker/auth';
import type { ApiTokenData } from '../../worker/api-tokens';
import type { DoRpcService } from '../../worker/rpc-service';

interface AuthEnv {
  DO_RPC: DoRpcService;
}

async function getRpc(): Promise<DoRpcService> {
  const { env } = getCloudflareContext() as unknown as { env: AuthEnv };
  return env.DO_RPC;
}

// Session functions
export async function getSession(sessionId: string): Promise<SessionData | null> {
  const rpc = await getRpc();
  return rpc.getSession(sessionId);
}

export async function createSession(
  userId: string,
  orgId: string
): Promise<{ sessionId: string; sessionData: SessionData }> {
  const rpc = await getRpc();
  return rpc.createSession(userId, orgId);
}

export async function destroySession(sessionId: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.destroySession(sessionId);
}

export async function switchSessionOrg(sessionId: string, orgId: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.switchSessionOrg(sessionId, orgId);
}

// User functions
export async function getUserByEmail(email: string): Promise<{ userId: string; user: UserProfile } | null> {
  const rpc = await getRpc();
  return rpc.getUserByEmail(email);
}

export async function getUserById(userId: string): Promise<UserProfile | null> {
  const rpc = await getRpc();
  return rpc.getUserById(userId);
}

export async function createUser(
  email: string,
  password: string,
  name: string | null
): Promise<{ userId: string; user: UserProfile }> {
  const rpc = await getRpc();
  return rpc.createUser(email, password, name);
}

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const rpc = await getRpc();
  return rpc.verifyUserPassword(userId, password);
}

export async function getUserOrgs(userId: string): Promise<OrgMembership[]> {
  const rpc = await getRpc();
  return rpc.getUserOrgs(userId);
}

export async function addUserToOrg(userId: string, orgId: string, role: 'admin' | 'member'): Promise<void> {
  const rpc = await getRpc();
  await rpc.addUserToOrg(userId, orgId, role);
}

export async function removeUserFromOrg(userId: string, orgId: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.removeUserFromOrg(userId, orgId);
}

export async function getUserProjects(userId: string): Promise<UserProject[]> {
  const rpc = await getRpc();
  return rpc.getUserProjects(userId);
}

export async function addUserProject(userId: string, orgId: string, projectId: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.addUserProject(userId, orgId, projectId);
}

export async function removeUserProject(userId: string, orgId: string, projectId: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.removeUserProject(userId, orgId, projectId);
}

// Admin functions
export async function getAdminOverview(): Promise<AdminOverview> {
  const rpc = await getRpc();
  return rpc.getAdminOverview();
}

export async function adminUpdateUser(
  userId: string,
  updates: { name?: string; is_superuser?: boolean }
): Promise<User | null> {
  const rpc = await getRpc();
  const profile = await rpc.adminUpdateUser(userId, updates);
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
  const rpc = await getRpc();
  return rpc.adminGetAllOrgs();
}

export async function adminGetAllThreads(): Promise<Array<{
  id: string;
  title: string;
  project_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  org_id: string;
}>> {
  const rpc = await getRpc();
  return rpc.adminGetAllThreads();
}

export async function adminGetAllProjects(): Promise<Array<{
  id: string;
  name: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  org_id: string;
}>> {
  const rpc = await getRpc();
  return rpc.adminGetAllProjects();
}

export async function adminGetThreadWithMessages(threadId: string): Promise<{
  thread: { id: string; title: string; project_id: string; created_by: string; created_at: number; updated_at: number };
  messages: Array<{ id: string; thread_id: string; role: 'user' | 'assistant'; content: string; created_at: number }>;
  org_id: string;
} | null> {
  const rpc = await getRpc();
  return rpc.adminGetThreadWithMessages(threadId);
}

export async function adminUpdateThread(
  threadId: string,
  updates: { title?: string }
): Promise<{ id: string; title: string; project_id: string; created_by: string; created_at: number; updated_at: number } | null> {
  const rpc = await getRpc();
  return rpc.adminUpdateThread(threadId, updates);
}

export async function adminUpdateProject(
  projectId: string,
  updates: { name?: string }
): Promise<{ id: string; name: string; created_by: string; created_at: number; updated_at: number } | null> {
  const rpc = await getRpc();
  return rpc.adminUpdateProject(projectId, updates);
}

// Paginated admin functions
export async function adminGetUsersPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<AdminUserSummary>> {
  const rpc = await getRpc();
  return rpc.adminGetUsersPaginated(params);
}

export async function adminGetOrgsPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<Organization & { member_count: number }>> {
  const rpc = await getRpc();
  return rpc.adminGetOrgsPaginated(params);
}

export async function adminGetThreadsPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<Thread & { org_id: string }>> {
  const rpc = await getRpc();
  return rpc.adminGetThreadsPaginated(params);
}

export async function adminGetProjectsPaginated(
  params: PaginationParams = {}
): Promise<PaginatedResult<Project & { org_id: string }>> {
  const rpc = await getRpc();
  return rpc.adminGetProjectsPaginated(params);
}

// Organization functions
export async function getOrg(orgId: string): Promise<Organization | null> {
  const rpc = await getRpc();
  return rpc.getOrg(orgId);
}

export async function createOrg(name: string, createdBy: string): Promise<Organization> {
  const rpc = await getRpc();
  return rpc.createOrg(name, createdBy);
}

export async function updateOrgName(orgId: string, name: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.updateOrgName(orgId, name);
}

export async function getOrgMembers(orgId: string): Promise<Array<{ user: User; role: 'admin' | 'member'; joined_at: number }>> {
  const rpc = await getRpc();
  return rpc.getOrgMembers(orgId);
}

export async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  const rpc = await getRpc();
  return rpc.isOrgMember(userId, orgId);
}

export async function isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
  const rpc = await getRpc();
  return rpc.isOrgAdmin(userId, orgId);
}

export async function removeOrgMember(orgId: string, userId: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.removeOrgMember(orgId, userId);
}

export async function updateOrgMemberRole(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
  const rpc = await getRpc();
  await rpc.updateOrgMemberRole(orgId, userId, role);
}

// Invitation functions
export async function createInvitation(
  orgId: string,
  email: string,
  role: 'admin' | 'member',
  invitedBy: string
): Promise<{ id: string; expires_at: number }> {
  const rpc = await getRpc();
  return rpc.createInvitation(orgId, email, role, invitedBy);
}

export async function getInvitation(orgId: string, invitationId: string): Promise<{
  id: string;
  email: string;
  role: 'admin' | 'member';
  org: Organization;
} | null> {
  const rpc = await getRpc();
  return rpc.getInvitation(orgId, invitationId);
}

export async function acceptInvitation(orgId: string, invitationId: string, userId: string): Promise<boolean> {
  const rpc = await getRpc();
  return rpc.acceptInvitation(orgId, invitationId, userId);
}

export async function getOrgInvitations(orgId: string): Promise<Array<{
  id: string;
  email: string;
  role: 'admin' | 'member';
  created_at: number;
  expires_at: number;
}>> {
  const rpc = await getRpc();
  return rpc.getOrgInvitations(orgId);
}

export async function deleteInvitation(orgId: string, invitationId: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.deleteInvitation(orgId, invitationId);
}

// Integration functions
export async function getOrgIntegrations(orgId: string): Promise<Integration[]> {
  const rpc = await getRpc();
  return rpc.getOrgIntegrations(orgId);
}

export async function getOrgIntegration(orgId: string, integrationId: string): Promise<Integration | null> {
  const rpc = await getRpc();
  return rpc.getOrgIntegration(orgId, integrationId);
}

export async function createOrgIntegration(
  orgId: string,
  userId: string,
  input: CreateIntegrationInput
): Promise<Integration> {
  const rpc = await getRpc();
  return rpc.createOrgIntegration(orgId, userId, input);
}

export async function updateOrgIntegration(
  orgId: string,
  integrationId: string,
  input: UpdateIntegrationInput
): Promise<Integration | null> {
  const rpc = await getRpc();
  return rpc.updateOrgIntegration(orgId, integrationId, input);
}

export async function deleteOrgIntegration(orgId: string, integrationId: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.deleteOrgIntegration(orgId, integrationId);
}

// API Token functions
export async function createOrgApiToken(
  orgId: string,
  userId: string,
  input: CreateApiTokenInput
): Promise<{ tokenId: string; tokenData: ApiTokenData }> {
  const rpc = await getRpc();
  return rpc.createOrgApiToken(orgId, userId, input);
}

export async function validateApiToken(tokenId: string): Promise<ApiTokenData | null> {
  const rpc = await getRpc();
  return rpc.validateApiToken(tokenId);
}

export async function deleteApiToken(tokenId: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.deleteApiToken(tokenId);
}
