'use server';

import * as authDO from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do';
import { requireSession } from '@/lib/server-guards';
import { getUserByIdCached } from '@/lib/auth-context';
import type { Thread } from '@/types';

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
  const creatorMap = new Map<string, NonNullable<Awaited<ReturnType<typeof getUserByIdCached>>>>();
  for (const [id, user] of creatorEntries) {
    if (user) creatorMap.set(id, user);
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

export async function createThread(input: {
  title?: string;
  session_id?: string;
}) {
  const { session, workspaceId } = await requireWorkspaceId(true);

  const thread = await chatDO.createThread(
    workspaceId,
    input.title,
    session.user_id,
    input.session_id
  );
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

export async function getThreadMessages(threadId: string) {
  const { workspaceId } = await requireWorkspaceId();
  const messages = await chatDO.getMessages(threadId, workspaceId);
  return toSerializable(messages);
}

export async function updateThreadTitle(threadId: string, title: string) {
  const { workspaceId } = await requireWorkspaceId(true);
  const thread = await chatDO.updateThread(threadId, title, workspaceId);
  if (!thread) {
    throw new Error('Not found');
  }
  return toSerializable(thread);
}

export async function deleteThread(threadId: string) {
  const { workspaceId } = await requireWorkspaceId(true);
  await chatDO.deleteThread(threadId, workspaceId);
  return { success: true };
}
