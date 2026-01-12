'use server';

import { getCloudflareContext } from '@opennextjs/cloudflare';
import * as authDO from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do';
import { requireSession } from '@/lib/server-guards';
import { getUserByIdCached } from '@/lib/auth-context';
import type { Thread, User } from '@/types';

function toSerializable<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item)) as T;
  }
  if (typeof value === 'object') {
    const plain: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      plain[key] = toSerializable(entry);
    }
    return plain as T;
  }
  return value;
}

type CachedProfile = NonNullable<Awaited<ReturnType<typeof getUserByIdCached>>>;

function toUser(profile: CachedProfile): User {
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    created_at: profile.created_at,
    is_superuser: profile.is_superuser,
    avatar: {
      color: profile.avatar_color,
      content: profile.avatar_content,
    },
    is_orphaned: profile.is_orphaned,
  };
}

async function hydrateThreads(threads: Thread[]) {
  const creatorIds = Array.from(
    new Set(
      threads
        .map((thread) => thread.created_by)
        .filter((id) => Boolean(id))
    )
  ) as string[];
  const creatorEntries = await Promise.all(
    creatorIds.map(async (id) => [id, await getUserByIdCached(id)] as const)
  );
  const creatorMap = new Map<string, User>();
  for (const [id, user] of creatorEntries) {
    if (user) creatorMap.set(id, toUser(user));
  }
  return threads.map((thread) => ({
    ...thread,
    creator: creatorMap.get(thread.created_by),
  }));
}

async function requireWorkspaceId(requireWrite = false) {
  const session = await requireSession();
  const workspaceId = session.workspace_id;
  if (!workspaceId) {
    throw new Error('No workspace selected');
  }
  const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
  if (access === 'none') {
    throw new Error('Workspace not found');
  }
  if (requireWrite && access !== 'full') {
    throw new Error('Workspace access denied');
  }
  return { session, workspaceId };
}

async function requireWorkspaceAccess(workspaceId: string, requireWrite = false) {
  const session = await requireSession();
  const workspace = await authDO.getWorkspace(workspaceId);
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error('Workspace not found');
  }
  const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
  if (access === 'none') {
    throw new Error('Workspace not found');
  }
  if (requireWrite && access !== 'full') {
    throw new Error('Workspace access denied');
  }
  return { session, workspaceId };
}

export async function createThread(input: {
  title?: string;
  firstMessage?: string;
}) {
  const { session, workspaceId } = await requireWorkspaceId(true);
  const { ctx } = getCloudflareContext();

  const thread = await chatDO.createThread(
    workspaceId,
    input.title,
    session.user_id
  );

  // Generate title in background (non-blocking)
  if (input.firstMessage && !input.title) {
    ctx.waitUntil(
      chatDO.generateThreadTitle(thread.id, workspaceId, input.firstMessage)
    );
  }

  return toSerializable(thread);
}

export async function getThreads() {
  const { workspaceId } = await requireWorkspaceId();
  const threads = await chatDO.getThreads(workspaceId);
  const hydrated = await hydrateThreads(threads);
  return toSerializable(hydrated);
}

export async function getThreadsPage(params: { offset?: number; limit?: number } = {}) {
  const { workspaceId } = await requireWorkspaceId();
  const page = await chatDO.getThreadsPaginated(workspaceId, params);
  const hydratedItems = await hydrateThreads(page.items);
  return toSerializable({
    ...page,
    items: hydratedItems,
  });
}

export async function getThreadsPageAllWorkspaces(
  params: { offset?: number; limit?: number } = {}
) {
  const session = await requireSession();
  const workspaces = await authDO.listUserWorkspaces(session.user_id, session.org_id);
  const accessibleIds = workspaces
    .filter((workspace) => workspace.access_level !== 'none')
    .map((workspace) => workspace.id);

  if (accessibleIds.length === 0) {
    return toSerializable({
      items: [],
      total: 0,
      offset: params.offset ?? 0,
      limit: params.limit ?? 50,
    });
  }

  const page = await chatDO.getThreadsPaginatedAllWorkspaces(accessibleIds, params);
  const hydratedItems = await hydrateThreads(page.items);
  return toSerializable({
    ...page,
    items: hydratedItems,
  });
}

export async function getThreadMessages(threadId: string) {
  const { workspaceId } = await requireWorkspaceId();
  const messages = await chatDO.getMessages(threadId, workspaceId);
  return toSerializable(messages);
}

export async function updateThreadTitle(
  threadId: string,
  title: string,
  workspaceId?: string
) {
  const resolvedWorkspaceId = workspaceId
    ? (await requireWorkspaceAccess(workspaceId, true)).workspaceId
    : (await requireWorkspaceId(true)).workspaceId;
  const thread = await chatDO.updateThread(threadId, title, resolvedWorkspaceId);
  if (!thread) {
    throw new Error('Not found');
  }
  return toSerializable(thread);
}

export async function deleteThread(threadId: string, workspaceId?: string) {
  const resolvedWorkspaceId = workspaceId
    ? (await requireWorkspaceAccess(workspaceId, true)).workspaceId
    : (await requireWorkspaceId(true)).workspaceId;
  await chatDO.deleteThread(threadId, resolvedWorkspaceId);
  return { success: true };
}

export async function getThread(threadId: string) {
  const { workspaceId } = await requireWorkspaceId();
  const thread = await chatDO.getThread(threadId, workspaceId);
  if (!thread) {
    return null;
  }
  const hydrated = await hydrateThreads([thread]);
  return toSerializable(hydrated[0]);
}

export async function getThreadPreview(threadId: string): Promise<string[]> {
  const { workspaceId } = await requireWorkspaceId();
  // Verify thread belongs to user's workspace (prevents cross-tenant leak)
  const thread = await chatDO.getThread(threadId, workspaceId);
  if (!thread) {
    throw new Error('Thread not found');
  }
  return chatDO.getThreadPreview(threadId);
}
