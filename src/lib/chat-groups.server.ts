import type { AppLoadContext } from "react-router";
import { getEnv } from "./cloudflare.server";
import type {
  ChatGroup,
  ChatGroupSummary,
  ChatGroupThreadSummary,
  ChatGroupView,
  Thread,
} from "@/types";
import * as chatDO from "@/lib/chat-do.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import type { OrgDO, UserDO } from "../../workers/main/src/auth";
import { maxThreadStatus } from "@/lib/thread-status";
import { getInitialChatGroupNameFromThreadTitle } from "@/lib/thread-title";

interface UserScopedArgs {
  userId: string;
  orgId: string;
  workspaceId: string;
}

interface MoveThreadArgs extends UserScopedArgs {
  threadId: string;
  targetGroupId: string | "new";
  name?: string;
}

function getUserStub(context: AppLoadContext, userId: string): UserDO {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authEnv.USER.get(authEnv.USER.idFromName(userId)) as unknown as UserDO;
}

function getOrgStub(context: AppLoadContext, orgId: string): OrgDO {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  return authEnv.ORG.get(authEnv.ORG.idFromName(orgId)) as unknown as OrgDO;
}

async function getStreamingThreadIds(
  context: AppLoadContext,
  workspaceId: string,
): Promise<string[]> {
  const env = getEnv(context);
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId))
    .listStreamingThreadIds()
    .catch((error) => {
      console.error("Failed to load workspace streaming status:", error);
      return [];
    });
}

function collectThreadIds(groups: ChatGroupSummary[]): string[] {
  return Array.from(
    new Set(
      groups.flatMap((group) => [
        ...group.open_thread_ids,
        ...group.closed_thread_ids,
      ]),
    ),
  );
}

async function hydrateThreads(
  context: AppLoadContext,
  workspaceId: string,
  threadIds: string[],
): Promise<Map<string, Thread>> {
  const entries = await Promise.all(
    threadIds.map(async (threadId) => {
      const thread = await chatDO.getThread(context, threadId, workspaceId);
      return [threadId, thread] as const;
    }),
  );
  return new Map(
    entries.filter((entry): entry is [string, Thread] => entry[1] !== null),
  );
}

export async function hydrateChatGroups(
  context: AppLoadContext,
  userId: string,
  workspaceId: string,
  groups: ChatGroupSummary[],
): Promise<ChatGroupView[]> {
  if (groups.length === 0) return [];
  const userStub = getUserStub(context, userId);
  const threadIds = collectThreadIds(groups);
  const [threadMap, streamingThreadIds, viewedAtByThreadId] = await Promise.all([
    hydrateThreads(context, workspaceId, threadIds),
    getStreamingThreadIds(context, workspaceId),
    userStub.listThreadViews(threadIds),
  ]);

  const missingThreadIds = threadIds.filter((threadId) => !threadMap.has(threadId));
  if (missingThreadIds.length > 0) {
    await userStub.pruneMissingThreads(missingThreadIds);
  }

  const runningThreadIds = new Set(streamingThreadIds);
  const now = Date.now();
  const toThreadSummary = (threadId: string): ChatGroupThreadSummary | null => {
    const thread = threadMap.get(threadId);
    if (!thread) return null;
    const isRunning = runningThreadIds.has(threadId);
    const isOptimisticNewThreadRunning =
      !isRunning &&
      thread.user_message_count > 0 &&
      now - thread.created_at < 30_000;
    const isUnread =
      !isRunning &&
      !isOptimisticNewThreadRunning &&
      thread.updated_at > (viewedAtByThreadId[threadId] ?? 0);
    return {
      id: thread.id,
      title: thread.title,
      model: thread.model,
      provider: thread.provider,
      updated_at: thread.updated_at,
      is_unread: isUnread,
      status:
        isRunning || isOptimisticNewThreadRunning
          ? "running"
          : isUnread
            ? "unread"
            : "idle",
    };
  };

  return groups.map((group) => {
    const openThreads = group.open_thread_ids
      .map(toThreadSummary)
      .filter((thread): thread is ChatGroupThreadSummary => thread !== null);
    const closedThreads = group.closed_thread_ids
      .map(toThreadSummary)
      .filter((thread): thread is ChatGroupThreadSummary => thread !== null);
    const fallbackName =
      group.name.trim() ||
      openThreads[0]?.title ||
      closedThreads[0]?.title ||
      "Untitled group";
    const statuses = [...openThreads, ...closedThreads].map(
      (thread) => thread.status,
    );
    return {
      ...group,
      name: fallbackName,
      open_threads: openThreads,
      closed_threads: closedThreads,
      member_count: openThreads.length + closedThreads.length,
      status: maxThreadStatus(statuses),
    };
  });
}

export async function listGroupsForWorkspace(
  context: AppLoadContext,
  args: UserScopedArgs & { limit?: number },
): Promise<ChatGroupView[]> {
  const userStub = getUserStub(context, args.userId);
  const groups = await userStub.listChatGroups(args.orgId, args.workspaceId, {
    limit: args.limit,
  });
  return hydrateChatGroups(context, args.userId, args.workspaceId, groups);
}

