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
  /**
   * Liveness-lease heartbeat: bump the running row's updated_at only. Never
   * creates the row and never broadcasts — a late heartbeat must not
   * resurrect a turn whose terminal isStreaming=false already cleared it.
   */
  refresh?: boolean;
  /**
   * Terminal pre-clear used before completion metadata is persisted. Delete and
   * broadcast only when a running row currently exists; a duplicate/stale
   * completion must not manufacture a fresh unread transition.
   */
  clearOnlyIfRunning?: boolean;
  /**
   * Timestamp used only to decide whether the running row belongs to a newer
   * turn. This may differ from `completedAt` when OrgDO normalizes metadata
   * forward after the terminal transition was first observed.
   */
  clearRunningStartedAtOrBefore?: number | null;
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
