/**
 * Core auth helpers: AuthEnv interface, getAuthEnv, and integration record converter.
 * Keep this file minimal - only pure helpers with no business logic.
 */
import type { Integration } from '@/types';
import type { CloudflareEnv } from './cloudflare.server';
import { UserDO, OrgDO } from '../../workers/main/src/auth';
import { WorkspaceDO } from '../../workers/main/src/workspace';

// Re-export types that are only defined in worker modules
export type { OrgThread } from '../../workers/main/src/auth';
export type { SessionData } from '../../workers/main/src/session-kv';
export type { ApiTokenData } from '../../workers/main/src/api-tokens';

// User, Organization, Workspace types should be imported from @/types directly

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

/**
 * Extract AuthEnv bindings from CloudflareEnv.
 */
export function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    API_TOKENS: env.API_TOKENS,
  };
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
