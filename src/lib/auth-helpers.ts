/**
 * Core auth helpers: AuthEnv interface and integration record converter.
 * Keep this file minimal - only pure helpers with no business logic.
 */
import type { Integration } from '@/types';
import { UserDO, OrgDO } from '../../workers/main/src/auth';
import { WorkspaceDO } from '../../workers/main/src/workspace';

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
// Integration Record Converter (DB record → API type)
// ============================================================================

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
