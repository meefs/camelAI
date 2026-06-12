/**
 * Authentication and authorization helpers
 */

import type { Env } from "../types.js";
import type { SessionData } from "../session-kv.js";
import type { WorkspaceDO } from "../workspace.js";
import type { OrgDO, UserDO } from "../auth.js";
import { getSignedSessionFromRequest } from "../cookies.js";
import {
  normalizePathForObservability,
  recordErrorEvent,
  recordObservabilityEvent,
} from "../observability.js";
import { text } from "./response.js";
import { getWorkspaceStub, getOrgStub } from "./stubs.js";
import { isOrgBanned, isUserBanned } from "../ban-list.js";
import {
  isTransientDurableObjectRpcError,
  retryTransientDurableObjectRpc,
} from "../../../../src/lib/do-rpc-retry.server";

export type AuthResult = { session: SessionData } | { error: Response };

const CHAT_WS_AUTH_RPC_TIMEOUT_MS = 2_000;

class ChatWebSocketAuthRpcTimeoutError extends Error {
  // Picked up by isTransientDurableObjectRpcError so timeouts retry and
  // degrade like dropped RPC channels instead of failing closed.
  retryable = true;

  constructor(operation: string) {
    super(`Durable Object RPC timed out: ${operation}`);
    this.name = "ChatWebSocketAuthRpcTimeoutError";
  }
}

function chatWsAuthRpc<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  return retryTransientDurableObjectRpc(operation, () => {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ChatWebSocketAuthRpcTimeoutError(operation));
      }, CHAT_WS_AUTH_RPC_TIMEOUT_MS);
      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  });
}

const LOCAL_AUTH_USER_ID = "local-dev-user";
const LOCAL_AUTH_ORG_ID = "local-dev-org";
const LOCAL_AUTH_EMAIL = "local-dev@camelai.local";
const LOCAL_AUTH_NAME = "Local Dev";

