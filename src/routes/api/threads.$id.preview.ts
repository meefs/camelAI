import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import type { OrgDO } from "../../../workers/main/src/identity/org-do";
import { normalizePreviewTabs } from "../../../workers/main/src/chat-thread/preview-state";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * PUT /api/threads/:id/preview {tabs, activeTabId}: a runtime thread's open
 * preview tabs, kept in OrgDO (thread_ui_state) for the next load.
 */
export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "PUT") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: "Too many preview tabs" }, { status: 413 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "Too many preview tabs" }, { status: 413 });
  const body = (() => { try { return JSON.parse(raw); } catch { return null; } })() as
    | { tabs?: unknown; activeTabId?: unknown; workspaceId?: unknown }
    | null;
  const { env, context: threadContext } = await requireRuntimeThread(
    request,
    context,
    params.id,
    requestWorkspaceId(request, body),
  );
  const org = env.ORG.get(env.ORG.idFromName(threadContext.orgId)) as unknown as Pick<OrgDO, "setThreadUiState">;
  // Tabs render as iframes and links: keep only well-formed targets, and
  // files only from this thread's workspace.
  const preview = normalizePreviewTabs(body?.tabs, body?.activeTabId, threadContext.workspaceId, threadContext.threadId);
  const saved = await org.setThreadUiState(threadContext.threadId, preview);
  return Response.json({ previewVersion: saved?.previewVersion ?? null });
}

/**
 * GET /api/threads/:id/preview: a runtime thread's saved preview tabs (what
 * set_preview, a notebook run or a deploy opened, and the user's own tabs),
 * normalized as they are stored.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const { env, context: threadContext } = await requireRuntimeThread(request, context, params.id, requestWorkspaceId(request));
  const org = env.ORG.get(env.ORG.idFromName(threadContext.orgId)) as unknown as Pick<OrgDO, "getThreadUiState">;
  const saved = await org.getThreadUiState(threadContext.threadId);
  const preview = normalizePreviewTabs(saved?.preview?.tabs, saved?.preview?.activeTabId, threadContext.workspaceId, threadContext.threadId);
  return Response.json(
    { preview, previewVersion: saved?.previewVersion ?? 0 },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
