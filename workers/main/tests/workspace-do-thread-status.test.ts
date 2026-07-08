import { describe, expect, it } from "vitest";
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
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

    await workspaceStub.recordThreadStreaming(threadId, true);
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

    await workspaceStub.recordThreadStreaming(threadId, true);
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

    await workspaceStub.recordThreadStreaming(threadId, true);
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

  it("drops a late activity update after the turn was terminally cleared", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    await workspaceStub.recordThreadStreaming(threadId, false, {
      completedAt: Date.now(),
    });

    // A debounced/retried running-activity flush landing after the terminal
    // clear must not resurrect a phantom "running" row.
    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText: "Stale activity from the finished turn",
      activityAt: Date.now(),
    });

    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);
  });

  it("does not create a running row from an activity-only update", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText: "Activity before the turn-start transition",
      activityAt: Date.now(),
    });

    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);
  });

  it("renews the lease on refresh without creating or resurrecting rows", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    // A refresh before the turn-start transition must not create the row.
    await workspaceStub.recordThreadStreaming(threadId, true, { refresh: true });
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);

    await workspaceStub.recordThreadStreaming(threadId, true);
    const [before] = await workspaceStub.listStreamingThreadStatuses();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await workspaceStub.recordThreadStreaming(threadId, true, { refresh: true });
    const [after] = await workspaceStub.listStreamingThreadStatuses();
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);

    // A late heartbeat after the terminal clear must not resurrect the row.
    await workspaceStub.recordThreadStreaming(threadId, false, {
      completedAt: Date.now(),
    });
    await workspaceStub.recordThreadStreaming(threadId, true, { refresh: true });
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);
  });

  it("arms the lease-sweep alarm when a turn starts", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    const beforeStart = Date.now();
    await workspaceStub.recordThreadStreaming(threadId, true);

    const alarm = await runInDurableObject(workspaceStub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
    // startedAt + 5min lease + 1s slack, allowing for test scheduling drift.
    expect(alarm!).toBeGreaterThan(beforeStart);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 2_000);
  });

  it("sweeps an expired lease via the alarm and broadcasts idle", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);

    const response = await workspaceStub.fetch("https://workspace/status", {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket!.accept();
    const frames: Array<{ type?: string; threadId?: string; status?: string }> =
      [];
    socket!.addEventListener("message", (event) => {
      frames.push(JSON.parse(event.data as string));
    });

    // Backdate the lease past the TTL: the turn's heartbeats "stopped".
    await runInDurableObject(workspaceStub, (instance) => {
      (instance as unknown as { sql: SqlStorage }).sql.exec(
        "UPDATE thread_streaming_status SET updated_at = ? WHERE thread_id = ?",
        Date.now() - 6 * 60 * 1000,
        threadId,
      );
    });

    await expect(runDurableObjectAlarm(workspaceStub)).resolves.toBe(true);
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);

    // The prune broadcast an idle frame to connected status sockets.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "thread_status",
        threadId,
        status: "idle",
      }),
    );

    // Nothing left running and no managed tokens: the alarm is cleared
    // instead of leaving the 1h dead-man fallback armed.
    const alarmAfter = await runInDurableObject(
      workspaceStub,
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(alarmAfter).toBeNull();
  });
});
