/**
 * Authentication and authorization helpers
 */

import type { Env } from "../types.js";
import type { SessionData } from "../session-kv.js";
import type { WorkspaceDO } from "../workspace.js";
import type { OrgDO, UserDO } from "../auth.js";
import { getSignedSessionFromRequest } from "../cookies.js";
import { text } from "./response.js";
import { getWorkspaceStub, getOrgStub } from "./stubs.js";
import { isOrgBanned, isUserBanned } from "../ban-list.js";

export type AuthResult = { session: SessionData } | { error: Response };

const LOCAL_AUTH_USER_ID = "local-dev-user";
const LOCAL_AUTH_ORG_ID = "local-dev-org";
const LOCAL_AUTH_EMAIL = "local-dev@camelai.local";
const LOCAL_AUTH_NAME = "Local Dev";

export async function requireSession(
  req: Request,
  env: Env,
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
  const invalidatedAt = await userNs
    .get(userNs.idFromName(signedSession.user_id))
    .getSessionInvalidatedAt();
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

export type ChatWebSocketAccessResult =
  | ChatWebSocketAccess
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
): Promise<ChatWebSocketAccessResult> {
  const auth = await requireSession(req, env);
  if ("error" in auth) return auth;

  const { session } = auth;
  const { org_id: orgId, workspace_id: workspaceId, user_id: userId } = session;

  if (!orgId) return { error: text("No organization selected", 400) };
  if (!workspaceId) return { error: text("No workspace selected", 400) };

  try {
    const wsStub = getWorkspaceStub(env, workspaceId);
    const orgStub = getOrgStub(env, orgId);
    const [{ info: wsInfo, memberAccess }, orgValidation] = await Promise.all([
      wsStub.getInfoAndMemberAccess(userId),
      orgStub.validateChatThreadAccess(userId, workspaceId, threadId),
    ]);

    if (!wsInfo || wsInfo.archived) {
      return { error: text("Workspace not found", 404) };
    }
    if (wsInfo.org_id !== orgId) {
      return { error: text("Forbidden", 403) };
    }

    if (!orgValidation.ok) {
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

    if ((memberAccess?.access_level ?? "full") !== "full") {
      return { error: text("Forbidden", 403) };
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
  } catch {
    return { error: text("Forbidden", 403) };
  }
}
