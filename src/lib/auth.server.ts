import { redirect, type AppLoadContext } from 'react-router';
import { getEnv } from './cloudflare.server';
import { getSessionIdFromRequest } from './cookies.server';
import { getSession as getSessionKV, updateSession } from '../../workers/main/src/session-kv';
import type { Organization, OrgMembership, WorkspaceWithAccess } from '@/types';
import type { User } from '@/types';
import type { OnboardingPreferences } from '@/types';
import { type AuthEnv, type SessionData, getAuthEnv } from './auth-helpers';
import { getUserOrgs, listUserWorkspacesAcrossOrgs, isOrgAdmin, getWorkspaceAccess } from './auth-do';

// Request-scoped cache for auth context to avoid duplicate DO RPC calls
// when multiple loaders call requireAuthContext() in the same request
const authContextCache = new WeakMap<Request, Promise<AuthContext | null>>();

// Re-export AuthEnv and getAuthEnv for routes that need them
export { getAuthEnv, type AuthEnv } from './auth-helpers';

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
  onboarding: OnboardingPreferences | null;
  /** Workspaces in the current org only (for settings/management) */
  workspaces: WorkspaceWithAccess[];
  /** All workspaces across all orgs (for workspace switcher) */
  allWorkspaces: WorkspaceWithAccess[];
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
  const profile = await authEnv.USER.get(authEnv.USER.idFromName(sessionContext.session.user_id)).getProfile();
  if (!profile) return null;

  return {
    ...sessionContext,
    user: profile,
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
 * Get full auth context including org, workspace, and memberships.
 * Uses request-scoped caching to avoid duplicate DO RPC calls when
 * multiple loaders call this in the same request.
 */
export async function getAuthContext(
  request: Request,
  context: AppLoadContext
): Promise<AuthContext | null> {
  // Check cache first - returns the same promise if already in flight
  const cached = authContextCache.get(request);
  if (cached !== undefined) {
    return cached;
  }

  // Create and cache the promise immediately to dedupe concurrent calls
  const promise = getAuthContextUncached(request, context);
  authContextCache.set(request, promise);
  return promise;
}

/**
 * Internal uncached implementation of getAuthContext
 */
async function getAuthContextUncached(
  request: Request,
  context: AppLoadContext
): Promise<AuthContext | null> {
  const sessionContext = await getSession(request, context);
  if (!sessionContext) return null;

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(sessionContext.session.user_id)
  );
  const currentOrgStub = authEnv.ORG.get(
    authEnv.ORG.idFromName(sessionContext.session.org_id)
  );
  const currentOrgInfoPromise = currentOrgStub.getInfo();
  const [authBootstrap, orgInfo] = await Promise.all([
    userStub.getAuthBootstrap(),
    // Get current org info directly from DO
    currentOrgInfoPromise,
  ]);
  const profile = authBootstrap.profile;
  if (!profile) return null;
  if (!orgInfo) return null;
  const currentOrg: Organization = orgInfo;
  const onboarding = authBootstrap.onboarding;
  const orgs = await getUserOrgs(authEnv, sessionContext.session.user_id, {
    preloadedUserOrgs: authBootstrap.orgs,
    preloadedOrgInfoById: new Map([
      [sessionContext.session.org_id, currentOrgInfoPromise],
    ]),
  });

  const userContext: UserContext = {
    ...sessionContext,
    user: profile,
  };

  // Get all workspaces across all orgs (for workspace switcher)
  const allWorkspaces = await listUserWorkspacesAcrossOrgs(
    authEnv,
    userContext.session.user_id,
    orgs
  );

  // Workspaces in the current org only (for settings/management).
  // Derive from allWorkspaces to avoid duplicate current-org RPC traversal.
  const workspaces = allWorkspaces.filter((ws) => ws.org_id === currentOrg.id);

  // Select current workspace - must be from current org to maintain consistency
  // If no workspaces in current org, currentWorkspace will be null and UI shows NoWorkspacesError
  const sessionWorkspaceId = sessionContext.session.workspace_id;
  const sessionWorkspaceStillValid = sessionWorkspaceId
    ? workspaces.some((ws) => ws.id === sessionWorkspaceId)
    : false;

  const currentWorkspace = sessionWorkspaceStillValid
    ? workspaces.find((ws) => ws.id === sessionWorkspaceId)!
    : workspaces[0] ?? null;

  // Sync session if workspace changed (stale session.workspace_id or fallback to first workspace)
  const newWorkspaceId = currentWorkspace?.id ?? null;
  if (newWorkspaceId !== sessionWorkspaceId) {
    // Update session in background - don't block the response
    void updateSession(env.SESSIONS, sessionContext.sessionId, {
      ...sessionContext.session,
      workspace_id: newWorkspaceId,
      last_accessed: Date.now(),
    });
  }

  return {
    ...userContext,
    currentOrg,
    currentWorkspace,
    orgs,
    onboarding,
    workspaces,
    allWorkspaces,
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
