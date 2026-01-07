import { getCloudflareContext } from '@opennextjs/cloudflare';
import { withDoRpc } from '@/lib/do-rpc';
import type { SandboxFileListing, WorkspaceListResponse } from '@/types';
import type { DoRpcService } from '../../workers/main/src/rpc-service';

interface Env {
  DO_RPC: DoRpcService;
}

async function withRpc<T>(fn: (rpc: DoRpcService) => Promise<T>): Promise<T> {
  const { env } = getCloudflareContext() as unknown as { env: Env };
  return withDoRpc(env.DO_RPC, fn);
}

export async function listWorkspaceFiles(workspaceId: string): Promise<SandboxFileListing> {
  return withRpc((rpc) => rpc.listWorkspaceFiles(workspaceId));
}

export async function listWorkspaceEntries(
  workspaceId: string,
  options?: { path?: string; recursive?: boolean; includeHidden?: boolean }
): Promise<WorkspaceListResponse> {
  return withRpc((rpc) => rpc.listWorkspaceEntries(workspaceId, options));
}

export async function readWorkspaceFile(workspaceId: string, path: string) {
  return withRpc((rpc) => rpc.readWorkspaceFile(workspaceId, path));
}

export async function writeWorkspaceFile(workspaceId: string, path: string, content: string) {
  return withRpc((rpc) => rpc.writeWorkspaceFile(workspaceId, path, content));
}

export async function mkdirWorkspacePath(workspaceId: string, path: string) {
  return withRpc((rpc) => rpc.mkdirWorkspacePath(workspaceId, path));
}

export async function createWorkspaceFile(workspaceId: string, path: string, content?: string) {
  return withRpc((rpc) => rpc.createWorkspaceFile(workspaceId, path, content));
}

export async function moveWorkspacePath(workspaceId: string, from: string, to: string) {
  return withRpc((rpc) => rpc.moveWorkspacePath(workspaceId, from, to));
}

export async function deleteWorkspacePath(workspaceId: string, path: string) {
  return withRpc((rpc) => rpc.deleteWorkspacePath(workspaceId, path));
}

export async function resetSandboxContainer(workspaceId: string) {
  return withRpc((rpc) => rpc.resetWorkspaceContainer(workspaceId));
}
