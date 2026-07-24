import { describe, expect, it } from "vitest";
import {
  calculateDiscordChannelPermissions,
  calculateDiscordEveryonePermissions,
  DISCORD_REQUIRED_BOT_PERMISSIONS_DECIMAL,
  discordEveryoneCanPost,
  missingDiscordBotPermissions,
} from "../src/discord-permissions";
import { DiscordRestClient } from "../src/discord-rest";
import { discordOutboundTextWithNotice } from "../src/gateway-protocol";

describe("Discord control primitives", () => {
  it("keeps the exact minimal bot permission mask", () => {
    expect(DISCORD_REQUIRED_BOT_PERMISSIONS_DECIMAL).toBe("309237763072");
  });

  it("applies everyone, role, and member overwrites in Discord order", () => {
    const permissions = calculateDiscordChannelPermissions({
      guildId: "guild",
      roles: [
        { id: "guild", permissions: "1024" },
        { id: "bot-role", permissions: "309237762048" },
      ],
      member: { user: { id: "bot" }, roles: ["bot-role"] },
      channel: {
        id: "channel",
        type: 0,
        permission_overwrites: [
          { id: "guild", type: 0, allow: "0", deny: "2048" },
          { id: "bot-role", type: 0, allow: "2048", deny: "0" },
        ],
      },
    });
    expect(missingDiscordBotPermissions(permissions)).toEqual([]);
    const everyone = calculateDiscordEveryonePermissions({
      guildId: "guild",
      roles: [
        { id: "guild", permissions: String(1024 | 2048) },
      ],
      channel: { id: "channel", type: 0 },
    });
    expect(discordEveryoneCanPost(everyone)).toBe(true);
  });

  it("invalidates all permissions when View Channel is denied", () => {
    const permissions = calculateDiscordChannelPermissions({
      guildId: "guild",
      roles: [{ id: "guild", permissions: "309237763072" }],
      member: { user: { id: "bot" }, roles: [] },
      channel: {
        id: "channel",
        type: 0,
        permission_overwrites: [
          { id: "bot", type: 1, allow: "0", deny: "1024" },
        ],
      },
    });
    expect(permissions).toBe(0n);
    expect(missingDiscordBotPermissions(permissions)).toContain("VIEW_CHANNEL");
  });

  it("always disables mentions and uses an idempotent nonce", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: `message-${bodies.length}` });
    };
    const client = new DiscordRestClient("token", fakeFetch);
    const result = await client.createMessages({
      threadId: "thread",
      operationId: "operation",
      text: "@everyone hello",
    });
    expect(result.messageIds).toEqual(["message-1"]);
    expect(bodies[0].allowed_mentions).toEqual({ parse: [], replied_user: false });
    expect(bodies[0].enforce_nonce).toBe(true);
    expect(String(bodies[0].nonce).length).toBeLessThanOrEqual(25);
  });

  it("invokes fetch without binding the REST client as its receiver", async () => {
    let receiver: unknown = "not-called";
    const fakeFetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(Response.json({
        url: "wss://gateway.discord.test",
        shards: 1,
        session_start_limit: {
          total: 1_000,
          remaining: 999,
          reset_after: 60_000,
          max_concurrency: 1,
        },
      }));
    } as typeof fetch;
    const client = new DiscordRestClient("token", fakeFetch);

    await expect(client.getGatewayBot()).resolves.toMatchObject({ shards: 1 });
    expect(receiver).toBeUndefined();
  });

  it("resumes a partial multi-chunk send without duplicating the first chunk", async () => {
    const stored = new Map<string, { id: string; nonce: string }>();
    let secondChunkFailures = 2;
    let postCount = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if ((init?.method || "GET") === "GET") {
        return Response.json([...stored.values()]);
      }
      const body = JSON.parse(String(init?.body)) as { nonce: string };
      postCount += 1;
      if (stored.size === 1 && !stored.has(body.nonce) && secondChunkFailures > 0) {
        secondChunkFailures -= 1;
        return Response.json({ message: "temporary" }, { status: 503 });
      }
      const existing = stored.get(body.nonce);
      if (existing) return Response.json(existing);
      const message = { id: `message-${stored.size + 1}`, nonce: body.nonce };
      stored.set(body.nonce, message);
      expect(url).toContain("/channels/thread/messages");
      return Response.json(message);
    };
    const client = new DiscordRestClient("token", fakeFetch);
    const text = `${"a".repeat(1_950)}\n\n${"b".repeat(300)}`;

    await expect(client.createMessages({
      threadId: "thread",
      operationId: "stable-tool-call:message",
      text,
    })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect([...stored.values()].map((message) => message.id)).toEqual(["message-1"]);

    await expect(client.createMessages({
      threadId: "thread",
      operationId: "stable-tool-call:message",
      text,
    })).resolves.toEqual({
      messageIds: ["message-1", "message-2"],
      chunkCount: 2,
    });
    expect(stored.size).toBe(2);
    expect(new Set([...stored.values()].map((message) => message.nonce)).size).toBe(2);
    expect(postCount).toBe(4);
  });

  it("classifies Discord's active-thread limit and builds a safe reply notice", async () => {
    let noticeBody: Record<string, unknown> | null = null;
    const fakeFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/threads")) {
        return Response.json({ code: 160_002 }, { status: 400 });
      }
      noticeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ id: "notice-1" });
    };
    const client = new DiscordRestClient("token", fakeFetch);

    await expect(client.startThreadFromMessage({
      parentChannelId: "parent",
      messageId: "starter",
      name: "Update",
    })).rejects.toMatchObject({ code: "active_thread_limit" });
    await client.createStarterFailureNotice({
      parentChannelId: "parent",
      messageId: "starter",
      operationId: "notice-operation",
      text: "Archive an older thread.",
    });
    expect(noticeBody).toMatchObject({
      content: "Archive an older thread.",
      enforce_nonce: true,
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: "starter", fail_if_not_exists: false },
    });
  });

  it("adds the mention-only instruction to only the first thread reply", () => {
    expect(discordOutboundTextWithNotice("Done", "mention_only", false)).toEqual({
      text: "Done\n\nMention @Camel in every follow-up while Discord is in mention-only mode.",
      includedNotice: true,
    });
    expect(discordOutboundTextWithNotice("Again", "mention_only", true)).toEqual({
      text: "Again",
      includedNotice: false,
    });
    expect(discordOutboundTextWithNotice("Done", "full", false)).toEqual({
      text: "Done",
      includedNotice: false,
    });
  });

  it("recovers an ambiguous archived starter thread by reading its known message id", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async (input) => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      if (calls === 2) {
        return Response.json({ code: 40_058 }, { status: 400 });
      }
      expect(String(input)).toContain("/channels/message-1");
      return Response.json({
        id: "message-1",
        type: 11,
        parent_id: "parent-1",
        name: "Request",
        thread_metadata: { archived: true },
      });
    };
    const client = new DiscordRestClient("token", fakeFetch);

    await expect(client.startThreadFromMessage({
      parentChannelId: "parent-1",
      messageId: "message-1",
      name: "Request",
    })).resolves.toMatchObject({ id: "message-1", parent_id: "parent-1" });
    expect(calls).toBe(3);
  });

  it("honors a short provider 429 and retries once", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { retry_after: 0.001, global: false },
          { status: 429, headers: { "retry-after": "0.001" } },
        );
      }
      return Response.json({ id: "thread-1" });
    };
    const client = new DiscordRestClient("token", fakeFetch);

    await expect(client.startThreadFromMessage({
      parentChannelId: "parent-1",
      messageId: "starter-1",
      name: "Update",
    })).resolves.toMatchObject({ id: "thread-1" });
    expect(calls).toBe(2);
  });
});
