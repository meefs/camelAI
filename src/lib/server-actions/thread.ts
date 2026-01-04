'use server';

import * as authDO from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do';
import { requireSession } from '@/lib/server-guards';

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

  return chatDO.createThread(
    session.org_id,
    input.title,
    projectId,
    session.user_id,
    input.session_id
  );
}

export async function getThreads() {
  const session = await requireSession();
  const threads = await chatDO.getThreads(session.org_id);
  const creatorIds = Array.from(
    new Set(
      threads
        .map((thread) => thread.created_by)
        .filter((id) => Boolean(id))
    )
  ) as string[];
  const creatorEntries = await Promise.all(
    creatorIds.map(async (id) => [id, await authDO.getUserById(id)] as const)
  );
  const creatorMap = new Map<string, NonNullable<Awaited<ReturnType<typeof authDO.getUserById>>>>();
  for (const [id, user] of creatorEntries) {
    if (user) creatorMap.set(id, user);
  }
  return threads.map((thread) => ({
    ...thread,
    creator: creatorMap.get(thread.created_by),
  }));
}

export async function getThreadMessages(threadId: string) {
  const session = await requireSession();
  return chatDO.getMessages(threadId, session.org_id);
}

export async function updateThreadTitle(threadId: string, title: string) {
  const session = await requireSession();
  const thread = await chatDO.updateThread(threadId, title, session.org_id);
  if (!thread) {
    throw new Error('Not found');
  }
  return thread;
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
