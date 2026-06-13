import { redirect, type AppLoadContext } from "react-router";
import { getEnv } from "./cloudflare.server";
import {
  getSignedSessionFromRequest,
  type SignedSessionData,
} from "./cookies.server";
import { redirectIfBannedSession } from "./ban.server";
import { createSignedSession } from "../../workers/main/src/signed-session";
import type {
  Organization,
  OrgMembership,
  WorkspaceAccessLevel,
  WorkspaceWithAccess,
} from "@/types";
import type { User } from "@/types";
import type { OnboardingPreferences } from "@/types";
import { type AuthEnv, type SessionData, getAuthEnv } from "./auth-helpers";
import {
  getUserOrgs,
  listUserWorkspacesAcrossOrgs,
  listOrgWorkspaces,
  getWorkspace,
} from "./auth-do";
import {
  CLOUDFLARE_ACCESS_AUTH_SOURCE,
  tryCloudflareAccessSilentLogin,
  validateAccessBackedSignedSession,
  type AccessValidationEnv,
  type CloudflareAccessEnv,
} from "./cloudflare-access-auth.server";
import { retryTransientDurableObjectRead } from "./do-rpc-retry.server";

const LOCAL_AUTH_USER_ID = "local-dev-user";
const LOCAL_AUTH_ORG_ID = "local-dev-org";
const LOCAL_AUTH_EMAIL = "local-dev@camelai.local";
const LOCAL_AUTH_NAME = "Local Dev";

// Request-scoped cache for auth context to avoid duplicate DO RPC calls
// when multiple loaders call requireAuthContext() in the same request
const authContextCache = new WeakMap<Request, Promise<AuthContext | null>>();

// Re-export AuthEnv and getAuthEnv for routes that need them
export { getAuthEnv, type AuthEnv } from "./auth-helpers";

export type Session = SessionData;

export interface SessionContext {
  sessionId: string;
  session: Session;
  createdSessionCookie?: string;
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
  /** Total workspaces in org (includes ones user may not have access to) */
  orgWorkspaceCount: number;
  /** Email verification status (bundled from UserDO bootstrap) */
  emailVerification: { required: boolean; verified: boolean };
  /** When set, the session cookie should be re-signed with this token (e.g. workspace fallback) */
  resignedSessionCookie?: string;
}

export interface SessionWorkspaceAccessContext extends SessionContext {
  orgId: string;
  workspaceId: string;
  userId: string;
  access: WorkspaceAccessLevel;
}

async function tryCreateCloudflareAccessSessionContext(
  request: Request,
  context: AppLoadContext,
  env: ReturnType<typeof getEnv>,
): Promise<SessionContext | null> {
  const accessSession = await tryCloudflareAccessSilentLogin(
    request,
    env as unknown as CloudflareAccessEnv,
    getAuthEnv(env),
  );
  if (!accessSession) return null;

  await redirectIfBannedSession(request, context, {
    userId: accessSession.session.user_id,
    userEmail: accessSession.session.user_email,
    orgId: accessSession.session.org_id,
  });

  return {
    sessionId: `signed:${accessSession.session.user_id}`,
    session: accessSession.session,
    createdSessionCookie: accessSession.signedToken,
  };
}

/**
 * Get session from request, returns null if not authenticated.
 * Reads session data from HMAC-signed cookie, then checks UserDO
 * session invalidation to reject tokens issued before a logout.
 */
