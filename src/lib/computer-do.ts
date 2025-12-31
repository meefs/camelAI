import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { SandboxFileListing } from '@/types';
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
