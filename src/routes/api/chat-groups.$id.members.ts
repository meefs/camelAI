import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { addThreadToExistingGroup } from "@/lib/chat-groups.server";

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
    request,
    context,
    undefined,
    { requireWrite: true },
  );
  const groupId = params.id?.trim();
  if (!groupId) {
    return Response.json({ error: "Group ID required" }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as
    | { threadId?: unknown }
    | null;
  const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
  if (!threadId) {
    return Response.json({ error: "Thread ID required" }, { status: 400 });
  }
  const group = await addThreadToExistingGroup(context, {
    userId,
    orgId,
    workspaceId,
    groupId,
    threadId,
  });
  return Response.json({ group });
}
