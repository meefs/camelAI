import type { ActionFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import { mintRuntimeBrowserToken } from "../../../workers/main/src/agent-runtime/thread-runtime";

/**
 * POST /api/threads/:id/token: a short-lived, read-only token the browser
 * watches the thread's runtime agent with (events, state, history, inputs).
 * 404 until the thread's first message created its agent.
 */
export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { env, sender, row } = await requireRuntimeThread(request, context, params.id, requestWorkspaceId(request));
  if (!row.agentId) {
    return Response.json({ error: "The thread has no agent yet" }, { status: 404 });
  }
  const token = await mintRuntimeBrowserToken(env, { ...row, agentId: row.agentId }, sender.userId);
  return Response.json(token, { headers: { "Cache-Control": "no-store" } });
}
