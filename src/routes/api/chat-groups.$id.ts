import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import { closeGroup } from "@/lib/chat-groups.server";
import { normalizeChatGroupAvatar } from "@/lib/avatar";
import type { Avatar } from "@/types";

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
      | { name?: unknown; avatar?: unknown }
      | null;
    if (!body || (body.name === undefined && body.avatar === undefined)) {
      return Response.json(
        { error: "Name or avatar required" },
        { status: 400 },
      );
    }
    let name: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        return Response.json({ error: "Invalid name" }, { status: 400 });
      }
      name = body.name.trim();
      if (!name) {
        return Response.json({ error: "Name required" }, { status: 400 });
      }
    }
    let avatar: Avatar | undefined;
    if (body.avatar !== undefined) {
      const normalizedAvatar = normalizeChatGroupAvatar(body.avatar);
      if (!normalizedAvatar) {
        return Response.json({ error: "Invalid avatar" }, { status: 400 });
      }
      avatar = normalizedAvatar;
    }
    const authEnv = getAuthEnv(getEnv(context));
    const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
    const group = await userStub.getChatGroup(groupId);
    if (!group || group.org_id !== orgId || group.workspace_id !== workspaceId) {
      return Response.json({ error: "Group not found" }, { status: 404 });
    }
    await userStub.updateChatGroup(groupId, { name, avatar });
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
