import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  createOrg,
  createUser,
  createWorkspace,
  type TestEnv,
} from "./test-helpers";

type WorkspaceStatusStub = DurableObjectStub<{
  recordThreadStreaming(
    threadId: string,
    isStreaming: boolean,
    options?: {
      completedAt?: number;
      summaryStatus?: "pending" | "ready" | "failed" | null;
      summary?: string | null;
      activityText?: string | null;
      activityAt?: number | null;
    },
  ): Promise<void>;
  listStreamingThreadIds(): Promise<string[]>;
  listStreamingThreadStatuses(): Promise<
    Array<{
      threadId: string;
      startedAt: number;
      updatedAt: number;
      latestActivityText: string | null;
      latestActivityAt: number | null;
    }>
  >;
}>;

const testEmail = () =>
  `workspace-status-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe("WorkspaceDO thread status", () => {
  const testEnv = env as unknown as TestEnv;

  async function createWorkspaceStatusStub(): Promise<WorkspaceStatusStub> {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "Workspace Status User",
    );
    const { org } = await createOrg(testEnv, "Status Org", userId);
    const workspace = await createWorkspace(
      testEnv,
      org.id,
      "Status Workspace",
      userId,
    );
    return testEnv.WORKSPACE.get(
      testEnv.WORKSPACE.idFromName(workspace.id),
    ) as WorkspaceStatusStub;
  }

  it("persists and clears running thread status", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([
      threadId,
    ]);

    await workspaceStub.recordThreadStreaming(threadId, false);
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);
  });

  it("tracks multiple running threads by most recent update", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const firstThreadId = crypto.randomUUID();
    const secondThreadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(firstThreadId, true);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await workspaceStub.recordThreadStreaming(secondThreadId, true);

    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([
      secondThreadId,
      firstThreadId,
    ]);
  });

  it("persists latest running activity for live status snapshots", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText:
        "Reading src/components/sidebar/chat-group-hover-card.tsx with extra whitespace",
      activityAt: 12345,
    });

    const statuses = await workspaceStub.listStreamingThreadStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      threadId,
      latestActivityText:
        "Reading src/components/sidebar/chat-group-hover-card.tsx with extra whitespace",
      latestActivityAt: 12345,
    });
    expect(statuses[0].startedAt).toEqual(expect.any(Number));
    expect(statuses[0].updatedAt).toEqual(expect.any(Number));

    await workspaceStub.recordThreadStreaming(threadId, false);
    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([]);
  });

  it("preserves running activity when streaming status is refreshed without activity", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText: "Thinking",
      activityAt: 100,
    });
    await workspaceStub.recordThreadStreaming(threadId, true);

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([
      expect.objectContaining({
        threadId,
        latestActivityText: "Thinking",
        latestActivityAt: 100,
      }),
    ]);
  });

  it("ignores stale completion status updates older than the current running row", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText: "Running newer turn",
      activityAt: 100,
    });
    const [runningStatus] = await workspaceStub.listStreamingThreadStatuses();
    const staleCompletedAt = runningStatus.startedAt - 1;

    await workspaceStub.recordThreadStreaming(threadId, false, {
      completedAt: staleCompletedAt,
      summaryStatus: "ready",
      summary: "Previous turn summary",
    });

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([
      expect.objectContaining({
        threadId,
        startedAt: runningStatus.startedAt,
        latestActivityText: "Running newer turn",
      }),
    ]);
  });

  it("clears running status for completions newer than the current running row", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    const [runningStatus] = await workspaceStub.listStreamingThreadStatuses();

    await workspaceStub.recordThreadStreaming(threadId, false, {
      completedAt: runningStatus.startedAt + 1,
      summaryStatus: "failed",
    });

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([]);
  });
});
