import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { createUser, getUserSchemaVersion, type TestEnv } from "./test-helpers";
import {
  AVATAR_COLORS,
  DEFAULT_CHAT_GROUP_EMOJI,
} from "../../../src/lib/avatar";

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

  it("migrates UserDO to schema V10", async () => {
    const { userId } = await createUserStub();

    await expect(getUserSchemaVersion(testEnv, userId)).resolves.toBe(10);
  });

  it("assigns deterministic default avatars to new groups", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const otherWorkspaceId = crypto.randomUUID();

    const first = await userStub.createChatGroup(orgId, workspaceId, {
      name: "First",
    });
    const second = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Second",
    });
    const otherWorkspace = await userStub.createChatGroup(orgId, otherWorkspaceId, {
      name: "Other workspace",
    });

    expect(first.avatar).toEqual({
      color: AVATAR_COLORS[0],
      content: DEFAULT_CHAT_GROUP_EMOJI,
      status: "default",
    });
    expect(second.avatar).toEqual({
      color: AVATAR_COLORS[1],
      content: DEFAULT_CHAT_GROUP_EMOJI,
      status: "default",
    });
    expect(otherWorkspace.avatar).toEqual({
      color: AVATAR_COLORS[0],
      content: DEFAULT_CHAT_GROUP_EMOJI,
      status: "default",
    });
  });

  it("updates user-saved avatars without changing recency or allowing generated overwrite", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const group = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Design",
    });

    await userStub.setGeneratedChatGroupEmoji(group.id, "🧠");
    let summary = await userStub.getChatGroupSummary(group.id);
    expect(summary?.avatar.content).toBe("🧠");

    await userStub.updateChatGroup(group.id, {
      name: "Design systems",
      avatar: { color: "#e0476b", content: "🌊" },
    });
    summary = await userStub.getChatGroupSummary(group.id);
    expect(summary?.name).toBe("Design systems");
    expect(summary?.avatar).toEqual({
      color: "#E0476B",
      content: "🌊",
      status: "user",
    });
    expect(summary?.updated_at).toBe(group.updated_at);

    await userStub.setGeneratedChatGroupEmoji(group.id, "🔥");
    summary = await userStub.getChatGroupSummary(group.id);
    expect(summary?.avatar.content).toBe("🌊");
  });

  it("claims avatar generation for an eligible titled thread group", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const group = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      threadId,
      "",
    );

    await userStub.renameEmptySingleThreadGroupForThread(
      threadId,
      "Generated title",
    );

    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(threadId),
    ).resolves.toEqual({
      id: group.id,
      name: "Generated title",
      avatar: {
        color: AVATAR_COLORS[0],
        content: DEFAULT_CHAT_GROUP_EMOJI,
        status: "default",
      },
    });

    // Once an emoji is generated, the group is no longer claimable.
    await userStub.setGeneratedChatGroupEmoji(group.id, "🧠");
    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(threadId),
    ).resolves.toBeNull();
  });

  it("does not re-claim a group after a failed generation attempt", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const group = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      threadId,
      "Generated title",
    );

    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(threadId),
    ).resolves.toMatchObject({ id: group.id });

    // A failed attempt is a one-shot: it stays on the default avatar but is not
    // claimed again on the next websocket connection.
    const marked = await userStub.markChatGroupAvatarGenerationFailed(group.id);
    expect(marked).toMatchObject({
      content: DEFAULT_CHAT_GROUP_EMOJI,
      status: "default",
    });
    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(threadId),
    ).resolves.toBeNull();
  });

  it("marks failed attempts on legacy fallback rows so they stop being claimable", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const group = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      threadId,
      "Generated title",
    );

    // Simulate a legacy prod row from the old fallback machinery.
    await runInDurableObject(userStub, async (instance) => {
      instance.ctx.storage.sql.exec(
        "UPDATE chat_groups SET avatar_content_source = 'fallback' WHERE id = ?",
        group.id,
      );
    });

    // Legacy fallback rows get a fresh shot at generation...
    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(threadId),
    ).resolves.toMatchObject({ id: group.id });

    // ...but a failed attempt is still one-shot, not retried on reconnect.
    const marked = await userStub.markChatGroupAvatarGenerationFailed(group.id);
    expect(marked).toMatchObject({
      content: DEFAULT_CHAT_GROUP_EMOJI,
      status: "default",
    });
    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(threadId),
    ).resolves.toBeNull();
  });

  it("does not overwrite a user avatar when marking a failed attempt", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const group = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      threadId,
      "Generated title",
    );

    await userStub.updateChatGroup(group.id, {
      avatar: { color: "#e0476b", content: "🌊" },
    });
    const marked = await userStub.markChatGroupAvatarGenerationFailed(group.id);
    expect(marked).toMatchObject({ content: "🌊", status: "user" });
  });

  it("claims accessed multi-thread groups but skips placeholder names", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const placeholderThreadId = crypto.randomUUID();
    const multiThreadId = crypto.randomUUID();
    const extraThreadId = crypto.randomUUID();

    await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      placeholderThreadId,
      "New Chat",
    );
    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(placeholderThreadId),
    ).resolves.toBeNull();

    const multiGroup = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Implementation plan",
    });
    await userStub.addThreadToGroup(multiGroup.id, multiThreadId);
    await userStub.addThreadToGroup(multiGroup.id, extraThreadId);
    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(multiThreadId),
    ).resolves.toMatchObject({
      id: multiGroup.id,
      name: "Implementation plan",
      avatar: {
        content: DEFAULT_CHAT_GROUP_EMOJI,
        status: "default",
      },
    });
  });

  it("does not claim accessed groups with user or generated avatars", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const userThreadId = crypto.randomUUID();
    const generatedThreadId = crypto.randomUUID();
    const userGroup = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      userThreadId,
      "User avatar",
    );
    const generatedGroup = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      generatedThreadId,
      "Generated avatar",
    );

    await userStub.updateChatGroup(userGroup.id, {
      avatar: { color: "#e0476b", content: "🌊" },
    });
    await userStub.setGeneratedChatGroupEmoji(generatedGroup.id, "🧠");

    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(userThreadId),
    ).resolves.toBeNull();
    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(generatedThreadId),
    ).resolves.toBeNull();
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

    const placeholderThreadId = crypto.randomUUID();
    let placeholderSummary = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      placeholderThreadId,
      "New Chat",
    );
    expect(placeholderSummary.name).toBe("New Chat");
    await userStub.renameEmptySingleThreadGroupForThread(
      placeholderThreadId,
      "Real title",
    );
    placeholderSummary = await userStub.getChatGroupSummary(placeholderSummary.id);
    expect(placeholderSummary?.name).toBe("Real title");

    await userStub.renameChatGroup(summary!.id, "Manual");
    await userStub.renameEmptySingleThreadGroupForThread(threadId, "Ignored");
    summary = await userStub.getChatGroupSummary(summary!.id);
    expect(summary?.name).toBe("Manual");
  });

  it("writes generated emoji for single-thread groups with non-empty fallback names", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const threadId = crypto.randomUUID();

    const summary = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      threadId,
      "Fallback title",
    );

    await userStub.renameEmptySingleThreadGroupForThread(
      threadId,
      "Generated title",
      { generatedEmoji: "🧠" },
    );

    const updated = await userStub.getChatGroupSummary(summary.id);
    expect(updated?.name).toBe("Fallback title");
    expect(updated?.avatar.content).toBe("🧠");
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