export async function getSession(
  request: Request,
  context: AppLoadContext,
): Promise<SessionContext | null> {
  const env = getEnv(context);
  const localBypassSession = await getLocalAuthBypassSession(request, context);
  if (localBypassSession) {
    return localBypassSession;
  }

  const signedSession = await getSignedSessionFromRequest(
    request,
    env.TOKEN_SIGNING_SECRET,
  );
  if (!signedSession) {
    return tryCreateCloudflareAccessSessionContext(request, context, env);
  }

  if (signedSession.auth_source === CLOUDFLARE_ACCESS_AUTH_SOURCE) {
    // Read-only revalidation: confirm the live Access identity still maps to
    // the session org without re-running the mutating provisioning flow when
    // the cookie still matches. If it no longer matches, immediately run the
    // silent login path so the current Access identity can replace the stale
    // signed cookie.
    const accessValidation = await validateAccessBackedSignedSession(
      request,
      env as unknown as AccessValidationEnv,
      signedSession,
    );
    if (accessValidation === "unavailable") {
      throw new Response(
        "Cloudflare Access validation is temporarily unavailable",
        { status: 503 },
      );
    }
    if (accessValidation !== "valid") {
      return tryCreateCloudflareAccessSessionContext(request, context, env);
    }
  }

  await redirectIfBannedSession(request, context, {
    userId: signedSession.user_id,
    userEmail: signedSession.user_email,
    orgId: signedSession.org_id,
  });

  // Check if this session was created before a logout invalidation
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(signedSession.user_id),
  );
  const invalidatedAt = await retryTransientDurableObjectRead(
    "UserDO.getSessionInvalidatedAt",
    () => userStub.getSessionInvalidatedAt(),
  );
  if (invalidatedAt && signedSession.created_at < invalidatedAt) {
    return null;
  }

  // Map signed session data to SessionData format (compatible with existing code)
  const session: SessionData = {
    user_id: signedSession.user_id,
    org_id: signedSession.org_id,
    workspace_id: signedSession.workspace_id,
    created_at: signedSession.created_at,
    last_accessed: signedSession.created_at,
    user_name: signedSession.user_name,
    user_email: signedSession.user_email,
    auth_source: signedSession.auth_source ?? null,
  };

  // sessionId is a placeholder — with signed cookies, the cookie IS the session
  return { sessionId: `signed:${signedSession.user_id}`, session };
}

function getRuntimeEnvValue(
  env: Record<string, unknown>,
  key: string,
): string | undefined {
  const bindingValue = env[key];
  if (typeof bindingValue === "string") return bindingValue;

  const processEnv = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  return processEnv?.[key];
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLocalhostRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

async function getLocalAuthBypassSession(
  request: Request,
  context: AppLoadContext,
): Promise<SessionContext | null> {
  const env = getEnv(context);
  if (
    !isLocalhostRequest(request) ||
    !envFlagEnabled(
      getRuntimeEnvValue(
        env as unknown as Record<string, unknown>,
        "LOCAL_AUTH_BYPASS",
      ),
    )
  ) {
    return null;
  }

  const authEnv = getAuthEnv(env);
  const email =
    getRuntimeEnvValue(
      env as unknown as Record<string, unknown>,
      "LOCAL_AUTH_USER_EMAIL",
    ) ??
    LOCAL_AUTH_EMAIL;
  const name =
    getRuntimeEnvValue(
      env as unknown as Record<string, unknown>,
      "LOCAL_AUTH_USER_NAME",
    ) ??
    LOCAL_AUTH_NAME;

  const userStub = authEnv.USER.get(authEnv.USER.idFromName(LOCAL_AUTH_USER_ID));
  let profile = await userStub.getProfile();
  if (!profile) {
    await authEnv.EMAIL_TO_USER.put(
      `email:${email.toLowerCase()}`,
      LOCAL_AUTH_USER_ID,
    );
    await authEnv.EMAIL_TO_USER.put(
      "oauth:github:local-dev",
      LOCAL_AUTH_USER_ID,
    );
    profile = await userStub.createUserFromOAuth(
      LOCAL_AUTH_USER_ID,
      email.toLowerCase(),
      name,
      "github",
      "local-dev",
    );
  }

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(LOCAL_AUTH_ORG_ID));
  let orgInfo: Organization | null = await orgStub.getInfo();
  let workspaceId: string | null = null;

  if (!orgInfo) {
    const created = await orgStub.createOrg(
      LOCAL_AUTH_ORG_ID,
      "Local Dev",
      LOCAL_AUTH_USER_ID,
    );
    orgInfo = created.org;
    workspaceId = created.defaultWorkspaceId;
    await userStub.addOrg(LOCAL_AUTH_ORG_ID, "owner", workspaceId);
  } else {
    const workspaces = await orgStub.getWorkspaces();
    workspaceId =
      workspaces.find((workspace) => !workspace.archived)?.id ?? null;

    if (!(await orgStub.isMember(LOCAL_AUTH_USER_ID))) {
      await orgStub.addMember(LOCAL_AUTH_USER_ID, "owner", LOCAL_AUTH_USER_ID);
    }
    if (!(await userStub.hasOrg(LOCAL_AUTH_ORG_ID))) {
      await userStub.addOrg(LOCAL_AUTH_ORG_ID, "owner", workspaceId);
    }
  }

  if (!orgInfo) {
    return null;
  }

  if (orgInfo.billing_status !== "enterprise") {
    orgInfo = await orgStub.updateBillingState({
      billing_status: "enterprise",
      billing_plan: "enterprise",
      billing_seat_count: Math.max(orgInfo.billing_seat_count ?? 1, 1),
    });
    if (!orgInfo) {
      return null;
    }
  }

  if (workspaceId) {
    const workspaceStub = authEnv.WORKSPACE.get(
      authEnv.WORKSPACE.idFromName(workspaceId),
    );
    await workspaceStub.setMemberAccess(
      LOCAL_AUTH_USER_ID,
      "full",
      LOCAL_AUTH_USER_ID,
    );
    await userStub.setOrgLastWorkspace(LOCAL_AUTH_ORG_ID, workspaceId);
  }

  const onboarding = await userStub.getOnboarding();
  if (!onboarding?.completed_at) {
    await userStub.updateOnboarding({ completed_at: Date.now() });
  }

  const now = Date.now();
  return {
    sessionId: "local-dev",
    session: {
      user_id: profile.id,
      org_id: orgInfo.id,
      workspace_id: workspaceId,
      created_at: now,
      last_accessed: now,
      user_name: profile.name,
      user_email: profile.email,
    },
  };
}

