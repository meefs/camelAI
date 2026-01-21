import type { AppLoadContext } from 'react-router';
import { getEnv, type CloudflareEnv } from './cloudflare.server';
import type { Thread, Message, PaginatedResult, PaginationParams } from '@/types';
import { OrgDO, type OrgThread } from '../../workers/main/src/auth';
import { WorkspaceDO } from '../../workers/main/src/workspace';

// Helper to convert OrgThread to Thread
function toThread(orgThread: OrgThread): Thread {
  return {
    id: orgThread.id,
    workspace_id: orgThread.workspace_id,
    title: orgThread.title,
    created_by: orgThread.created_by,
    created_at: orgThread.created_at,
    updated_at: orgThread.updated_at,
  };
}

// Helper to get workspace info and org ID
async function getWorkspaceInfo(
  env: CloudflareEnv,
  workspaceId: string
): Promise<{ org_id: string } | null> {
  const wsStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId)
  ) as unknown as WorkspaceDO;
  const info = await wsStub.getInfo();
  if (!info) return null;
  return { org_id: info.org_id };
}

// Helper to get OrgDO stub
function getOrgStub(env: CloudflareEnv, orgId: string): OrgDO {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgDO;
}

export async function getThreads(
  context: AppLoadContext,
  workspaceId: string
): Promise<Thread[]> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return [];
  const orgStub = getOrgStub(env, wsInfo.org_id);
  const threads = await orgStub.getThreadsByWorkspace(workspaceId);
  return threads.map((t) => toThread(t));
}

export async function getThreadsPaginated(
  context: AppLoadContext,
  workspaceId: string,
  params: PaginationParams = {}
): Promise<PaginatedResult<Thread>> {
  const env = getEnv(context);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) {
    return { items: [], total: 0, offset, limit };
  }
  const orgStub = getOrgStub(env, wsInfo.org_id);
  const result = await orgStub.getThreadsPaginated(offset, limit, workspaceId);
  return {
    items: result.items.map((t) => toThread(t)),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };
}

export async function getThreadsPaginatedAllWorkspaces(
  context: AppLoadContext,
  workspaceIds: string[],
  params: PaginationParams = {}
): Promise<PaginatedResult<Thread>> {
  const env = getEnv(context);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  if (workspaceIds.length === 0) {
    return { items: [], total: 0, offset, limit };
  }
  const wsInfo = await getWorkspaceInfo(env, workspaceIds[0]);
  if (!wsInfo) {
    return { items: [], total: 0, offset, limit };
  }
  const orgStub = getOrgStub(env, wsInfo.org_id);
  const result = await orgStub.getThreadsAllWorkspacesPaginated(workspaceIds, offset, limit);
  return {
    items: result.items.map((t) => toThread(t)),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };
}

export async function createThread(
  context: AppLoadContext,
  workspaceId: string,
  title: string | undefined,
  createdBy?: string
): Promise<Thread> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) {
    throw new Error('Workspace not found');
  }
  const orgStub = getOrgStub(env, wsInfo.org_id);
  const thread = await orgStub.createThread(workspaceId, title, createdBy);
  return toThread(thread);
}

export async function getThread(
  context: AppLoadContext,
  id: string,
  workspaceId: string
): Promise<Thread | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;
  const orgStub = getOrgStub(env, wsInfo.org_id);
  const thread = await orgStub.getThread(id);
  if (!thread) return null;
  // Verify the thread belongs to this workspace
  if (thread.workspace_id !== workspaceId) return null;
  return toThread(thread);
}

export async function updateThread(
  context: AppLoadContext,
  id: string,
  title: string,
  workspaceId: string
): Promise<Thread | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;
  const orgStub = getOrgStub(env, wsInfo.org_id);
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return null;
  const thread = await orgStub.updateThread(id, title);
  if (!thread) return null;
  return toThread(thread);
}

export async function deleteThread(
  context: AppLoadContext,
  id: string,
  workspaceId: string
): Promise<void> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return;
  const orgStub = getOrgStub(env, wsInfo.org_id);
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return;
  await orgStub.deleteThread(id);
}

export async function touchThread(
  context: AppLoadContext,
  id: string,
  workspaceId: string
): Promise<void> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return;
  const orgStub = getOrgStub(env, wsInfo.org_id);
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return;
  await orgStub.touchThread(id);
}

export async function generateThreadTitle(
  _context: AppLoadContext,
  _threadId: string,
  _workspaceId: string,
  _message: string
): Promise<void> {
  // TODO: Implement with AI binding
  // For now, this is a no-op - title generation requires the AI binding
  console.warn('generateThreadTitle not yet implemented - requires AI binding');
}

export async function getMessages(
  _context: AppLoadContext,
  _threadId: string,
  _workspaceId: string
): Promise<Message[]> {
  // TODO: Implement - requires reading from container JSONL files
  // For now, return empty array - messages are read from container
  console.warn('getMessages not yet implemented - requires container access');
  return [];
}

export async function setThreadPreview(
  _context: AppLoadContext,
  _threadId: string,
  _workers: string[]
): Promise<string[]> {
  // TODO: Implement with ChatThreadDO
  console.warn('setThreadPreview not yet implemented');
  return [];
}

export async function getThreadPreview(
  _context: AppLoadContext,
  _threadId: string
): Promise<string[]> {
  // TODO: Implement with ChatThreadDO
  console.warn('getThreadPreview not yet implemented');
  return [];
}
