import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { SandboxFileListing, WorkspaceListResponse } from '@/types';
import type { DoRpcService } from '../../workers/main/src/rpc-service';

interface Env {
  DO_RPC: DoRpcService;
}

async function getRpc(): Promise<DoRpcService> {
  const { env } = getCloudflareContext() as unknown as { env: Env };
  return env.DO_RPC;
}

export async function listWorkspaceFiles(orgId: string): Promise<SandboxFileListing> {
  // FIXME(computer): DO_RPC stubs should be disposed to avoid warning logs.
  // Recommended fix: add a shared helper that wraps DO_RPC calls with try/finally
  // and dispose() after each call (applies to auth-do, chat-do, and computer-do).
  const rpc = await getRpc();
  return rpc.listWorkspaceFiles(orgId);
}

export async function listWorkspaceEntries(
  orgId: string,
  options?: { path?: string; recursive?: boolean; includeHidden?: boolean }
): Promise<WorkspaceListResponse> {
  const rpc = await getRpc();
  return rpc.listWorkspaceEntries(orgId, options);
}

export async function readWorkspaceFile(orgId: string, path: string) {
  const rpc = await getRpc();
  return rpc.readWorkspaceFile(orgId, path);
}

export async function writeWorkspaceFile(orgId: string, path: string, content: string) {
  const rpc = await getRpc();
  return rpc.writeWorkspaceFile(orgId, path, content);
}

export async function mkdirWorkspacePath(orgId: string, path: string) {
  const rpc = await getRpc();
  return rpc.mkdirWorkspacePath(orgId, path);
}

export async function createWorkspaceFile(orgId: string, path: string, content?: string) {
  const rpc = await getRpc();
  return rpc.createWorkspaceFile(orgId, path, content);
}

export async function moveWorkspacePath(orgId: string, from: string, to: string) {
  const rpc = await getRpc();
  return rpc.moveWorkspacePath(orgId, from, to);
}

export async function deleteWorkspacePath(orgId: string, path: string) {
  const rpc = await getRpc();
  return rpc.deleteWorkspacePath(orgId, path);
}
