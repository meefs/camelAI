import { getCloudflareContext } from '@opennextjs/cloudflare';
import { withDoRpc } from '@/lib/do-rpc';
import type { Thread, Message, PaginatedResult, PaginationParams } from '@/types';
import type { DoRpcService } from '../../workers/main/src/rpc-service';

interface Env {
  DO_RPC: DoRpcService;
}

async function withRpc<T>(fn: (rpc: DoRpcService) => Promise<T>): Promise<T> {
  const { env } = getCloudflareContext() as unknown as { env: Env };
  return withDoRpc(env.DO_RPC, fn);
}

export async function getThreads(workspaceId: string): Promise<Thread[]> {
  return withRpc((rpc) => rpc.getThreads(workspaceId));
}

export async function getThreadsPaginated(
  workspaceId: string,
  params: PaginationParams = {}
): Promise<PaginatedResult<Thread>> {
  return withRpc((rpc) => rpc.getThreadsPaginated(workspaceId, params));
}

export async function createThread(
  workspaceId: string,
  title: string | undefined,
  createdBy?: string
): Promise<Thread> {
  return withRpc((rpc) => rpc.createThread(workspaceId, title, createdBy));
}

export async function getThread(id: string, workspaceId: string): Promise<Thread | null> {
  return withRpc((rpc) => rpc.getThread(id, workspaceId));
}

export async function updateThread(id: string, title: string, workspaceId: string): Promise<Thread | null> {
  return withRpc((rpc) => rpc.updateThread(id, title, workspaceId));
}

export async function deleteThread(id: string, workspaceId: string): Promise<void> {
  return withRpc((rpc) => rpc.deleteThread(id, workspaceId));
}

export async function generateThreadTitle(
  threadId: string,
  workspaceId: string,
  message: string
): Promise<void> {
  return withRpc((rpc) => rpc.generateAndUpdateThreadTitle(threadId, workspaceId, message));
}

export async function getMessages(threadId: string, workspaceId: string): Promise<Message[]> {
  // Messages are read from container's Claude JSONL file
  return withRpc((rpc) => rpc.getMessages(threadId, workspaceId));
}

export async function setThreadPreview(threadId: string, workers: string[]): Promise<string[]> {
  return withRpc((rpc) => rpc.setThreadPreview(threadId, workers));
}

export async function getThreadPreview(threadId: string): Promise<string[]> {
  return withRpc((rpc) => rpc.getThreadPreview(threadId));
}
