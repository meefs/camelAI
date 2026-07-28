import { describe, expect, it, vi } from "vitest";
import { ChannelTools } from "../src/chat-channels.js";
import { CodeModeToolsBinding } from "../src/code-mode-tools.js";

describe("Discord proactive outbound idempotency", () => {
  it("derives the same first send operation from a persisted parent tool id after restart", async () => {
    const operations: string[] = [];
    const makeBinding = () => {
      const fake = Object.create(CodeModeToolsBinding.prototype) as {
        ctx: { props: Record<string, unknown> };
        discordSendInvocationCount: number;
      };
      fake.ctx = {
        props: {
          orgId: "org-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          userId: "user-1",
          parentToolUseId: "tool-js-exec-1",
        },
      };
      fake.discordSendInvocationCount = 0;
      Object.defineProperty(fake, "channelTools", {
        value: {
          sendChannelDiscordMessageTool: vi.fn(async (
            _context: unknown,
            _args: unknown,
            options: { operationId: string },
          ) => {
            operations.push(options.operationId);
            return { details: { status: "sent" } };
          }),
        },
      });
      return fake;
    };
    const send = (CodeModeToolsBinding.prototype as unknown as {
      sendDiscordMessage(args: Record<string, unknown>): Promise<unknown>;
    }).sendDiscordMessage;

    const firstActor = makeBinding();
    await send.call(firstActor, { text: "one" });
    await send.call(firstActor, { text: "two" });
    const restartedActor = makeBinding();
    await send.call(restartedActor, { text: "one" });

    expect(operations).toEqual([
      "discord-tool:tool-js-exec-1:1",
      "discord-tool:tool-js-exec-1:2",
      "discord-tool:tool-js-exec-1:1",
    ]);
  });

  it("reuses stable thread and message keys when the same tool operation is retried", async () => {
    const applicationId = "123456789012345678";
    const integration = {
      id: "discord-1",
      integration_type: "discord_channel",
      name: "Support",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: applicationId,
        guild_id: "guild-1",
        guild_name: "Camel",
        parent_channel_id: "parent-1",
        parent_channel_name: "support",
        bot_user_id: applicationId,
        binding_version: 7,
        message_content_mode: "full",
      }),
    };
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        return Response.json({
          ok: true,
          binding: {
            guildId: "guild-1",
            parentChannelId: "parent-1",
            integrationId: "discord-1",
            orgId: "org-1",
            workspaceId: "workspace-1",
            guildName: "Camel",
            parentChannelName: "support",
            version: 7,
          },
        });
      }
      const body = await request.json() as Record<string, unknown>;
      bodies.push({ path, body });
      if (path === "/internal/v1/threads/proactive") {
        return Response.json({
          ok: true,
          threadId: "thread-1",
          guildId: "guild-1",
          starterMessageId: "message-1",
        });
      }
      return Response.json({
        ok: true,
        threadId: "thread-1",
        integrationId: "discord-1",
        messageIds: ["message-1"],
        chunkCount: 1,
        attachmentCount: 0,
      });
    });
    const fake = Object.create(ChannelTools.prototype) as {
      env: Record<string, unknown>;
      getOriginatingChannelThread: () => Promise<null>;
      recordOutboundChannelHistory: () => Promise<string>;
      markThreadChannelUsedBestEffort: () => Promise<void>;
    };
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.recordOutboundChannelHistory = vi.fn(async () => "recorded");
    fake.markThreadChannelUsedBestEffort = vi.fn(async () => undefined);
    fake.env = {
      DISCORD_BRIDGE: { fetch: bridgeFetch },
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getWorkspaceIntegrations: async () => [integration],
          getWorkspaceIntegration: async () => integration,
        }),
      },
      R2_BUCKET: { get: vi.fn() },
    };
    const send = ChannelTools.prototype.sendChannelDiscordMessageTool;
    const context = {
      orgId: "org-1",
      workspaceId: "workspace-1",
      threadId: "camel-thread-1",
    };
    const options = { operationId: "discord-tool:tool-js-exec-1:1" };

    await send.call(fake as never, context as never, { text: "Status update" }, options);
    await send.call(fake as never, context as never, { text: "Status update" }, options);

    expect(bodies).toEqual([
      {
        path: "/internal/v1/threads/proactive",
        body: expect.objectContaining({
          idempotencyKey: "discord-tool:tool-js-exec-1:1:thread",
          starterText: "Status update",
        }),
      },
      {
        path: "/internal/v1/threads/proactive",
        body: expect.objectContaining({
          idempotencyKey: "discord-tool:tool-js-exec-1:1:thread",
          starterText: "Status update",
        }),
      },
    ]);
  });
});
