/**
 * Server-side auth-do functions that accept React Router AppLoadContext.
 * These functions wrap the auth-do module to use context-passed environment.
 */
import type { AppLoadContext } from 'react-router';
import type {
  User,
  Organization,
  OrgMembership,
  OrgRole,
  WorkspaceWithAccess,
  AuditLogEntry,
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
} from '@/types';
import { getEnv, type CloudflareEnv } from './cloudflare.server';
import type { UserProfile } from '../../workers/main/src/auth';
import * as authDO from './auth-do';

function getAuthEnv(env: CloudflareEnv): authDO.AuthEnv {
  return {
    USER: env.USER as authDO.AuthEnv['USER'],
    ORG: env.ORG as authDO.AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as authDO.AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    API_TOKENS: env.API_TOKENS,
  };
}

// Admin overview functions - these require complex iteration and are not yet fully implemented
export async function getAdminOverview(_context: AppLoadContext): Promise<AdminOverview> {
  throw new Error('getAdminOverview not yet implemented - requires admin DO service');
}

export async function adminGetAllThreads(_context: AppLoadContext): Promise<AdminThreadWithContext[]> {
  throw new Error('adminGetAllThreads not yet implemented - requires admin DO service');
}

export async function adminGetAppCount(_context: AppLoadContext): Promise<number> {
  throw new Error('adminGetAppCount not yet implemented - requires admin DO service');
}

// Paginated admin functions
export async function adminGetUsersPaginated(
  _context: AppLoadContext,
  _params: PaginationParams = {}
): Promise<PaginatedResult<AdminUserSummary>> {
  throw new Error('adminGetUsersPaginated not yet implemented - requires admin DO service');
}

export async function adminGetOrgsPaginated(
  _context: AppLoadContext,
  _params: PaginationParams = {}
): Promise<PaginatedResult<Organization & { member_count: number; workspace_count: number }>> {
  throw new Error('adminGetOrgsPaginated not yet implemented - requires admin DO service');
}

export async function adminGetWorkspacesPaginated(
  _context: AppLoadContext,
  _params: PaginationParams = {}
): Promise<PaginatedResult<AdminWorkspaceSummary>> {
  throw new Error('adminGetWorkspacesPaginated not yet implemented - requires admin DO service');
}

export async function adminGetThreadsPaginated(
  _context: AppLoadContext,
  _params: PaginationParams = {}
): Promise<PaginatedResult<AdminThreadWithContext>> {
  throw new Error('adminGetThreadsPaginated not yet implemented - requires admin DO service');
}

export async function adminGetAppsPaginated(
  _context: AppLoadContext,
  _params: PaginationParams = {}
): Promise<PaginatedResult<AdminAppSummary>> {
  throw new Error('adminGetAppsPaginated not yet implemented - requires admin DO service');
}

export async function adminGetInvitationsPaginated(
  _context: AppLoadContext,
  _params: PaginationParams = {}
): Promise<PaginatedResult<AdminInvitation>> {
  throw new Error('adminGetInvitationsPaginated not yet implemented - requires admin DO service');
}

// Admin detail functions
export async function adminGetThreadWithMessages(
  _context: AppLoadContext,
  _threadId: string
): Promise<{
  thread: { id: string; title: string; created_by: string; created_at: number; updated_at: number };
  messages: Message[];
  org_id: string;
  workspace_id: string;
  org_name: string;
  workspace_name: string;
  preview_workers: string[];
} | null> {
  throw new Error('adminGetThreadWithMessages not yet implemented - requires admin DO service');
}

export async function adminGetWorkspaceDetail(
  _context: AppLoadContext,
  _workspaceId: string
): Promise<AdminWorkspaceDetail | null> {
  throw new Error('adminGetWorkspaceDetail not yet implemented - requires admin DO service');
}

export async function adminGetAppDetail(
  _context: AppLoadContext,
  _scriptName: string
): Promise<AdminAppDetail | null> {
  throw new Error('adminGetAppDetail not yet implemented - requires admin DO service');
}

// User functions
export async function getUserById(context: AppLoadContext, userId: string): Promise<UserProfile | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getUserById(authEnv, userId);
}

