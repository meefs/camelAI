import type { WorkspaceDO } from "./workspace";
import type { ThreadCompletionSummaryStatus } from "../../../src/types";

export interface WorkspaceThreadStatusEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
}

export interface WorkspaceThreadStreamingOptions {
  completedAt?: number;
  summaryStatus?: ThreadCompletionSummaryStatus | null;
  summary?: string | null;
  activityText?: string | null;
  activityAt?: number | null;
}

export function recordWorkspaceThreadStreaming(
  env: WorkspaceThreadStatusEnv,
  workspaceId: string | null | undefined,
  threadId: string | null | undefined,
  isStreaming: boolean,
  options?: WorkspaceThreadStreamingOptions,
): Promise<void> {
  const normalizedWorkspaceId = workspaceId?.trim();
  const normalizedThreadId = threadId?.trim();
  if (!normalizedWorkspaceId || !normalizedThreadId) {
    return Promise.resolve();
  }
  const workspace = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(normalizedWorkspaceId),
  );
  return workspace.recordThreadStreaming(normalizedThreadId, isStreaming, options);
}
