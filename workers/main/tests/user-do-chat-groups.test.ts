import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { createUser, getUserSchemaVersion, type TestEnv } from "./test-helpers";
import { AVATAR_COLORS } from "../../../src/lib/avatar";
import { DEFAULT_CHAT_GROUP_ICON } from "../../../src/lib/chat-group-icons";

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

  it("migrates UserDO to schema V11", async () => {
    const { userId } = await createUserStub();

    await expect(getUserSchemaVersion(testEnv, userId)).resolves.toBe(11);
  });

  it("classifies V10 avatar rows without changing group recency", async () => {
    const { userId, userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const generatedEmoji = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Generated emoji",
    });
    const userEmoji = await userStub.createChatGroup(orgId, workspaceId, {
      name: "User emoji",
    });
    const unknown = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Unknown avatar",
    });
    const placeholder = await userStub.createChatGroup(orgId, workspaceId, {
      name: "New Chat",
    });
    const generatedIcon = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Generated icon",
    });
    const userIcon = await userStub.createChatGroup(orgId, workspaceId, {
      name: "User icon",
    });
    const intentionalDefault = await userStub.createChatGroup(
      orgId,
      workspaceId,
      { name: "Intentional default" },
    );
    const canonicalized = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Canonicalized",
    });
    const originalUpdatedAt = 123_456;

    await runInDurableObject(userStub, async (instance) => {
      const sql = instance.ctx.storage.sql;
      sql.exec(
        "UPDATE chat_groups SET avatar_content = '🚀', avatar_content_source = 'generated', updated_at = ? WHERE id = ?",
        originalUpdatedAt,
        generatedEmoji.id,
      );
      sql.exec(
        "UPDATE chat_groups SET avatar_content = '✨', avatar_content_source = 'user', updated_at = ? WHERE id = ?",
        originalUpdatedAt,
        userEmoji.id,
      );
      sql.exec(
        "UPDATE chat_groups SET avatar_content = 'not-an-icon', avatar_content_source = 'fallback', updated_at = ? WHERE id = ?",
        originalUpdatedAt,
        unknown.id,
      );
      sql.exec(
        "UPDATE chat_groups SET avatar_content = '💬', avatar_content_source = 'generated', updated_at = ? WHERE id = ?",
        originalUpdatedAt,
        placeholder.id,
      );
      sql.exec(
        "UPDATE chat_groups SET avatar_content = 'rocket', avatar_content_source = 'generated', updated_at = ? WHERE id = ?",
        originalUpdatedAt,
        generatedIcon.id,
      );
      sql.exec(
        "UPDATE chat_groups SET avatar_content = 'sparkles', avatar_content_source = 'user', updated_at = ? WHERE id = ?",
        originalUpdatedAt,
        userIcon.id,
      );
      sql.exec(
        "UPDATE chat_groups SET avatar_content = 'messages-square', avatar_content_source = 'user', updated_at = ? WHERE id = ?",
        originalUpdatedAt,
        intentionalDefault.id,
      );
      sql.exec(
        "UPDATE chat_groups SET avatar_content = 'BarChart3', avatar_content_source = 'generated', updated_at = ? WHERE id = ?",
        originalUpdatedAt,
        canonicalized.id,
      );
      instance.ctx.storage.kv.put("schemaVersion", 10);
      (instance as unknown as { migrate(): void }).migrate();
    });

    await expect(getUserSchemaVersion(testEnv, userId)).resolves.toBe(11);
    await expect(userStub.getChatGroup(generatedEmoji.id)).resolves.toMatchObject({
      updated_at: originalUpdatedAt,
      avatar: {
        content: DEFAULT_CHAT_GROUP_ICON,
        status: "pending",
      },
    });
    await expect(userStub.getChatGroup(userEmoji.id)).resolves.toMatchObject({
      avatar: { content: DEFAULT_CHAT_GROUP_ICON, status: "pending" },
    });
    await expect(userStub.getChatGroup(unknown.id)).resolves.toMatchObject({
      avatar: { content: DEFAULT_CHAT_GROUP_ICON, status: "pending" },
    });
    await expect(userStub.getChatGroup(placeholder.id)).resolves.toMatchObject({
      avatar: { content: DEFAULT_CHAT_GROUP_ICON, status: "default" },
    });
    await expect(userStub.getChatGroup(generatedIcon.id)).resolves.toMatchObject({
      avatar: { content: "rocket", status: "generated" },
    });
    await expect(userStub.getChatGroup(userIcon.id)).resolves.toMatchObject({
      avatar: { content: "sparkles", status: "user" },
    });
    await expect(
      userStub.getChatGroup(intentionalDefault.id),
    ).resolves.toMatchObject({
      avatar: { content: "messages-square", status: "user" },
    });
    await expect(userStub.getChatGroup(canonicalized.id)).resolves.toMatchObject({
      avatar: { content: "bar-chart-3", status: "generated" },
    });
  });

  it("upgrades an actual V10 table shape and preserves queued work across migration retries", async () => {
    const { userId, userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const legacyEmoji = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Deploy API to Staging",
    });
    const validDefault = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Intentional default",
    });

    await runInDurableObject(userStub, async (instance) => {
      const sql = instance.ctx.storage.sql;
      sql.exec(
        "UPDATE chat_groups SET avatar_content = '🚀', avatar_content_source = 'generated' WHERE id = ?",
        legacyEmoji.id,
      );
      sql.exec(
        "UPDATE chat_groups SET avatar_content = 'messages-square', avatar_content_source = 'default' WHERE id = ?",
        validDefault.id,
      );
      sql.exec(
        "ALTER TABLE chat_groups DROP COLUMN avatar_icon_generation_claimed_at",
      );
      sql.exec(
        "ALTER TABLE chat_groups DROP COLUMN avatar_icon_generation_claim_id",
      );
      sql.exec(
        "ALTER TABLE chat_groups DROP COLUMN avatar_icon_generation_state",
      );
      const v10Columns = sql
        .exec<{ name: string }>("PRAGMA table_info(chat_groups)")
        .toArray()
        .map((column) => column.name);
      expect(v10Columns).not.toContain("avatar_icon_generation_state");
      expect(v10Columns).not.toContain("avatar_icon_generation_claim_id");
      expect(v10Columns).not.toContain("avatar_icon_generation_claimed_at");

      instance.ctx.storage.kv.put("schemaVersion", 10);
      (instance as unknown as { migrate(): void }).migrate();
    });

    await expect(getUserSchemaVersion(testEnv, userId)).resolves.toBe(11);
    await expect(userStub.getChatGroup(legacyEmoji.id)).resolves.toMatchObject({
      avatar: { content: DEFAULT_CHAT_GROUP_ICON, status: "pending" },
    });
    await expect(userStub.getChatGroup(validDefault.id)).resolves.toMatchObject({
      avatar: { content: DEFAULT_CHAT_GROUP_ICON, status: "default" },
    });

    // Model an interruption after row conversion but before the V11 version
    // write by restoring only the recorded version, then rerun twice. The
    // converted default icon must retain its queued state on every retry.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runInDurableObject(userStub, async (instance) => {
        instance.ctx.storage.kv.put("schemaVersion", 10);
        (instance as unknown as { migrate(): void }).migrate();
      });
      await expect(getUserSchemaVersion(testEnv, userId)).resolves.toBe(11);
      await expect(userStub.getChatGroup(legacyEmoji.id)).resolves.toMatchObject({
        avatar: { content: DEFAULT_CHAT_GROUP_ICON, status: "pending" },
      });
      await expect(userStub.getChatGroup(validDefault.id)).resolves.toMatchObject({
        avatar: { content: DEFAULT_CHAT_GROUP_ICON, status: "default" },
      });
    }

    const claims = await userStub.claimChatGroupAvatarMigrationBatch(
      orgId,
      workspaceId,
      3,
    );
    expect(claims.map((claim) => claim.id)).toEqual([legacyEmoji.id]);
  });

  it("claims migration batches deterministically within one workspace", async () => {
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
    const third = await userStub.createChatGroup(orgId, workspaceId, {
      name: "Third",
    });
    const other = await userStub.createChatGroup(orgId, otherWorkspaceId, {
      name: "Other",
    });

    await runInDurableObject(userStub, async (instance) => {
      const sql = instance.ctx.storage.sql;
      for (const [group, updatedAt] of [
        [first, 100],
        [second, 300],
        [third, 200],
        [other, 400],
      ] as const) {
        sql.exec(
          `UPDATE chat_groups
           SET avatar_icon_generation_state = 'queued', updated_at = ?
           WHERE id = ?`,
          updatedAt,
          group.id,
        );
      }
    });

    const firstBatch = await userStub.claimChatGroupAvatarMigrationBatch(
      orgId,
      workspaceId,
      2,
    );
    expect(firstBatch.map((item) => item.name)).toEqual(["Second", "Third"]);
    expect(firstBatch.every((item) => item.avatar.status === "pending")).toBe(true);
    const secondBatch = await userStub.claimChatGroupAvatarMigrationBatch(
      orgId,
      workspaceId,
      2,
    );
    expect(secondBatch.map((item) => item.name)).toEqual(["First"]);
    expect(
      await userStub.claimChatGroupAvatarMigrationBatch(orgId, workspaceId, 2),
    ).toEqual([]);
  });

  it("fences stale completions after lease replacement and name-only rename", async () => {
    const { userStub } = await createUserStub();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const group = await userStub.ensureGroupForThread(
      orgId,
      workspaceId,
      threadId,
      "Name A",
    );
    const firstClaim = await userStub.claimChatGroupAvatarGenerationForThread(
      threadId,
    );
    expect(firstClaim).not.toBeNull();
    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(threadId),
    ).resolves.toBeNull();

    await runInDurableObject(userStub, async (instance) => {
      instance.ctx.storage.sql.exec(
        "UPDATE chat_groups SET avatar_icon_generation_claimed_at = 0 WHERE id = ?",
        group.id,
      );
    });
    const replacement = await userStub.claimChatGroupAvatarGenerationForThread(
      threadId,
    );
    expect(replacement?.claimId).not.toBe(firstClaim?.claimId);
    const staleResult = await userStub.setGeneratedChatGroupIcon(
      group.id,
      firstClaim!.claimId,
      "rocket",
    );
    expect(staleResult?.status).toBe("pending");

    await userStub.updateChatGroup(group.id, { name: "Name B" });
    const renamedResult = await userStub.setGeneratedChatGroupIcon(
      group.id,
      replacement!.claimId,
      "rocket",
    );
    expect(renamedResult?.status).toBe("pending");
    const renamedClaim = await userStub.claimChatGroupAvatarGenerationForThread(
      threadId,
    );
    expect(renamedClaim?.name).toBe("Name B");

    await userStub.updateChatGroup(group.id, {
      avatar: { color: "#e0476b", content: "sparkles" },
    });
    const userWon = await userStub.setGeneratedChatGroupIcon(
      group.id,
      renamedClaim!.claimId,
      "rocket",
    );
    expect(userWon).toMatchObject({ content: "sparkles", status: "user" });
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
      content: DEFAULT_CHAT_GROUP_ICON,
      status: "default",
    });
    expect(second.avatar).toEqual({
      color: AVATAR_COLORS[1],
      content: DEFAULT_CHAT_GROUP_ICON,
      status: "default",
    });
    expect(otherWorkspace.avatar).toEqual({
      color: AVATAR_COLORS[0],
      content: DEFAULT_CHAT_GROUP_ICON,
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
    const threadId = crypto.randomUUID();
    await userStub.addThreadToGroup(group.id, threadId);
    const claim = await userStub.claimChatGroupAvatarGenerationForThread(
      threadId,
      "first_title",
    );
    expect(claim).not.toBeNull();

    await userStub.setGeneratedChatGroupIcon(
      group.id,
      claim!.claimId,
      "rocket",
    );
    let summary = await userStub.getChatGroupSummary(group.id);
    expect(summary?.avatar.content).toBe("rocket");

    await userStub.updateChatGroup(group.id, {
      name: "Design systems",
      avatar: { color: "#e0476b", content: "sparkles" },
    });
    summary = await userStub.getChatGroupSummary(group.id);
    expect(summary?.name).toBe("Design systems");
    expect(summary?.avatar).toEqual({
      color: "#E0476B",
      content: "sparkles",
      status: "user",
    });
    expect(summary?.updated_at).toBe(group.updated_at);

    await userStub.setGeneratedChatGroupIcon(group.id, claim!.claimId, "bug");
    summary = await userStub.getChatGroupSummary(group.id);
    expect(summary?.avatar.content).toBe("sparkles");
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

    const claim = await userStub.claimChatGroupAvatarGenerationForThread(
      threadId,
      "first_title",
    );
    expect(claim).toMatchObject({
      id: group.id,
      name: "Generated title",
      avatar: {
        color: AVATAR_COLORS[0],
        content: DEFAULT_CHAT_GROUP_ICON,
        status: "pending",
      },
      trigger: "first_title",
    });
    expect(claim?.claimId).toEqual(expect.any(String));
    expect(claim?.claimedAt).toEqual(expect.any(Number));

    // Once an icon is generated, the group is no longer claimable.
    await userStub.setGeneratedChatGroupIcon(
      group.id,
      claim!.claimId,
      "rocket",
    );
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

    const claim = await userStub.claimChatGroupAvatarGenerationForThread(threadId);
    expect(claim).toMatchObject({ id: group.id });

    // A failed attempt is a one-shot: it stays on the default avatar but is not
    // claimed again on the next websocket connection.
    const marked = await userStub.markChatGroupAvatarGenerationFailed(
      group.id,
      claim!.claimId,
    );
    expect(marked).toMatchObject({
      content: DEFAULT_CHAT_GROUP_ICON,
      status: "default",
    });
    await expect(
      userStub.claimChatGroupAvatarGenerationForThread(threadId),
    ).resolves.toBeNull();
  });

  it("claims queued migration rows from an accessed thread", async () => {
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

    // Simulate a V11 row queued by legacy classification.
    await runInDurableObject(userStub, async (instance) => {
      instance.ctx.storage.sql.exec(
        `UPDATE chat_groups
         SET avatar_content_source = 'default',
             avatar_icon_generation_state = 'queued'
         WHERE id = ?`,
        group.id,
      );
    });

    const claim = await userStub.claimChatGroupAvatarGenerationForThread(threadId);
    expect(claim).toMatchObject({ id: group.id });

    const marked = await userStub.markChatGroupAvatarGenerationFailed(
      group.id,
      claim!.claimId,
    );
    expect(marked).toMatchObject({
      content: DEFAULT_CHAT_GROUP_ICON,
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

    const claim = await userStub.claimChatGroupAvatarGenerationForThread(threadId);
    await userStub.updateChatGroup(group.id, {
      avatar: { color: "#e0476b", content: "sparkles" },
    });
    const marked = await userStub.markChatGroupAvatarGenerationFailed(
      group.id,
      claim!.claimId,
    );
    expect(marked).toMatchObject({ content: "sparkles", status: "user" });
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
        content: DEFAULT_CHAT_GROUP_ICON,
        status: "pending",
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
      avatar: { color: "#e0476b", content: "sparkles" },
    });
    const generatedClaim =
      await userStub.claimChatGroupAvatarGenerationForThread(generatedThreadId);
    await userStub.setGeneratedChatGroupIcon(
      generatedGroup.id,
      generatedClaim!.claimId,
      "rocket",
    );
    await userStub.updateChatGroup(userGroup.id, { name: "Renamed user avatar" });
    await userStub.updateChatGroup(generatedGroup.id, {
      name: "Renamed generated avatar",
    });

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

  it("writes generated icons for claimed single-thread groups with fallback names", async () => {
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

    const claim = await userStub.claimChatGroupAvatarGenerationForThread(threadId);
    await userStub.setGeneratedChatGroupIcon(
      summary.id,
      claim!.claimId,
      "rocket",
    );

    const updated = await userStub.getChatGroupSummary(summary.id);
    expect(updated?.name).toBe("Fallback title");
    expect(updated?.avatar.content).toBe("rocket");
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