export async function getUsersByIds(context: AppLoadContext, userIds: string[]): Promise<UserProfile[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getUsersByIds(authEnv, userIds);
}

export async function getUserOrgs(context: AppLoadContext, userId: string): Promise<OrgMembership[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getUserOrgs(authEnv, userId);
}

export async function listUserWorkspaces(
  context: AppLoadContext,
  userId: string,
  orgId: string
): Promise<WorkspaceWithAccess[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.listUserWorkspaces(authEnv, userId, orgId);
}

export async function listUserWorkspacesAcrossOrgs(
  context: AppLoadContext,
  userId: string,
  orgs?: OrgMembership[]
): Promise<WorkspaceWithAccess[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.listUserWorkspacesAcrossOrgs(authEnv, userId, orgs);
}

// Organization functions
export async function getOrg(context: AppLoadContext, orgId: string): Promise<Organization | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getOrg(authEnv, orgId);
}

export async function getOrgMembers(
  context: AppLoadContext,
  orgId: string
): Promise<Array<{ user: User; role: OrgRole; joined_at: number }>> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getOrgMembers(authEnv, orgId);
}

export async function getOrgInvitations(
  context: AppLoadContext,
  orgId: string
): Promise<Array<{
  id: string;
  email: string;
  role: OrgRole;
  created_at: number;
  expires_at: number;
}>> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getOrgInvitations(authEnv, orgId);
}

export async function getOrgAuditLog(
  context: AppLoadContext,
  orgId: string,
  limit?: number,
  offset?: number
): Promise<AuditLogEntry[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getOrgAuditLog(authEnv, orgId, limit, offset);
}

export async function getWorkspaceAuditLog(
  context: AppLoadContext,
  workspaceId: string,
  limit?: number,
  offset?: number
): Promise<AuditLogEntry[]> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authDO.getWorkspaceAuditLog(authEnv, workspaceId, limit, offset);
}

// Admin container reset functions
export async function resetAdminOrgContainers(
  _context: AppLoadContext,
  _orgId: string
): Promise<{ restarted: number; failed: number }> {
  throw new Error('resetAdminOrgContainers not yet implemented - requires container bindings');
}

export async function resetAdminWorkspaceContainer(
  _context: AppLoadContext,
  _workspaceId: string
): Promise<{ success: boolean; containerId: string }> {
  throw new Error('resetAdminWorkspaceContainer not yet implemented - requires container bindings');
}

// Admin org member functions
export async function addAdminOrgMember(
  context: AppLoadContext,
  orgId: string,
  userId: string,
  role: 'admin' | 'member'
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  // Use a system actor ID for admin operations
  const actorId = 'system-admin';
  await authDO.adminAddOrgMember(authEnv, orgId, userId, role, actorId);
}

export async function updateAdminOrgMemberRole(
  context: AppLoadContext,
  orgId: string,
  userId: string,
  role: OrgRole
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  // Use a system actor ID for admin operations
  const actorId = 'system-admin';
  await authDO.updateOrgMemberRole(authEnv, orgId, userId, role, actorId);
}

// Admin workspace functions
export async function adminUpdateWorkspace(
  context: AppLoadContext,
  workspaceId: string,
  updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } }
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const actorId = 'system-admin';
  await authDO.adminUpdateWorkspace(authEnv, workspaceId, updates, actorId);
}

export async function adminArchiveWorkspace(
  context: AppLoadContext,
  workspaceId: string
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const actorId = 'system-admin';
  await authDO.adminArchiveWorkspace(authEnv, workspaceId, actorId);
}

// Admin org functions
export async function adminArchiveOrg(
  context: AppLoadContext,
  orgId: string
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const actorId = 'system-admin';
  await authDO.archiveOrg(authEnv, orgId, actorId);
}

export async function adminTransferOrgOwnership(
  context: AppLoadContext,
  orgId: string,
  newOwnerId: string
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const actorId = 'system-admin';
  await authDO.adminTransferOrgOwnership(authEnv, orgId, newOwnerId, actorId);
}
