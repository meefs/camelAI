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

export async function listWorkspaceFiles(orgId: string): Promise<SandboxFileListing> {
  return withRpc((rpc) => rpc.listWorkspaceFiles(orgId));
}

export async function listWorkspaceEntries(
  orgId: string,
  options?: { path?: string; recursive?: boolean; includeHidden?: boolean }
): Promise<WorkspaceListResponse> {
  return withRpc((rpc) => rpc.listWorkspaceEntries(orgId, options));
}

export async function readWorkspaceFile(orgId: string, path: string) {
  return withRpc((rpc) => rpc.readWorkspaceFile(orgId, path));
}

export async function writeWorkspaceFile(orgId: string, path: string, content: string) {
  return withRpc((rpc) => rpc.writeWorkspaceFile(orgId, path, content));
}

export async function mkdirWorkspacePath(orgId: string, path: string) {
  return withRpc((rpc) => rpc.mkdirWorkspacePath(orgId, path));
}

export async function createWorkspaceFile(orgId: string, path: string, content?: string) {
  return withRpc((rpc) => rpc.createWorkspaceFile(orgId, path, content));
}

export async function moveWorkspacePath(orgId: string, from: string, to: string) {
  return withRpc((rpc) => rpc.moveWorkspacePath(orgId, from, to));
}

export async function deleteWorkspacePath(orgId: string, path: string) {
  return withRpc((rpc) => rpc.deleteWorkspacePath(orgId, path));
}

export async function resetSandboxContainer(orgId: string) {
  return withRpc((rpc) => rpc.resetOrgContainer(orgId));
}
