import { getCloudflareContext } from '@opennextjs/cloudflare';
import { withDoRpc } from '@/lib/do-rpc';
import type { Thread, Message, Project, PaginatedResult, PaginationParams } from '@/types';
import type { DoRpcService } from '../../workers/main/src/rpc-service';

interface Env {
  DO_RPC: DoRpcService;
}

async function withRpc<T>(fn: (rpc: DoRpcService) => Promise<T>): Promise<T> {
  const { env } = getCloudflareContext() as unknown as { env: Env };
  return withDoRpc(env.DO_RPC, fn);
}

export async function getThreads(org: string): Promise<Thread[]> {
  return withRpc((rpc) => rpc.getThreads(org));
}

export async function getThreadsPaginated(
  org: string,
  params: PaginationParams = {}
): Promise<PaginatedResult<Thread>> {
  return withRpc((rpc) => rpc.getThreadsPaginated(org, params));
}

export async function createThread(
  org: string,
  title: string | undefined,
  projectId: string,
  createdBy?: string,
  sessionId?: string
): Promise<Thread> {
  return withRpc((rpc) => rpc.createThread(org, title, projectId, createdBy, sessionId));
}

export async function getThread(id: string, org: string): Promise<Thread | null> {
  return withRpc((rpc) => rpc.getThread(id, org));
}

export async function updateThread(id: string, title: string, org: string): Promise<Thread | null> {
  return withRpc((rpc) => rpc.updateThread(id, title, org));
}

export async function deleteThread(id: string, org: string): Promise<void> {
  return withRpc((rpc) => rpc.deleteThread(id, org));
}

export async function getMessages(threadId: string, org: string): Promise<Message[]> {
  // Messages are read from container's Claude JSONL file
  return withRpc((rpc) => rpc.getMessages(threadId, org));
}

export async function getProjects(org: string): Promise<Project[]> {
  return withRpc((rpc) => rpc.getProjects(org));
}

export async function getProjectsByUser(org: string, userId: string): Promise<Project[]> {
  return withRpc((rpc) => rpc.getProjectsByUser(org, userId));
}

export async function createProject(org: string, name?: string, createdBy?: string): Promise<Project> {
  return withRpc((rpc) => rpc.createProject(org, name, createdBy));
}

export async function getProject(id: string, org: string): Promise<Project | null> {
  return withRpc((rpc) => rpc.getProject(id, org));
}

export async function updateProject(id: string, name: string, org: string): Promise<Project | null> {
  return withRpc((rpc) => rpc.updateProject(id, name, org));
}

export async function deleteProject(id: string, org: string): Promise<void> {
  return withRpc((rpc) => rpc.deleteProject(id, org));
}

export async function setThreadPreview(threadId: string, workers: string[]): Promise<string[]> {
  return withRpc((rpc) => rpc.setThreadPreview(threadId, workers));
}

export async function getThreadPreview(threadId: string): Promise<string[]> {
  return withRpc((rpc) => rpc.getThreadPreview(threadId));
}