export async function listGroupsForMove(
  context: AppLoadContext,
  args: UserScopedArgs,
): Promise<ChatGroup[]> {
  const userStub = getUserStub(context, args.userId);
  return userStub.listChatGroupsForMove(args.orgId, args.workspaceId);
}

export async function getGroupForWorkspace(
  context: AppLoadContext,
  args: UserScopedArgs & { groupId: string },
): Promise<ChatGroupView | null> {
  const userStub = getUserStub(context, args.userId);
  const group = await userStub.getChatGroup(args.groupId);
  if (
    !group ||
    group.org_id !== args.orgId ||
    group.workspace_id !== args.workspaceId
  ) {
    return null;
  }
  const summary = await userStub.getChatGroupSummary(args.groupId);
  const [hydrated] = await hydrateChatGroups(
    context,
    args.userId,
    args.workspaceId,
    summary ? [summary] : [],
  );
  return hydrated ?? null;
}

export async function ensureGroupForThread(
  context: AppLoadContext,
  args: UserScopedArgs & { threadId: string; fallbackName: string },
): Promise<ChatGroupView> {
  const thread = await chatDO.getThread(context, args.threadId, args.workspaceId);
  if (!thread) {
    throw new Error("Thread not found");
  }
  const userStub = getUserStub(context, args.userId);
  const group = await userStub.ensureGroupForThread(
    args.orgId,
    args.workspaceId,
    args.threadId,
    args.fallbackName || thread.title,
  );
  const [hydrated] = await hydrateChatGroups(context, args.userId, args.workspaceId, [
    group,
  ]);
  return hydrated;
}

export async function createGroupForNewThread(
  context: AppLoadContext,
  args: UserScopedArgs & {
    threadId: string;
    initialThreadTitle?: string | null;
  },
): Promise<ChatGroupView> {
  const userStub = getUserStub(context, args.userId);
  const { group } = await userStub.moveThreadToNewGroup(
    args.orgId,
    args.workspaceId,
    args.threadId,
    { name: getInitialChatGroupNameFromThreadTitle(args.initialThreadTitle) },
  );
  const summary = await userStub.getChatGroupSummary(group.id);
  const [hydrated] = await hydrateChatGroups(
    context,
    args.userId,
    args.workspaceId,
    summary ? [summary] : [],
  );
  return hydrated;
}

export async function addThreadToExistingGroup(
  context: AppLoadContext,
  args: UserScopedArgs & { groupId: string; threadId: string },
): Promise<ChatGroupView> {
  const thread = await chatDO.getThread(context, args.threadId, args.workspaceId);
  if (!thread) throw new Error("Thread not found");
  const userStub = getUserStub(context, args.userId);
  const group = await userStub.getChatGroup(args.groupId);
  if (
    !group ||
    group.org_id !== args.orgId ||
    group.workspace_id !== args.workspaceId
  ) {
    throw new Error("Chat group not found");
  }
  await userStub.addThreadToGroup(args.groupId, args.threadId);
  const summary = await userStub.getChatGroupSummary(args.groupId);
  const [hydrated] = await hydrateChatGroups(
    context,
    args.userId,
    args.workspaceId,
    summary ? [summary] : [],
  );
  return hydrated;
}

export async function moveThreadToGroup(
  context: AppLoadContext,
  args: MoveThreadArgs,
): Promise<ChatGroupView> {
  const thread = await chatDO.getThread(context, args.threadId, args.workspaceId);
  if (!thread) throw new Error("Thread not found");
  const userStub = getUserStub(context, args.userId);
  let groupId: string;
  if (args.targetGroupId === "new") {
    const created = await userStub.moveThreadToNewGroup(
      args.orgId,
      args.workspaceId,
      args.threadId,
      { name: args.name || thread.title },
    );
    groupId = created.group.id;
  } else {
    const group = await userStub.getChatGroup(args.targetGroupId);
    if (
      !group ||
      group.org_id !== args.orgId ||
      group.workspace_id !== args.workspaceId
    ) {
      throw new Error("Chat group not found");
    }
    await userStub.moveThreadToGroup(args.threadId, args.targetGroupId);
    groupId = args.targetGroupId;
  }
  const summary = await userStub.getChatGroupSummary(groupId);
  const [hydrated] = await hydrateChatGroups(
    context,
    args.userId,
    args.workspaceId,
    summary ? [summary] : [],
  );
  return hydrated;
}

export async function closeGroup(
  context: AppLoadContext,
  args: UserScopedArgs & { groupId: string },
): Promise<void> {
  const userStub = getUserStub(context, args.userId);
  const group = await userStub.getChatGroup(args.groupId);
  if (
    !group ||
    group.org_id !== args.orgId ||
    group.workspace_id !== args.workspaceId
  ) {
    throw new Error("Chat group not found");
  }
  await userStub.closeChatGroup(args.groupId);
}

export async function removeDeletedThreadFromOrgGroups(
  context: AppLoadContext,
  orgId: string,
  threadId: string,
): Promise<void> {
  const orgStub = getOrgStub(context, orgId);
  const members = await orgStub.getMembers();
  await Promise.all(
    members.map((member) =>
      getUserStub(context, member.user_id).removeThreadMembership(threadId),
    ),
  );
}