/**
 * Require authentication - redirects to login if not authenticated
 */
export async function requireSession(
  request: Request,
  context: AppLoadContext,
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
 * Require workspace access using session + targeted DO checks (no full auth context).
 */
export async function requireSessionWorkspaceAccess(
  request: Request,
  context: AppLoadContext,
  workspaceIdOverride?: string,
  options: { requireWrite?: boolean } = {},
): Promise<SessionWorkspaceAccessContext> {
  const sessionContext = await requireSession(request, context);
  const { session } = sessionContext;
  const orgId = session.org_id;
  const workspaceId = workspaceIdOverride ?? session.workspace_id;
  const userId = session.user_id;

  if (!orgId) {
    throw Response.json({ error: "No organization selected" }, { status: 400 });
  }
  if (!workspaceId) {
    throw Response.json({ error: "No workspace selected" }, { status: 400 });
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const wsStub = authEnv.WORKSPACE.get(
    authEnv.WORKSPACE.idFromName(workspaceId),
  );
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));

  const [workspaceInfo, memberAccess, isMember] = await Promise.all([
    wsStub.getInfo(),
    wsStub.getMemberAccess(userId),
    orgStub.isMember(userId),
  ]);

  if (
    !workspaceInfo ||
    workspaceInfo.archived ||
    workspaceInfo.org_id !== orgId
  ) {
    throw Response.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (!isMember) {
    throw Response.json({ error: "Workspace not found" }, { status: 404 });
  }

  const access = memberAccess?.access_level ?? "full";
  if (access === "none") {
    throw Response.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (options.requireWrite && access !== "full") {
    throw Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return {
    ...sessionContext,
    orgId,
    workspaceId,
    userId,
    access,
  };
}

/**
 * Get user context (session + user profile)
 */
export async function getUserContext(
  request: Request,
  context: AppLoadContext,
): Promise<UserContext | null> {
  const sessionContext = await getSession(request, context);
  if (!sessionContext) return null;

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const profile = await retryTransientDurableObjectRead(
    "UserDO.getProfile",
    () =>
      authEnv.USER.get(
        authEnv.USER.idFromName(sessionContext.session.user_id),
      ).getProfile(),
  );
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
  context: AppLoadContext,
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
  context: AppLoadContext,
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
  context: AppLoadContext,
): Promise<AuthContext | null> {
  const sessionContext = await getSession(request, context);
  if (!sessionContext) {
    console.warn("[auth] getAuthContext returning null: no session");
    return null;
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(sessionContext.session.user_id),
  );
  const currentOrgStub = authEnv.ORG.get(
    authEnv.ORG.idFromName(sessionContext.session.org_id),
  );
  const currentOrgInfoPromise = retryTransientDurableObjectRead(
    "OrgDO.getInfo",
    () => currentOrgStub.getInfo(),
  );
  const currentOrgMemberPromise = retryTransientDurableObjectRead(
    "OrgDO.getMember",
    () => currentOrgStub.getMember(sessionContext.session.user_id),
  );
  const [authBootstrap, orgInfo, currentOrgMember] = await Promise.all([
    retryTransientDurableObjectRead("UserDO.getAuthBootstrap", () =>
      userStub.getAuthBootstrap(),
    ),
    currentOrgInfoPromise,
    currentOrgMemberPromise,
  ]);
  const profile = authBootstrap.profile;
  if (!profile) {
    console.warn("[auth] getAuthContext returning null: profile is null", {
      user_id: sessionContext.session.user_id,
      org_id: sessionContext.session.org_id,
      workspace_id: sessionContext.session.workspace_id,
    });
    return null;
  }
  if (!orgInfo) {
    console.warn("[auth] getAuthContext returning null: orgInfo is null", {
      user_id: sessionContext.session.user_id,
      org_id: sessionContext.session.org_id,
    });
    return null;
  }

  // Check if this session was created before a logout invalidation
  if (
    authBootstrap.sessionInvalidatedAt &&
    sessionContext.session.created_at < authBootstrap.sessionInvalidatedAt
  ) {
    console.warn("[auth] getAuthContext returning null: session invalidated", {
      user_id: sessionContext.session.user_id,
      session_created_at: sessionContext.session.created_at,
      invalidated_at: authBootstrap.sessionInvalidatedAt,
    });
    return null;
  }
  const currentOrg: Organization = orgInfo;
  const onboarding = authBootstrap.onboarding;
  let orgs = await getUserOrgs(authEnv, sessionContext.session.user_id, {
    preloadedUserOrgs: authBootstrap.orgs,
    preloadedOrgInfoById: new Map([
      [sessionContext.session.org_id, currentOrgInfoPromise],
    ]),
  });

  // OrgDO is the source of truth for role checks. If UserDO role data is stale
  // for the active org, reconcile it in-memory so current request permissions/UI
  // reflect the effective org role.
  if (currentOrgMember) {
    const currentOrgIndex = orgs.findIndex(
      (membership) => membership.org_id === currentOrg.id,
    );
    if (currentOrgIndex === -1) {
      orgs = [
        ...orgs,
        {
          org_id: currentOrg.id,
          org_name: currentOrg.name,
          role: currentOrgMember.role,
          joined_at: currentOrgMember.joined_at,
          last_workspace_id: null,
        },
      ];
    } else if (orgs[currentOrgIndex].role !== currentOrgMember.role) {
      orgs = orgs.map((membership, index) =>
        index === currentOrgIndex
          ? {
              ...membership,
              role: currentOrgMember.role,
            }
          : membership,
      );
    }
  }

  const userContext: UserContext = {
    ...sessionContext,
    user: profile,
  };

  // Get all workspaces across all orgs (for workspace switcher).
  let allWorkspaces = await listUserWorkspacesAcrossOrgs(
    authEnv,
    sessionContext.session.user_id,
    orgs,
  );

  // Workspaces in the current org only (for settings/management).
  // Derive from allWorkspaces to avoid duplicate current-org RPC traversal.
  let workspaces = allWorkspaces.filter((ws) => ws.org_id === currentOrg.id);

  // Check if org has workspaces the user can't access (only when user has none)
  let orgWorkspaceCount = workspaces.length;
  if (workspaces.length === 0) {
    try {
      const allOrgWorkspaces = await listOrgWorkspaces(authEnv, currentOrg.id);
      orgWorkspaceCount = allOrgWorkspaces.length;
    } catch (error) {
      console.warn("[auth] failed to count current org workspaces", {
        user_id: sessionContext.session.user_id,
        org_id: currentOrg.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Select current workspace - must be from current org to maintain consistency
  // If no workspaces in current org, currentWorkspace will be null and UI shows NoWorkspacesError
  const sessionWorkspaceId = sessionContext.session.workspace_id;
  let sessionWorkspaceStillValid = sessionWorkspaceId
    ? workspaces.some((ws) => ws.id === sessionWorkspaceId)
    : false;

  if (sessionWorkspaceId && !sessionWorkspaceStillValid) {
    try {
      const sessionWorkspace = await getWorkspace(authEnv, sessionWorkspaceId);
      if (sessionWorkspace?.org_id === currentOrg.id) {
        const workspaceWithAccess: WorkspaceWithAccess = {
          ...sessionWorkspace,
          access_level: "full",
        };
        allWorkspaces = [
          ...allWorkspaces.filter((ws) => ws.id !== workspaceWithAccess.id),
          workspaceWithAccess,
        ];
        workspaces = [
          ...workspaces.filter((ws) => ws.id !== workspaceWithAccess.id),
          workspaceWithAccess,
        ];
        orgWorkspaceCount = Math.max(orgWorkspaceCount, workspaces.length);
        sessionWorkspaceStillValid = true;
      }
    } catch (error) {
      console.warn("[auth] failed to load session workspace fallback", {
        user_id: sessionContext.session.user_id,
        org_id: currentOrg.id,
        workspace_id: sessionWorkspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const currentWorkspace = sessionWorkspaceStillValid
    ? workspaces.find((ws) => ws.id === sessionWorkspaceId)!
    : (workspaces[0] ?? null);

  // Re-sign session cookie if workspace changed (stale session or fallback)
  const newWorkspaceId = currentWorkspace?.id ?? null;
  let resignedSessionCookie: string | undefined =
    sessionContext.createdSessionCookie;
  if (newWorkspaceId !== sessionWorkspaceId) {
    resignedSessionCookie = await createSignedSession(
      env.TOKEN_SIGNING_SECRET,
      {
        user_id: sessionContext.session.user_id,
        org_id: sessionContext.session.org_id,
        workspace_id: newWorkspaceId,
        created_at: sessionContext.session.created_at,
        user_name: sessionContext.session.user_name,
        user_email: sessionContext.session.user_email,
        auth_source: sessionContext.session.auth_source ?? null,
      },
    );
  }

  return {
    ...userContext,
    currentOrg,
    currentWorkspace,
    orgs,
    onboarding,
    workspaces,
    allWorkspaces,
    orgWorkspaceCount,
    emailVerification: authBootstrap.emailVerification,
    resignedSessionCookie,
  };
}

/**
 * Require full auth context - redirects to login if not authenticated
 */
export async function requireAuthContext(
  request: Request,
  context: AppLoadContext,
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
  context: AppLoadContext,
): Promise<AuthContext> {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.user.is_superuser) {
    throw redirect("/");
  }

  return authContext;
}

// TODO: Viewer role (deferred): When viewer role enforcement is added, route guards
// should deny viewers access to chat, connections, and any write operations.
// Viewers should only be able to view workspace apps (including private/unpublished ones).
// See the OrgRole type in types.ts for the full planned behavior.

/**
 * Require org admin access
 */
export async function requireOrgAdmin(
  request: Request,
  context: AppLoadContext,
  orgId: string,
): Promise<AuthContext> {
  const authContext = await requireAuthContext(request, context);

  const userOrg = authContext.orgs.find((o) => o.org_id === orgId);
  const cachedIsAdmin = userOrg?.role === "owner" || userOrg?.role === "admin";

  if (cachedIsAdmin) {
    return authContext;
  }

  // Fallback to OrgDO authority when UserDO org role data is stale.
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const effectiveIsAdmin = await orgStub.isAdmin(authContext.user.id);

  if (!effectiveIsAdmin) {
    throw redirect("/");
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
  requiredLevel: "full" | "any" = "any",
): Promise<AuthContext> {
  const authContext = await requireAuthContext(request, context);

  // Check if workspace exists in user's accessible workspaces
  const workspace = authContext.allWorkspaces.find(
    (ws) => ws.id === workspaceId,
  );
  if (!workspace) {
    throw redirect("/");
  }

  // Workspace access is assumed 'full' by default during auth context load.
  // For routes that require workspace access, we check for explicit 'none' restrictions.
  // Since restrictions are rare (default is 'full'), this single RPC call is cheaper
  // than checking N workspaces during every auth context load.
  const env = getEnv(context);
  const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const memberAccess = await wsStub.getMemberAccess(authContext.user.id);
  const accessLevel = memberAccess?.access_level ?? "full";

  if (accessLevel === "none") {
    throw redirect("/");
  }

  if (requiredLevel === "full" && accessLevel !== "full") {
    throw redirect("/");
  }

  return authContext;
}
