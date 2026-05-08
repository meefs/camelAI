import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { moveThreadToGroup } from "@/lib/chat-groups.server";

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
    request,
    context,
    undefined,
    { requireWrite: true },
  );
  const body = (await request.json().catch(() => null)) as
    | { threadId?: unknown; targetGroupId?: unknown; name?: unknown }
    | null;
  const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
  const targetGroupId =
    typeof body?.targetGroupId === "string" ? body.targetGroupId.trim() : "";
  if (!threadId || !targetGroupId) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }
  const group = await moveThreadToGroup(context, {
    userId,
    orgId,
    workspaceId,
    threadId,
    targetGroupId,
    name: typeof body?.name === "string" ? body.name : undefined,
  });
  return Response.json({ group });
}
