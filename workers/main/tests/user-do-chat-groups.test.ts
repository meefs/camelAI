import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createUser, getUserSchemaVersion, type TestEnv } from "./test-helpers";

const testEmail = () =>
  `chat-groups-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe("UserDO chat groups", () => {
  const testEnv = env as unknown as TestEnv;

  async function createUserStub() {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "Chat Groups User",
    );
    return {
      userId,
      userStub: testEnv.USER.get(testEnv.USER.idFromName(userId)),
    };
  }

  it("migrates UserDO to schema V9", async () => {
    const { userId } = await createUserStub();

    await expect(getUserSchemaVersion(testEnv, userId)).resolves.toBe(9);
  });

  it("lists the top 10 groups by recency and all groups for move menus", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();

    for (let i = 0; i < 12; i++) {
      await userStub.createChatGroup(orgId, workspaceId, { name: `Group ${i}` });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const visible = await userStub.listChatGroups(orgId, workspaceId);
    const all = await userStub.listChatGroupsForMove(orgId, workspaceId);

    expect(visible).toHaveLength(10);
    expect(all).toHaveLength(12);
    expect(visible[0].name).toBe("Group 11");
    expect(visible[9].name).toBe("Group 2");
  });

  it("orders groups by last user message activity rather than selection", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const first = await userStub.createChatGroup(orgId, workspaceId, {
      name: "First",
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Second",
    });
    const firstThreadId = crypto.randomUUID();
    const secondThreadId = crypto.randomUUID();

    await userStub.addThreadToGroup(first.id, firstThreadId);
    await userStub.addThreadToGroup(second.id, secondThreadId);

    await new Promise((resolve) => setTimeout(resolve, 1));
    await userStub.touchGroupForThread(firstThreadId);
    await new Promise((resolve) => setTimeout(resolve, 1));

    await userStub.setGroupActiveThread(second.id, secondThreadId);
    await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      secondThreadId,
      "Second",
    );

    let visible = await userStub.listChatGroups(orgId, workspaceId);
    expect(visible.map((group) => group.id)).toEqual([first.id, second.id]);

    await new Promise((resolve) => setTimeout(resolve, 1));
    await userStub.touchGroupForThread(secondThreadId);

    visible = await userStub.listChatGroups(orgId, workspaceId);
    expect(visible.map((group) => group.id)).toEqual([second.id, first.id]);
  });

  it("keeps each thread in exactly one group for a user", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const first = await userStub.createChatGroup(orgId, workspaceId, {
      name: "First",
    });
    const second = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Second",
    });
    const threadId = crypto.randomUUID();

    await userStub.addThreadToGroup(first.id, threadId);
    await userStub.moveThreadToGroup(threadId, second.id);

    const firstSummary = await userStub.getChatGroupSummary(first.id);
    const secondSummary = await userStub.getChatGroupSummary(second.id);

    expect(firstSummary).toBeNull();
    expect(secondSummary?.open_thread_ids).toEqual([threadId]);
  });

  it("closes, reopens, reorders, and views tabs", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const group = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Build",
    });
    const firstThreadId = crypto.randomUUID();
    const secondThreadId = crypto.randomUUID();

    await userStub.addThreadToGroup(group.id, firstThreadId);
    await userStub.addThreadToGroup(group.id, secondThreadId);
    await userStub.closeThreadTab(firstThreadId);

    let summary = await userStub.getChatGroupSummary(group.id);
    expect(summary?.open_thread_ids).toEqual([secondThreadId]);
    expect(summary?.closed_thread_ids).toEqual([firstThreadId]);

    await userStub.reopenThreadTab(firstThreadId);
    await userStub.reorderThreadTabs(group.id, [firstThreadId, secondThreadId]);
    await userStub.markThreadViewed(firstThreadId, 1234);

    summary = await userStub.getChatGroupSummary(group.id);
    const views = await userStub.listThreadViews([firstThreadId, secondThreadId]);
    expect(summary?.open_thread_ids).toEqual([firstThreadId, secondThreadId]);
    expect(summary?.closed_thread_ids).toEqual([]);
    expect(views).toEqual({ [firstThreadId]: 1234 });
  });

  it("does not reopen closed tabs while reordering", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const group = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Build",
    });
    const firstThreadId = crypto.randomUUID();
    const secondThreadId = crypto.randomUUID();
    const closedThreadId = crypto.randomUUID();

    await userStub.addThreadToGroup(group.id, firstThreadId);
    await userStub.addThreadToGroup(group.id, secondThreadId);
    await userStub.addThreadToGroup(group.id, closedThreadId);
    await userStub.closeThreadTab(closedThreadId);

    await userStub.reorderThreadTabs(group.id, [
      secondThreadId,
      closedThreadId,
      firstThreadId,
    ]);

    const summary = await userStub.getChatGroupSummary(group.id);
    expect(summary?.open_thread_ids).toEqual([secondThreadId, firstThreadId]);
    expect(summary?.closed_thread_ids).toEqual([closedThreadId]);
  });

  it("does not reopen closed tabs while ensuring route membership", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const group = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Build",
    });
    const firstThreadId = crypto.randomUUID();
    const secondThreadId = crypto.randomUUID();

    await userStub.addThreadToGroup(group.id, firstThreadId);
    await userStub.addThreadToGroup(group.id, secondThreadId);
    await userStub.closeThreadTab(firstThreadId);

    const ensured = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      firstThreadId,
      "Fallback title",
    );

    expect(ensured.open_thread_ids).toEqual([secondThreadId]);
    expect(ensured.closed_thread_ids).toEqual([firstThreadId]);
    expect(ensured.last_active_thread_id).toBe(secondThreadId);
  });

  it("materializes legacy threads and only auto-names empty single-thread groups", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const threadId = crypto.randomUUID();

    let summary = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      threadId,
      "Fallback title",
    );
    expect(summary.name).toBe("Fallback title");
    expect(summary.open_thread_ids).toEqual([threadId]);

    await userStub.renameChatGroup(summary.id, "");
    await userStub.renameEmptySingleThreadGroupForThread(threadId, "Generated title");
    summary = await userStub.getChatGroupSummary(summary.id);
    expect(summary?.name).toBe("Generated title");

    await userStub.renameChatGroup(summary!.id, "Manual");
    await userStub.renameEmptySingleThreadGroupForThread(threadId, "Ignored");
    summary = await userStub.getChatGroupSummary(summary!.id);
    expect(summary?.name).toBe("Manual");
  });

  it("removes memberships and deletes empty groups during cleanup", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const group = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Cleanup",
    });
    const threadId = crypto.randomUUID();

    await userStub.addThreadToGroup(group.id, threadId);
    await userStub.removeThreadMembership(threadId);

    expect(await userStub.getChatGroupSummary(group.id)).toBeNull();
  });
});
