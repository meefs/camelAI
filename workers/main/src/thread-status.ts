import type { WorkspaceDO } from "./workspace";

export interface WorkspaceThreadStatusEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
}

export function recordWorkspaceThreadStreaming(
  env: WorkspaceThreadStatusEnv,
  workspaceId: string | null | undefined,
  threadId: string | null | undefined,
  isStreaming: boolean,
): Promise<void> {
  const normalizedWorkspaceId = workspaceId?.trim();
  const normalizedThreadId = threadId?.trim();
  if (!normalizedWorkspaceId || !normalizedThreadId) {
    return Promise.resolve();
  }
  const workspace = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(normalizedWorkspaceId),
  );
  return workspace.recordThreadStreaming(normalizedThreadId, isStreaming);
}
