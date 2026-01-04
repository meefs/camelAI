'use server';

import * as authDO from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do';
import { requireSession } from '@/lib/server-guards';
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
  const creators = await authDO.getUsersByIds(creatorIds);
  const creatorMap = new Map<string, (typeof creators)[number]>();
  for (const user of creators) {
    creatorMap.set(user.id, user);
  }
  return threads.map((thread) => ({
    ...thread,
    creator: creatorMap.get(thread.created_by),
  }));
}

export async function createThread(input: {
  title?: string;
  projectId?: string;
  projectName?: string;
  session_id?: string;
}) {
  const session = await requireSession();

  let projectId = input.projectId?.trim();
  if (!projectId) {
    const projectName = input.projectName?.trim() || input.title?.trim() || 'New Project';
    const project = await chatDO.createProject(session.org_id, projectName, session.user_id);
    await authDO.addUserProject(session.user_id, session.org_id, project.id);
    projectId = project.id;
  }

  const thread = await chatDO.createThread(
    session.org_id,
    input.title,
    projectId,
    session.user_id,
    input.session_id
  );
  return toSerializable(thread);
}

export async function getThreads() {
  const session = await requireSession();
  const threads = await chatDO.getThreads(session.org_id);
  const hydrated = await hydrateThreads(threads);
  return toSerializable(hydrated);
}

export async function getThreadsPage(params: { offset?: number; limit?: number } = {}) {
  const timingEnabled = process.env.CHIRIDION_TIMING === '1';
  const start = timingEnabled ? Date.now() : 0;
  const session = await requireSession();
  const pageStart = timingEnabled ? Date.now() : 0;
  const page = await chatDO.getThreadsPaginated(session.org_id, params);
  if (timingEnabled) {
    console.log(
      `[timing] getThreadsPage fetch ${Date.now() - pageStart}ms (items=${page.items.length})`
    );
  }
  const hydrateStart = timingEnabled ? Date.now() : 0;
  const hydratedItems = await hydrateThreads(page.items);
  if (timingEnabled) {
    console.log(
      `[timing] getThreadsPage hydrate ${Date.now() - hydrateStart}ms (uniqueCreators=${
        new Set(page.items.map((item) => item.created_by)).size
      })`
    );
  }
  if (timingEnabled) {
    console.log(`[timing] getThreadsPage total ${Date.now() - start}ms`);
  }
  return toSerializable({
    ...page,
    items: hydratedItems,
  });
}

export async function getThreadMessages(threadId: string) {
  const session = await requireSession();
  const messages = await chatDO.getMessages(threadId, session.org_id);
  return toSerializable(messages);
}

export async function updateThreadTitle(threadId: string, title: string) {
  const session = await requireSession();
  const thread = await chatDO.updateThread(threadId, title, session.org_id);
  if (!thread) {
    throw new Error('Not found');
  }
  return toSerializable(thread);
}

export async function deleteThread(threadId: string) {
  const session = await requireSession();
  await chatDO.deleteThread(threadId, session.org_id);
  return { success: true };
}

export async function createProject(name?: string) {
  const session = await requireSession();
  const project = await chatDO.createProject(session.org_id, name, session.user_id);
  await authDO.addUserProject(session.user_id, session.org_id, project.id);
  return project;
}

export async function updateProject(projectId: string, name: string) {
  const session = await requireSession();
  const project = await chatDO.updateProject(projectId, name, session.org_id);
  if (!project) {
    throw new Error('Not found');
  }
  return project;
}

export async function deleteProject(projectId: string) {
  const session = await requireSession();
  const project = await chatDO.getProject(projectId, session.org_id);
  if (!project) {
    throw new Error('Not found');
  }
  await chatDO.deleteProject(projectId, session.org_id);
  if (project.created_by && project.created_by !== 'system') {
    await authDO.removeUserProject(project.created_by, session.org_id, projectId);
  }
  return { ok: true };
}
