/**
 * Access for the routes of threads that run directly on the hosted agent
 * runtime (plans/runtime-threads-direct.md §4.1): the session, then one
 * OrgDO call that checks the user may use the thread (member, full workspace
 * access, thread in workspace) and returns its runtime row.
 */
import type { AppLoadContext } from "react-router";
import { requireSession } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import type { ChatContextState, ChatEnv } from "../../workers/main/src/chat-thread/types";
import type { OrgChatWebSocketAccessResult, ThreadRuntimeRecord } from "../../workers/main/src/identity/org-do";
import type { RuntimeThreadSender } from "../../workers/main/src/agent-runtime/thread-runtime";

export interface RuntimeThreadAccess {
  env: ChatEnv;
  context: ChatContextState;
  sender: RuntimeThreadSender;
  /** Null for a thread that runs on ChatThreadDO. */
  row: ThreadRuntimeRecord | null;
}

function json(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * The caller's access to `threadId` in `workspaceId` (default: the session's
 * workspace). Throws a JSON Response (400/403/404) when there is none.
 */
export async function requireRuntimeThreadAccess(
  request: Request,
  loadContext: AppLoadContext,
  threadId: string | undefined,
  workspaceId?: string | null,
): Promise<RuntimeThreadAccess> {
  const { session } = await requireSession(request, loadContext);
  const id = threadId?.trim();
  if (!id) throw json("Thread ID required", 400);
  const orgId = session.org_id;
  const workspace = workspaceId?.trim() || session.workspace_id;
  if (!orgId || !workspace) throw json("No workspace selected", 400);
  const env = getEnv(loadContext);
  const authEnv = getAuthEnv(env);
  const access = (await authEnv.ORG.get(authEnv.ORG.idFromName(orgId))
    .validateChatWebSocketAccess(session.user_id, workspace, id)) as OrgChatWebSocketAccessResult;
  if (!access.ok) {
    if (access.reason === "forbidden") throw json("Forbidden", 403);
    throw json(access.reason === "thread_not_found" ? "Thread not found" : "Workspace not found", 404);
  }
  return {
    env: env as unknown as ChatEnv,
    context: {
      threadId: id,
      workspaceId: access.workspaceId,
      orgId: access.orgId,
      userId: session.user_id,
      userName: session.user_name ?? null,
      userEmail: session.user_email ?? null,
    },
    sender: {
      userId: session.user_id,
      userName: session.user_name ?? null,
      userEmail: session.user_email ?? null,
    },
    row: access.runtime ?? null,
  };
}

/** As requireRuntimeThreadAccess, for a thread that must run on the runtime (409 otherwise). */
export async function requireRuntimeThread(
  request: Request,
  loadContext: AppLoadContext,
  threadId: string | undefined,
  workspaceId?: string | null,
): Promise<RuntimeThreadAccess & { row: ThreadRuntimeRecord }> {
  const access = await requireRuntimeThreadAccess(request, loadContext, threadId, workspaceId);
  if (!access.row) throw json("This thread does not run on the agent runtime", 409);
  return access as RuntimeThreadAccess & { row: ThreadRuntimeRecord };
}

/** A route's workspace: `workspaceId` from the query or JSON body, when the tab's workspace is not the session's. */
export function requestWorkspaceId(request: Request, body?: unknown): string | null {
  const fromQuery = new URL(request.url).searchParams.get("workspaceId");
  if (fromQuery?.trim()) return fromQuery.trim();
  const fromBody = body && typeof body === "object" ? (body as { workspaceId?: unknown }).workspaceId : undefined;
  return typeof fromBody === "string" && fromBody.trim() ? fromBody.trim() : null;
}
