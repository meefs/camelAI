import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import * as chatDO from "@/lib/chat-do.server";

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "PATCH") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { workspaceId } = await requireSessionWorkspaceAccess(
    request,
    context,
    undefined,
    { requireWrite: true },
  );
  const threadId = params.id?.trim();
  if (!threadId) {
    return Response.json({ error: "Thread ID required" }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as
    | { title?: unknown }
    | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return Response.json({ error: "Title required" }, { status: 400 });
  }
  const thread = await chatDO.updateThread(context, threadId, title, workspaceId);
  if (!thread) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  return Response.json({ thread });
}
