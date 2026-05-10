import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import { closeGroup } from "@/lib/chat-groups.server";

export async function action({ request, context, params }: ActionFunctionArgs) {
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

  if (request.method === "PATCH") {
    const body = (await request.json().catch(() => null)) as
      | { name?: unknown }
      | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return Response.json({ error: "Name required" }, { status: 400 });
    }
    const userStub = getAuthEnv(getEnv(context)).USER.get(
      getAuthEnv(getEnv(context)).USER.idFromName(userId),
    );
    const group = await userStub.getChatGroup(groupId);
    if (!group || group.org_id !== orgId || group.workspace_id !== workspaceId) {
      return Response.json({ error: "Group not found" }, { status: 404 });
    }
    await userStub.renameChatGroup(groupId, name);
    return Response.json({ success: true });
  }

  if (request.method === "DELETE") {
    try {
      await closeGroup(context, { userId, orgId, workspaceId, groupId });
    } catch (error) {
      if (error instanceof Error && error.message === "Chat group not found") {
        return Response.json({ error: error.message }, { status: 404 });
      }
      console.error("Failed to close chat group:", error);
      return Response.json(
        { error: "Failed to close chat group" },
        { status: 500 },
      );
    }
    return Response.json({ success: true });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
