import { redirect, type AppLoadContext } from 'react-router';
import { getEnv, type CloudflareEnv } from './cloudflare.server';
import { getSessionIdFromRequest } from './cookies.server';
import {
  type SessionData,
  getSession as getSessionKV,
} from '../../workers/main/src/session-kv';
import type {
  User,
  Organization,
  OrgMembership,
  WorkspaceWithAccess,
} from '@/types';
import type { UserProfile } from '../../workers/main/src/auth';
import {
  getUserById,
  getOrg,
  getUserOrgs,
  listUserWorkspaces,
  isOrgAdmin,
  getWorkspaceAccess,
  type AuthEnv,
} from './auth-do';

export type Session = SessionData;

export interface SessionContext {
  sessionId: string;
  session: Session;
}

export interface UserContext extends SessionContext {
  user: User;
}

export interface AuthContext extends UserContext {
  currentOrg: Organization;
  currentWorkspace: WorkspaceWithAccess | null;
  orgs: OrgMembership[];
  workspaces: WorkspaceWithAccess[];
}

/**
 * Convert UserProfile to User type for frontend consumption
 */
function toUser(profile: UserProfile): User {
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

/**
 * Get auth env from CloudflareEnv
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

/**
 * Get session from request, returns null if not authenticated
 */
export async function getSession(
  request: Request,
  context: AppLoadContext
): Promise<SessionContext | null> {
  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) return null;

  const env = getEnv(context);
  const session = await getSessionKV(env.SESSIONS, sessionId);
  if (!session) return null;

  return { sessionId, session };
}

/**
 * Require authentication - redirects to login if not authenticated
 */
export async function requireSession(
  request: Request,
  context: AppLoadContext
): Promise<SessionContext> {
  const sessionContext = await getSession(request, context);

  if (!sessionContext) {
    const url = new URL(request.url);
    const redirectTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/login?redirect=${redirectTo}`);
  }

  return sessionContext;
}

/**
 * Get user context (session + user profile)
 */
export async function getUserContext(
  request: Request,
  context: AppLoadContext
): Promise<UserContext | null> {
  const sessionContext = await getSession(request, context);
  if (!sessionContext) return null;

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const profile = await getUserById(authEnv, sessionContext.session.user_id);
  if (!profile) return null;

  return {
    ...sessionContext,
    user: toUser(profile),
  };
}

/**
 * Require user context - redirects to login if not authenticated
 */
export async function requireUserContext(
  request: Request,
  context: AppLoadContext
): Promise<UserContext> {
  const userContext = await getUserContext(request, context);

  if (!userContext) {
    const url = new URL(request.url);
    const redirectTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/login?redirect=${redirectTo}`);
  }

  return userContext;
}

/**
 * Get full auth context including org, workspace, and memberships
 */
export async function getAuthContext(
  request: Request,
  context: AppLoadContext
): Promise<AuthContext | null> {
  const userContext = await getUserContext(request, context);
  if (!userContext) return null;

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  // Get current org
  const currentOrg = await getOrg(authEnv, userContext.session.org_id);
  if (!currentOrg) return null;

  // Get user's org memberships
  const orgs = await getUserOrgs(authEnv, userContext.session.user_id);

  // Get workspaces for current org
  const workspaces = await listUserWorkspaces(
    authEnv,
    userContext.session.user_id,
    currentOrg.id
  );

  // Find current workspace
  const currentWorkspace = userContext.session.workspace_id
    ? workspaces.find((ws) => ws.id === userContext.session.workspace_id) || null
    : null;

  return {
    ...userContext,
    currentOrg,
    currentWorkspace,
    orgs,
    workspaces,
  };
}

/**
 * Require full auth context - redirects to login if not authenticated
 */
export async function requireAuthContext(
  request: Request,
  context: AppLoadContext
): Promise<AuthContext> {
  const authContext = await getAuthContext(request, context);

  if (!authContext) {
    const url = new URL(request.url);
    const redirectTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/login?redirect=${redirectTo}`);
  }

  return authContext;
}

/**
 * Require superuser access - redirects to home if not a superuser
 */
export async function requireSuperuser(
  request: Request,
  context: AppLoadContext
): Promise<AuthContext> {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.user.is_superuser) {
    throw redirect('/');
  }

  return authContext;
}

/**
 * Require org admin access
 */
export async function requireOrgAdmin(
  request: Request,
  context: AppLoadContext,
  orgId: string
): Promise<AuthContext> {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const adminStatus = await isOrgAdmin(authEnv, authContext.user.id, orgId);

  if (!adminStatus) {
    throw redirect('/');
  }

  return authContext;
}

/**
 * Require workspace access
 */
export async function requireWorkspaceAccess(
  request: Request,
  context: AppLoadContext,
  workspaceId: string,
  requiredLevel: 'full' | 'read_only' = 'read_only'
): Promise<AuthContext> {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const accessLevel = await getWorkspaceAccess(
    authEnv,
    workspaceId,
    authContext.user.id
  );

  if (accessLevel === 'none') {
    throw redirect('/');
  }

  if (requiredLevel === 'full' && accessLevel !== 'full') {
    throw redirect('/');
  }

  return authContext;
}
