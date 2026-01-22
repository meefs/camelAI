/**
 * Core auth helpers: DO stubs, type converters, and AuthEnv interface.
 * Keep this file minimal - only pure helpers with no business logic.
 */
import type { User, Organization, Workspace, Integration } from '@/types';
import { type UserProfile, type OrgInfo, UserDO, OrgDO } from '../../workers/main/src/auth';
import { WorkspaceDO, type WorkspaceInfo } from '../../workers/main/src/workspace';

// Re-export types that consumers need
export type { UserProfile, OrgInfo, OrgThread } from '../../workers/main/src/auth';
export type { WorkspaceInfo } from '../../workers/main/src/workspace';
export type { SessionData } from '../../workers/main/src/session-kv';
export type { ApiTokenData } from '../../workers/main/src/api-tokens';

/**
 * Auth environment bindings required for DO access.
 */
export interface AuthEnv {
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  SESSIONS: KVNamespace;
  EMAIL_TO_USER: KVNamespace;
  API_TOKENS: KVNamespace;
}

// ============================================================================
// DO Stub Helpers
// ============================================================================

export function getUserStub(env: AuthEnv, userId: string): UserDO {
  return env.USER.get(env.USER.idFromName(userId)) as unknown as UserDO;
}

export function getOrgStub(env: AuthEnv, orgId: string): OrgDO {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgDO;
}

export function getWorkspaceStub(env: AuthEnv, workspaceId: string): WorkspaceDO {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as unknown as WorkspaceDO;
}

// ============================================================================
// Type Converters (DO types → API types)
// ============================================================================

export function profileToUser(profile: UserProfile): User {
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

export function orgInfoToOrg(info: OrgInfo): Organization {
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

export function wsInfoToWorkspace(info: WorkspaceInfo): Workspace {
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

export function integrationRecordToIntegration(r: {
  id: string;
  integration_type: string;
  name: string;
  category: string;
  auth_method: string;
  config: string | null;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  credentials_encrypted: string | null;
}): Integration {
  return {
    id: r.id,
    integration_type: r.integration_type,
    name: r.name,
    category: r.category as Integration['category'],
    auth_method: r.auth_method as Integration['auth_method'],
    config: r.config ? JSON.parse(r.config) : {},
    enabled: r.enabled === 1,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    has_credentials: !!r.credentials_encrypted,
  };
}
