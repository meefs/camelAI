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
    options?: { completedAt?: number },
  ): Promise<void>;
  listStreamingThreadIds(): Promise<string[]>;
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

});
