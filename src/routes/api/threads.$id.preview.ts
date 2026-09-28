import type { ActionFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import type { OrgDO } from "../../../workers/main/src/identity/org-do";

const MAX_TABS = 32;

/**
 * PUT /api/threads/:id/preview {tabs, activeTabId}: a runtime thread's open
 * preview tabs, kept in OrgDO (thread_ui_state) for the next load.
 */
export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "PUT") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const body = (await request.json().catch(() => null)) as
    | { tabs?: unknown; activeTabId?: unknown; workspaceId?: unknown }
    | null;
  const tabs = Array.isArray(body?.tabs)
    ? body.tabs.filter((tab) => tab && typeof tab === "object" && !Array.isArray(tab)).slice(0, MAX_TABS)
    : [];
  const activeTabId = typeof body?.activeTabId === "string" ? body.activeTabId : null;
  const { env, context: threadContext } = await requireRuntimeThread(
    request,
    context,
    params.id,
    requestWorkspaceId(request, body),
  );
  const org = env.ORG.get(env.ORG.idFromName(threadContext.orgId)) as unknown as Pick<OrgDO, "setThreadUiState">;
  const saved = await org.setThreadUiState(threadContext.threadId, { tabs, activeTabId });
  return Response.json({ previewVersion: saved?.previewVersion ?? null });
}
