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

export async function requireSession(
  req: Request,
  env: Env,
): Promise<AuthResult> {
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