export async function requireSession(
  req: Request,
  env: Env,
  options: { failOpenOnInvalidationCheckError?: boolean } = {},
): Promise<AuthResult> {
  const localBypassSession = await getLocalAuthBypassSession(req, env);
  if (localBypassSession) {
    return { session: localBypassSession };
  }

  const signedSession = await getSignedSessionFromRequest(
    req,
    env.TOKEN_SIGNING_SECRET,
  );
  if (!signedSession) return { error: text("Unauthorized", 401) };

  const [userBan, orgBan] = await Promise.all([
    isUserBanned(env.APP_KV, {
      userId: signedSession.user_id,
      email: signedSession.user_email,
    }),
    signedSession.org_id
      ? isOrgBanned(env.APP_KV, { orgId: signedSession.org_id })
      : Promise.resolve(null),
  ]);
  if (userBan || orgBan) {
    return { error: text("Blocked", 403) };
  }

  // Check if this session was created before a logout invalidation
  const userNs = env.USER as DurableObjectNamespace<UserDO>;
  let invalidatedAt: number | null;
  if (options.failOpenOnInvalidationCheckError) {
    try {
      invalidatedAt = await chatWsAuthRpc("UserDO.getSessionInvalidatedAt", () =>
        userNs
          .get(userNs.idFromName(signedSession.user_id))
          .getSessionInvalidatedAt(),
      );
    } catch (error) {
      if (!isTransientDurableObjectRpcError(error)) {
        // Only DO unavailability justifies failing open; an application
        // error must keep the pre-existing fail-closed behavior, or a
        // "log out everywhere" revocation would be ignored until the bug
        // is fixed.
        throw error;
      }
      // Fail open: the session cookie signature was already verified locally.
      // This check only enforces "log out everywhere" revocation, and blocking
      // every chat connection during a transient DO outage is worse than
      // honoring a signed session for the duration of the blip.
      invalidatedAt = null;
      recordObservabilityEvent(env, {
        event: "session_invalidation_check_failed_open",
        severity: "warn",
        component: "auth",
        operation: "requireSession",
        status: "fail_open",
        userId: signedSession.user_id,
        errorName: error instanceof Error ? error.name : "Error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    invalidatedAt = await userNs
      .get(userNs.idFromName(signedSession.user_id))
      .getSessionInvalidatedAt();
  }
  if (invalidatedAt && signedSession.created_at < invalidatedAt) {
    return { error: text("Unauthorized", 401) };
  }

  // Map to SessionData format for compatibility
  const session: SessionData = {
    user_id: signedSession.user_id,
    org_id: signedSession.org_id,
    workspace_id: signedSession.workspace_id,
    created_at: signedSession.created_at,
    last_accessed: signedSession.created_at,
    user_name: signedSession.user_name,
    user_email: signedSession.user_email,
  };

  return { session };
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLocalhostRequest(req: Request): boolean {
  const hostname = new URL(req.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

async function getLocalAuthBypassSession(
  req: Request,
  env: Env,
): Promise<SessionData | null> {
  if (!isLocalhostRequest(req) || !envFlagEnabled(env.LOCAL_AUTH_BYPASS)) {
    return null;
  }

  const email = (env.LOCAL_AUTH_USER_EMAIL || LOCAL_AUTH_EMAIL).toLowerCase();
  const name = env.LOCAL_AUTH_USER_NAME || LOCAL_AUTH_NAME;
  const userNs = env.USER as DurableObjectNamespace<UserDO>;
  const orgNs = env.ORG as DurableObjectNamespace<OrgDO>;
  const workspaceNs = env.WORKSPACE as DurableObjectNamespace<WorkspaceDO>;

  const userStub = userNs.get(userNs.idFromName(LOCAL_AUTH_USER_ID));
  let profile = await userStub.getProfile();
  if (!profile) {
    await env.EMAIL_TO_USER.put(`email:${email}`, LOCAL_AUTH_USER_ID);
    await env.EMAIL_TO_USER.put("oauth:github:local-dev", LOCAL_AUTH_USER_ID);
    profile = await userStub.createUserFromOAuth(
      LOCAL_AUTH_USER_ID,
      email,
      name,
      "github",
      "local-dev",
    );
  }

  const orgStub = orgNs.get(orgNs.idFromName(LOCAL_AUTH_ORG_ID));
  let orgInfo = await orgStub.getInfo();
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

  if (workspaceId) {
    const workspaceStub = workspaceNs.get(workspaceNs.idFromName(workspaceId));
    await workspaceStub.setMemberAccess(
      LOCAL_AUTH_USER_ID,
      "full",
      LOCAL_AUTH_USER_ID,
    );
    await userStub.setOrgLastWorkspace(LOCAL_AUTH_ORG_ID, workspaceId);
  }

  if (orgInfo.billing_status !== "enterprise") {
    const updatedOrgInfo = await orgStub.updateBillingState({
      billing_status: "enterprise",
      billing_plan: "enterprise",
      billing_seat_count: Math.max(orgInfo.billing_seat_count ?? 1, 1),
    });
    if (!updatedOrgInfo) {
      return null;
    }
    orgInfo = updatedOrgInfo;
  }

  const onboarding = await userStub.getOnboarding();
  if (!onboarding?.completed_at) {
    await userStub.updateOnboarding({ completed_at: Date.now() });
  }

  const now = Date.now();
  return {
    user_id: profile.id,
    org_id: orgInfo.id,
    workspace_id: workspaceId,
    created_at: now,
    last_accessed: now,
    user_name: profile.name,
    user_email: profile.email,
  };
}

export interface WorkspaceAccess {
  session: SessionData;
  orgId: string;
  workspaceId: string;
  userId: string;
  wsStub: WorkspaceDO;
  orgStub: OrgDO;
  /** Workspace info - already fetched during auth, avoid re-fetching */
  wsInfo: Awaited<ReturnType<WorkspaceDO["getInfo"]>> & {};
  /** Organization info - already fetched during auth, avoid re-fetching */
  orgInfo: Awaited<ReturnType<OrgDO["getInfo"]>> & {};
}

export type WorkspaceAccessResult = WorkspaceAccess | { error: Response };

export interface ChatWebSocketAccess {
  session: SessionData;
  orgId: string;
  orgSlug: string;
  workspaceId: string;
  userId: string;
  wsStub: WorkspaceDO;
  threadId: string;
}

/**
 * Returned when the user has a valid signed session but the authorization
 * Durable Objects (WorkspaceDO/OrgDO) were unreachable after retries. The
 * route may forward the upgrade to ChatThreadDO marked as degraded; the DO
 * only admits users it has previously seen pass full authorization for the
 * same thread.
 */
export interface ChatWebSocketDegradedAccess {
  degraded: true;
  session: SessionData;
  userId: string;
  threadId: string;
}

export type ChatWebSocketAccessResult =
  | ChatWebSocketAccess
  | ChatWebSocketDegradedAccess
  | { error: Response };

export async function requireWorkspaceAccess(
  req: Request,
  env: Env,
): Promise<WorkspaceAccessResult> {
  const auth = await requireSession(req, env);
  if ("error" in auth) return auth;

  const { session } = auth;
  const { org_id: orgId, workspace_id: workspaceId, user_id: userId } = session;

  if (!orgId) return { error: text("No organization selected", 400) };
  if (!workspaceId) return { error: text("No workspace selected", 400) };

  try {
    const wsStub = getWorkspaceStub(env, workspaceId);
    const wsInfo = await wsStub.getInfo();
    if (!wsInfo || wsInfo.archived)
      return { error: text("Workspace not found", 404) };

    const orgStub = getOrgStub(env, wsInfo.org_id);
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo || orgInfo.archived)
      return { error: text("Organization not found", 404) };

    if (!(await orgStub.isMember(userId)))
      return { error: text("Forbidden", 403) };

    const memberAccess = await wsStub.getMemberAccess(userId);
    if ((memberAccess?.access_level ?? "full") !== "full") {
      return { error: text("Forbidden", 403) };
    }

    return {
      session,
      orgId,
      workspaceId,
      userId,
      wsStub,
      orgStub,
      wsInfo,
      orgInfo,
    };
  } catch {
    return { error: text("Forbidden", 403) };
  }
}

export async function requireChatWebSocketAccess(
  req: Request,
  env: Env,
  threadId: string,
  workspaceIdFromUrl?: string | null,
): Promise<ChatWebSocketAccessResult> {
  const requestId = req.headers.get("cf-ray") ?? crypto.randomUUID();
  const path = normalizePathForObservability(new URL(req.url).pathname);
  const recordDenied = (
    status: string,
    statusCode: number,
    details: {
      orgId?: string | null;
      workspaceId?: string | null;
      userId?: string | null;
      errorMessage?: string | null;
    } = {},
  ) => {
    recordObservabilityEvent(env, {
      event: "chat_ws_access_denied",
      severity: statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info",
      component: "auth",
      operation: "requireChatWebSocketAccess",
      status,
      method: req.method,
      path,
      threadId,
      workspaceId: details.workspaceId ?? null,
      orgId: details.orgId ?? null,
      userId: details.userId ?? null,
      requestId,
      statusCode,
      errorMessage: details.errorMessage ?? null,
      sampleIndex: threadId,
    });
  };
  const auth = await requireSession(req, env, {
    failOpenOnInvalidationCheckError: true,
  });
  if ("error" in auth) {
    const statusCode = auth.error.status || 401;
    recordDenied(
      statusCode === 401
        ? "unauthorized"
        : statusCode === 403
          ? "forbidden"
          : "auth_error",
      statusCode,
      { errorMessage: auth.error.statusText || null },
    );
    return auth;
  }

  const { session } = auth;
  const { org_id: sessionOrgId, user_id: userId } = session;

  // Authorize against the workspace the tab is actually connected to (from
  // the /ws/:workspace URL), not the session's currently-selected workspace.
  // The session selection is a shared per-browser cookie that other tabs
  // mutate; using it here breaks open threads in other workspaces/orgs.
  const workspaceId =
    workspaceIdFromUrl?.trim() || session.workspace_id || "";
  if (!workspaceId) {
    recordDenied("missing_workspace", 400, { orgId: sessionOrgId, userId });
    return { error: text("No workspace selected", 400) };
  }

  try {
    const wsStub = getWorkspaceStub(env, workspaceId);
    const { info: wsInfo, memberAccess } = await chatWsAuthRpc(
      "WorkspaceDO.getInfoAndMemberAccess",
      () => wsStub.getInfoAndMemberAccess(userId),
    );

    if (!wsInfo || wsInfo.archived) {
      recordDenied("workspace_not_found", 404, {
        orgId: sessionOrgId,
        workspaceId,
        userId,
      });
      return { error: text("Workspace not found", 404) };
    }

    // Deny on known restricted access before any further RPC: if the org
    // call below fails transiently we degrade, and a denial we already hold
    // must never be converted into a degraded (fail-open) upgrade.
    if ((memberAccess?.access_level ?? "full") !== "full") {
      recordDenied("member_access_forbidden", 403, {
        orgId: wsInfo.org_id,
        workspaceId,
        userId,
      });
      return { error: text("Forbidden", 403) };
    }

    const orgId = wsInfo.org_id;
    const orgStub = getOrgStub(env, orgId);
    const orgValidation = await chatWsAuthRpc(
      "OrgDO.validateChatThreadAccess",
      () => orgStub.validateChatThreadAccess(userId, wsInfo.id, threadId),
    );

    if (!orgValidation.ok) {
      const status =
        orgValidation.reason === "org_not_found"
          ? "org_not_found"
          : orgValidation.reason === "thread_not_found"
            ? "thread_not_found"
            : "forbidden";
      const statusCode =
        orgValidation.reason === "org_not_found" ||
        orgValidation.reason === "thread_not_found"
          ? 404
          : 403;
      recordDenied(status, statusCode, {
        orgId,
        workspaceId,
        userId,
      });
      switch (orgValidation.reason) {
        case "org_not_found":
          return { error: text("Workspace not found", 404) };
        case "thread_not_found":
          return { error: text("Thread not found", 404) };
        case "forbidden":
        default:
          return { error: text("Forbidden", 403) };
      }
    }

    return {
      session,
      orgId: orgValidation.orgId,
      orgSlug: orgValidation.orgSlug,
      workspaceId: wsInfo.id,
      userId,
      wsStub,
      threadId: orgValidation.threadId,
    };
  } catch (error) {
    if (isTransientDurableObjectRpcError(error)) {
      // The authorization DOs are unreachable, not denying access. Fall back
      // to degraded auth: the session is verified, and ChatThreadDO will only
      // admit users it has already seen pass full authorization.
      recordObservabilityEvent(env, {
        event: "chat_ws_auth_degraded",
        severity: "warn",
        component: "auth",
        operation: "requireChatWebSocketAccess",
        status: "degraded",
        method: req.method,
        path,
        threadId,
        workspaceId,
        orgId: sessionOrgId,
        userId,
        requestId,
        errorName: error instanceof Error ? error.name : "Error",
        errorMessage: error instanceof Error ? error.message : String(error),
        sampleIndex: threadId,
      });
      return { degraded: true, session, userId, threadId };
    }
    recordErrorEvent(env, {
      event: "chat_ws_access_failed",
      component: "auth",
      operation: "requireChatWebSocketAccess",
      status: "exception",
      method: req.method,
      path,
      threadId,
      workspaceId,
      orgId: sessionOrgId,
      userId,
      requestId,
      sampleIndex: threadId,
      error,
    });
    return { error: text("Forbidden", 403) };
  }
}
