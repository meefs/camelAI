import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { DiscordControlDO } from "../src/discord-control-do";
import { DiscordBridgeError } from "../src/types";

interface DiscordBridgeTestEnv {
  CONTROL: DurableObjectNamespace<DiscordControlDO>;
}

const testEnv = env as unknown as DiscordBridgeTestEnv;

function controlStub(name = `control-test:${crypto.randomUUID()}`): DurableObjectStub<DiscordControlDO> {
  return testEnv.CONTROL.get(testEnv.CONTROL.idFromName(name));
}

function fakeDiscordRest(overrides: Record<string, unknown> = {}) {
  return {
    getCurrentUser: async () => ({ id: "123456789012345678", username: "Camel" }),
    getGuild: async (guildId: string) => ({ id: guildId, name: "Test guild" }),
    getGuildChannels: async () => [
      { id: "channel-1", type: 0, name: "prompt-haiku", position: 1 },
      { id: "channel-2", type: 0, name: "other", position: 2 },
    ],
    getGuildRoles: async (guildId: string) => [
      { id: guildId, name: "@everyone", permissions: "309237763072" },
    ],
    getGuildMember: async () => ({
      user: { id: "123456789012345678" },
      roles: [],
    }),
    createStarterFailureNotice: async () => ({ id: "failure-notice-1" }),
    createMessages: async () => ({
      messageIds: ["binding-confirmation-1"],
      chunkCount: 1,
    }),
    startThreadFromMessage: async (args: {
      parentChannelId: string;
      messageId: string;
      name: string;
    }) => ({
      id: args.messageId,
      name: args.name,
      parent_id: args.parentChannelId,
    }),
    ...overrides,
  };
}

async function installRest(
  stub: DurableObjectStub<DiscordControlDO>,
  rest: Record<string, unknown> = fakeDiscordRest(),
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    Reflect.set(instance, "rest", rest);
  });
}

async function installQueue(
  stub: DurableObjectStub<DiscordControlDO>,
  send: (message: unknown) => Promise<void>,
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const currentEnv = Reflect.get(instance, "env") as Record<string, unknown>;
    Reflect.set(instance, "env", {
      ...currentEnv,
      DISCORD_EVENTS_QUEUE: { send },
    });
  });
}

async function requestJson(
  stub: DurableObjectStub<DiscordControlDO>,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await stub.fetch(`https://discord-bridge.internal${path}`, init);
  const body = await response.json() as Record<string, unknown>;
  return { response, body };
}

function claimBody(options: {
  integrationId?: string;
  parentChannelId?: string;
  idempotencyKey?: string;
} = {}) {
  return {
    guildId: "guild-1",
    parentChannelId: options.parentChannelId ?? "channel-1",
    integrationId: options.integrationId ?? "integration-1",
    orgId: "org-1",
    workspaceId: "workspace-1",
    idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
  };
}

async function claim(
  stub: DurableObjectStub<DiscordControlDO>,
  body: Record<string, unknown> = claimBody(),
) {
  return requestJson(stub, "/internal/v1/bindings/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("DiscordControlDO binding state", () => {
  it("reclaims a released channel and rejects competing ownership", async () => {
    const stub = controlStub();
    await installRest(stub);

    const firstInput = claimBody({ idempotencyKey: "claim-first" });
    const first = await claim(stub, firstInput);
    expect(first.response.status).toBe(200);
    expect(first.body.binding).toMatchObject({
      integrationId: "integration-1",
      parentChannelId: "channel-1",
      version: 1,
    });

    const replay = await claim(stub, firstInput);
    expect(replay.body.binding).toEqual(first.body.binding);

    const conflict = await claim(stub, claimBody({
      integrationId: "integration-2",
      idempotencyKey: "competing-claim",
    }));
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error).toBe("binding_conflict");

    const released = await requestJson(
      stub,
      "/internal/v1/bindings/integration-1?version=1",
      { method: "DELETE" },
    );
    expect(released.body).toMatchObject({ ok: true, released: true });

    const reclaimed = await claim(stub, claimBody({ idempotencyKey: "claim-after-release" }));
    expect(reclaimed.response.status).toBe(200);
    expect(reclaimed.body.binding).toMatchObject({
      integrationId: "integration-1",
      parentChannelId: "channel-1",
      version: 2,
    });
  });

  it("keeps the prior binding when replacement confirmation fails", async () => {
    const stub = controlStub();
    const createMessages = vi.fn()
      .mockResolvedValueOnce({
        messageIds: ["initial-confirmation"],
        chunkCount: 1,
      })
      .mockRejectedValueOnce(
        new DiscordBridgeError("missing_permissions", "Send Messages is missing"),
      );
    await installRest(stub, fakeDiscordRest({ createMessages }));
    await claim(stub, claimBody({ idempotencyKey: "initial-binding" }));

    const replacement = await claim(stub, {
      ...claimBody({
        parentChannelId: "channel-2",
        idempotencyKey: "failed-replacement",
      }),
      expectedVersion: 1,
    });
    expect(replacement.response.status).toBe(403);

    const current = await requestJson(stub, "/internal/v1/bindings/integration-1");
    expect(current.body.binding).toMatchObject({
      parentChannelId: "channel-1",
      version: 1,
    });
  });

  it("reports a live binding as misconfigured when channel permissions are revoked", async () => {
    const stub = controlStub();
    await installRest(stub);
    await claim(stub, claimBody({ idempotencyKey: "permissions-binding" }));

    await runInDurableObject(stub, async (instance) => {
      Reflect.set(instance, "rest", fakeDiscordRest({
        getGuildRoles: async () => [
          { id: "guild-1", name: "@everyone", permissions: "1024" },
        ],
      }));
      const currentEnv = Reflect.get(instance, "env") as Record<string, unknown>;
      Reflect.set(instance, "env", {
        ...currentEnv,
        GATEWAY: {
          idFromName: () => "gateway-id",
          get: () => ({
            health: async () => ({
              state: "ready",
              shardId: 0,
              shardCount: 1,
              readyAt: Date.now() - 1_000,
              resumedAt: null,
              heartbeatIntervalMs: 45_000,
              lastHeartbeatAt: Date.now() - 500,
              lastHeartbeatAckAt: Date.now(),
              lastSequence: 1,
              reconnectCount: 0,
              lastCloseCode: null,
              sessionStartsRemaining: 999,
              sessionStartsResetAt: Date.now() + 60_000,
              maxConcurrency: 1,
              recommendedShardCount: 1,
              contentMode: "full",
              fatalReason: null,
            }),
          }),
        },
      });
      const actor = instance as unknown as {
        verifyBinding(integrationId: string): Promise<Record<string, unknown>>;
      };
      await expect(actor.verifyBinding("integration-1")).resolves.toMatchObject({
        status: "misconfigured",
        message: expect.stringContaining("missing"),
        binding: { version: 1 },
      });
    });
  });

  it("coalesces concurrent proactive retries for the same operation", async () => {
    const stub = controlStub();
    let releaseCreate: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let finishCreate: (() => void) | undefined;
    const canFinish = new Promise<void>((resolve) => {
      finishCreate = resolve;
    });
    const startThreadFromMessage = vi.fn(async () => {
      releaseCreate?.();
      await canFinish;
      return {
        id: "123456789012345679",
        name: "Concurrent update",
        parent_id: "channel-1",
      };
    });
    const createMessages = vi.fn(async () => ({
      messageIds: ["proactive-starter-1"],
      chunkCount: 1,
    }));
    await installRest(stub, fakeDiscordRest({
      createMessages,
      startThreadFromMessage,
    }));
    await claim(stub, claimBody({ idempotencyKey: "proactive-binding" }));
    createMessages.mockClear();

    await runInDurableObject(stub, async (instance, state) => {
      const actor = instance as unknown as {
        startProactiveThread(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
      const input = {
        integrationId: "integration-1",
        name: "Concurrent update",
        starterText: "Only one visible update",
        idempotencyKey: "proactive-operation",
      };
      const first = actor.startProactiveThread(input);
      await createStarted;
      const retry = actor.startProactiveThread(input);
      finishCreate?.();

      await expect(Promise.all([first, retry])).resolves.toEqual([
        expect.objectContaining({ threadId: "123456789012345679" }),
        expect.objectContaining({ threadId: "123456789012345679" }),
      ]);
      expect(createMessages).toHaveBeenCalledTimes(1);
      expect(createMessages).toHaveBeenCalledWith(expect.objectContaining({
        text: "Only one visible update",
      }));
      expect(startThreadFromMessage).toHaveBeenCalledTimes(1);
      expect(state.storage.sql.exec<{ starter_notice_included: number }>(
        `SELECT starter_notice_included
         FROM proactive_thread_intents WHERE operation_id = ?`,
        "proactive-operation",
      ).toArray()[0]?.starter_notice_included).toBe(0);
      expect(state.storage.sql.exec<{ mention_notice_sent: number }>(
        "SELECT mention_notice_sent FROM thread_bindings WHERE thread_id = ?",
        "123456789012345679",
      ).toArray()[0]?.mention_notice_sent).toBe(0);
    });
  });

  it("puts the mention-only notice on the proactive starter exactly once", async () => {
    const stub = controlStub();
    const createMessages = vi.fn(async (args: { operationId: string }) => ({
      messageIds: [
        args.operationId.startsWith("proactive-starter:")
          ? "proactive-starter-notice"
          : "proactive-reply",
      ],
      chunkCount: 1,
    }));
    await installRest(stub, fakeDiscordRest({ createMessages }));
    await runInDurableObject(stub, (instance) => {
      const currentEnv = Reflect.get(instance, "env") as Record<string, unknown>;
      Reflect.set(instance, "env", {
        ...currentEnv,
        DISCORD_MESSAGE_CONTENT_MODE: "mention_only",
      });
    });
    await claim(stub, claimBody({ idempotencyKey: "notice-binding" }));
    createMessages.mockClear();

    const proactive = await requestJson(stub, "/internal/v1/threads/proactive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        integrationId: "integration-1",
        name: "Proactive notice",
        starterText: "The deploy finished",
        idempotencyKey: "proactive-notice-operation",
      }),
    });
    expect(proactive.response.status).toBe(200);
    expect(proactive.body.threadId).toBe("proactive-starter-notice");

    await runInDurableObject(stub, (instance, state) => {
      const binding = state.storage.sql.exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM channel_bindings WHERE integration_id = ?",
        "integration-1",
      ).toArray()[0];
      const actor = instance as unknown as {
        registerThread(input: Record<string, unknown>): void;
      };
      actor.registerThread({
        threadId: "proactive-starter-notice",
        binding,
        starter: true,
        mentionNoticeSent: false,
      });
      expect(state.storage.sql.exec<{ mention_notice_sent: number }>(
        "SELECT mention_notice_sent FROM thread_bindings WHERE thread_id = ?",
        "proactive-starter-notice",
      ).toArray()[0]?.mention_notice_sent).toBe(1);
    });

    const reply = await requestJson(stub, "/internal/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        integrationId: "integration-1",
        threadId: "proactive-starter-notice",
        text: "A second update",
        idempotencyKey: "proactive-notice-reply",
      }),
    });
    expect(reply.response.status).toBe(200);
    expect(createMessages).toHaveBeenCalledTimes(2);
    expect(createMessages.mock.calls[0]?.[0]).toMatchObject({
      text:
        "The deploy finished\n\nMention @Camel in every follow-up while Discord is in mention-only mode.",
    });
    expect(createMessages.mock.calls[1]?.[0]).toMatchObject({
      text: "A second update",
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ starter_notice_included: number }>(
        `SELECT starter_notice_included
         FROM proactive_thread_intents WHERE operation_id = ?`,
        "proactive-notice-operation",
      ).toArray()[0]?.starter_notice_included).toBe(1);
      expect(state.storage.sql.exec<{ mention_notice_sent: number }>(
        "SELECT mention_notice_sent FROM thread_bindings WHERE thread_id = ?",
        "proactive-starter-notice",
      ).toArray()[0]?.mention_notice_sent).toBe(1);
    });
  });

  it("performs zero Discord REST mutations while outbound is disabled", async () => {
    const stub = controlStub();
    const createMessages = vi.fn();
    const startThreadFromMessage = vi.fn();
    const createStarterFailureNotice = vi.fn();
    await installRest(stub, fakeDiscordRest({
      createMessages,
      startThreadFromMessage,
      createStarterFailureNotice,
    }));
    await runInDurableObject(stub, (instance) => {
      const currentEnv = Reflect.get(instance, "env") as Record<string, unknown>;
      Reflect.set(instance, "env", {
        ...currentEnv,
        DISCORD_OUTBOUND_ENABLED: "false",
      });
    });

    const mutations: Array<[string, Record<string, unknown>]> = [
      [
        "/internal/v1/bindings/activate",
        claimBody({ idempotencyKey: "kill-switch-binding" }),
      ],
      [
        "/internal/v1/threads/from-message",
        {
          integrationId: "integration-1",
          parentChannelId: "channel-1",
          messageId: "message-1",
          name: "Request",
          idempotencyKey: "from-message",
        },
      ],
      [
        "/internal/v1/threads/proactive",
        {
          integrationId: "integration-1",
          name: "Update",
          idempotencyKey: "proactive",
        },
      ],
      [
        "/internal/v1/messages",
        {
          integrationId: "integration-1",
          threadId: "thread-1",
          text: "Hello",
          idempotencyKey: "message",
        },
      ],
      [
        "/internal/v1/failure-notices",
        {
          integrationId: "integration-1",
          parentChannelId: "channel-1",
          messageId: "message-1",
          reason: "provider_unavailable",
          idempotencyKey: "failure-notice",
        },
      ],
    ];
    for (const [path, body] of mutations) {
      const result = await requestJson(stub, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(result.response.status).toBe(503);
      expect(result.body.error).toBe("not_configured");
    }

    await runInDurableObject(stub, async (instance) => {
      const actor = instance as unknown as {
        sendDeadLetterFailureNotice(notice: Record<string, unknown>): Promise<void>;
      };
      await expect(actor.sendDeadLetterFailureNotice({
        event_id: "event-1",
        integration_id: "integration-1",
        parent_channel_id: "channel-1",
        target_channel_id: "channel-1",
        discord_message_id: "message-1",
        state: "pending",
        created_at: Date.now(),
        updated_at: Date.now(),
      })).rejects.toMatchObject({ code: "not_configured" });
    });
    expect(createMessages).not.toHaveBeenCalled();
    expect(startThreadFromMessage).not.toHaveBeenCalled();
    expect(createStarterFailureNotice).not.toHaveBeenCalled();
  });

  it("coalesces lifecycle observations by binding version and permits reselection", async () => {
    const stub = controlStub();
    await installRest(stub);
    await claim(stub, claimBody({ idempotencyKey: "lifecycle-binding" }));
    const published: Array<{ version: number; eventId: string }> = [];
    await installQueue(stub, async (message) => {
      published.push(message as { version: number; eventId: string });
    });

    await runInDurableObject(stub, async (instance, state) => {
      const actor = instance as unknown as {
        handleGatewayDispatch(event: Record<string, unknown>): Promise<void>;
      };
      const channelDeleted = {
        op: 0,
        s: 20,
        t: "CHANNEL_DELETE",
        d: { id: "channel-1", guild_id: "guild-1" },
      };
      const guildRemoved = {
        op: 0,
        s: 21,
        t: "GUILD_DELETE",
        d: { id: "guild-1", unavailable: false },
      };
      await expect(actor.handleGatewayDispatch(channelDeleted)).resolves.toBeUndefined();
      await expect(actor.handleGatewayDispatch(channelDeleted)).resolves.toBeUndefined();
      await expect(actor.handleGatewayDispatch(guildRemoved)).resolves.toBeUndefined();
      expect(published).toHaveLength(1);
      const rows = state.storage.sql.exec<{
        discord_message_id: string;
        binding_version: number;
        payload_json: string | null;
      }>(
        "SELECT discord_message_id, binding_version, payload_json FROM ingress_outbox",
      ).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        discord_message_id: "binding-lifecycle:integration-1:1",
        binding_version: 1,
        payload_json: expect.any(String),
      });
      const payload = rows[0].payload_json;
      expect(payload).not.toBeNull();
      expect(JSON.parse(payload!)).toMatchObject({
        kind: "lifecycle",
        lifecycleType: "parent_channel_deleted",
        integrationId: "integration-1",
        parentChannelId: "channel-1",
        bindingVersion: 1,
      });
    });

    const released = await requestJson(
      stub,
      "/internal/v1/bindings/integration-1?version=1",
      { method: "DELETE" },
    );
    expect(released.body).toMatchObject({ ok: true, released: true });
    const reselected = await claim(stub, claimBody({ idempotencyKey: "lifecycle-reselect" }));
    expect(reselected.body.binding).toMatchObject({
      integrationId: "integration-1",
      parentChannelId: "channel-1",
      version: 2,
    });

    await runInDurableObject(stub, async (instance, state) => {
      const actor = instance as unknown as {
        handleGatewayDispatch(event: Record<string, unknown>): Promise<void>;
      };
      await expect(actor.handleGatewayDispatch({
        op: 0,
        s: 22,
        t: "GUILD_DELETE",
        d: { id: "guild-1", unavailable: false },
      })).resolves.toBeUndefined();
      expect(published).toHaveLength(2);
      expect(state.storage.sql.exec<{
        discord_message_id: string;
        binding_version: number;
      }>(
        `SELECT discord_message_id, binding_version
         FROM ingress_outbox ORDER BY binding_version`,
      ).toArray()).toEqual([
        {
          discord_message_id: "binding-lifecycle:integration-1:1",
          binding_version: 1,
        },
        {
          discord_message_id: "binding-lifecycle:integration-1:2",
          binding_version: 2,
        },
      ]);
    });
  });
});

describe("DiscordControlDO delivery recovery", () => {
  it("prunes terminal auxiliary state while retaining rows needed by live work", async () => {
    const stub = controlStub();
    await installRest(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      const old = now - 181 * 24 * 60 * 60 * 1_000;

      for (const conversationKey of [
        "terminal-old",
        "guild-1:thread-live",
        "live-outbox",
      ]) {
        state.storage.sql.exec(
          `INSERT INTO conversation_state (
            conversation_key, completed_ordinal, updated_at
          ) VALUES (?, 0, ?)`,
          conversationKey,
          old,
        );
      }

      state.storage.sql.exec(
        `INSERT INTO thread_bindings (
          thread_id, guild_id, parent_channel_id, integration_id, org_id,
          workspace_id, next_ingress_ordinal, mention_notice_sent,
          created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 2, 0, ?, ?)`,
        "thread-live",
        "guild-1",
        "channel-1",
        "integration-live",
        "org-1",
        "workspace-1",
        now,
        now,
      );

      for (const [eventId, conversationKey, ordinal] of [
        ["notice-live", "live-outbox", 1],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO ingress_outbox (
            event_id, discord_message_id, conversation_key, ordinal,
            binding_version, payload_json, state, lease_token,
            lease_expires_at, enqueue_attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, '{}', 'leased', ?, ?, 1, ?, ?)`,
          eventId,
          `message:${eventId}`,
          conversationKey,
          ordinal,
          `lease:${eventId}`,
          now + 60_000,
          now,
          now,
        );
      }

      for (const [eventId, noticeState] of [
        ["notice-terminal", "sent"],
        ["notice-pending", "pending"],
        ["notice-live", "suppressed"],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO failure_notices (
            event_id, integration_id, parent_channel_id, target_channel_id,
            discord_message_id, state, created_at, updated_at
          ) VALUES (?, 'integration-1', 'channel-1', 'channel-1', ?, ?, ?, ?)`,
          eventId,
          `message:${eventId}`,
          noticeState,
          old,
          old,
        );
      }

      for (const [operationId, threadId] of [
        ["proactive-terminal", "orphan-thread"],
        ["proactive-live-thread", "thread-live"],
        ["proactive-pending", null],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO proactive_thread_intents (
            operation_id, integration_id, guild_id, parent_channel_id,
            thread_name, starter_message_id, thread_id, started_at, updated_at
          ) VALUES (?, 'integration-1', 'guild-1', 'channel-1', 'Update', ?, ?, ?, ?)`,
          operationId,
          `starter:${operationId}`,
          threadId,
          old,
          old,
        );
      }

      const actor = instance as unknown as { maintenance(): Promise<void> };
      await actor.maintenance();

      const conversationKeys = state.storage.sql.exec<{ conversation_key: string }>(
        "SELECT conversation_key FROM conversation_state ORDER BY conversation_key",
      ).toArray().map((row) => row.conversation_key);
      expect(conversationKeys).not.toContain("terminal-old");
      expect(conversationKeys).toEqual(expect.arrayContaining([
        "guild-1:thread-live",
        "live-outbox",
      ]));

      const noticeIds = state.storage.sql.exec<{ event_id: string }>(
        "SELECT event_id FROM failure_notices ORDER BY event_id",
      ).toArray().map((row) => row.event_id);
      expect(noticeIds).not.toContain("notice-terminal");
      expect(noticeIds).toEqual(expect.arrayContaining([
        "notice-live",
        "notice-pending",
      ]));

      const proactiveIds = state.storage.sql.exec<{ operation_id: string }>(
        "SELECT operation_id FROM proactive_thread_intents ORDER BY operation_id",
      ).toArray().map((row) => row.operation_id);
      expect(proactiveIds).not.toContain("proactive-terminal");
      expect(proactiveIds).toEqual(expect.arrayContaining([
        "proactive-live-thread",
        "proactive-pending",
      ]));
    });
  });

  it("persists Gateway ingress, retries queue publication by alarm, and deduplicates replay", async () => {
    const stub = controlStub();
    await installRest(stub);
    await claim(stub, claimBody({ idempotencyKey: "ingress-binding" }));
    let failPublish = true;
    const published: Array<{ version: number; eventId: string }> = [];
    const queueSend = vi.fn(async (message: unknown) => {
      if (failPublish) throw new Error("queue unavailable");
      published.push(message as { version: number; eventId: string });
    });
    await installQueue(stub, queueSend);

    const dispatch = {
      op: 0,
      s: 10,
      t: "MESSAGE_CREATE",
      d: {
        id: "discord-message-1",
        guild_id: "guild-1",
        channel_id: "channel-1",
        content: "<@123456789012345678> hello",
        type: 0,
        author: { id: "discord-user-1", username: "tester", bot: false },
        mentions: [{ id: "123456789012345678", username: "Camel", bot: true }],
        attachments: [],
      },
    };

    await runInDurableObject(stub, async (instance, state) => {
      const actor = instance as unknown as {
        setBotIdentity(id: string): Promise<void>;
        handleGatewayDispatch(event: Record<string, unknown>): Promise<void>;
        alarm(): Promise<void>;
      };
      await actor.setBotIdentity("123456789012345678");
      await expect(actor.handleGatewayDispatch(dispatch)).rejects.toThrow("queue unavailable");
      expect(state.storage.sql.exec<{ state: string; enqueue_attempts: number }>(
        "SELECT state, enqueue_attempts FROM ingress_outbox WHERE discord_message_id = ?",
        "discord-message-1",
      ).toArray()[0]).toEqual({ state: "pending", enqueue_attempts: 1 });

      failPublish = false;
      await actor.alarm();
      await actor.handleGatewayDispatch(dispatch);
      expect(queueSend).toHaveBeenCalledTimes(2);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ version: 1, eventId: expect.any(String) });
      expect(state.storage.sql.exec<{
        state: string;
        enqueue_attempts: number;
        payload_json: string;
      }>(
        "SELECT state, enqueue_attempts, payload_json FROM ingress_outbox WHERE discord_message_id = ?",
        "discord-message-1",
      ).toArray()[0]).toMatchObject({
        state: "enqueued",
        enqueue_attempts: 2,
        payload_json: expect.stringContaining('"ordinal":1'),
      });
    });

    const eventId = published[0].eventId;
    const claimed = await requestJson(
      stub,
      `/internal/v1/deliveries/${eventId}/claim`,
      { method: "POST" },
    );
    expect(claimed.body).toMatchObject({
      status: "claimed",
      leaseToken: expect.any(String),
      payload: { discordMessageId: "discord-message-1", ordinal: 1 },
    });
    const completed = await requestJson(
      stub,
      `/internal/v1/deliveries/${eventId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leaseToken: claimed.body.leaseToken }),
      },
    );
    expect(completed.body.ok).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string; payload_json: string | null }>(
        "SELECT state, payload_json FROM ingress_outbox WHERE event_id = ?",
        eventId,
      ).toArray()[0]).toEqual({ state: "completed", payload_json: null });
    });
  });

  it("parks an ordered delivery until its predecessor republishes it", async () => {
    const stub = controlStub();
    const published: Array<{ version: number; eventId: string }> = [];
    await installQueue(stub, async (message) => {
      published.push(message as { version: number; eventId: string });
    });
    const payload = {
      kind: "message",
      discordMessageId: "message-1",
      guildId: "guild-1",
      channelId: "thread-1",
      parentChannelId: "channel-1",
      threadId: "thread-1",
      integrationId: "integration-1",
      orgId: "org-1",
      workspaceId: "workspace-1",
      bindingVersion: 1,
      ordinal: 1,
      content: "hello",
      messageType: 0,
      author: {
        id: "user-1",
        username: "user",
        globalName: null,
        guildNickname: null,
      },
      mentions: [],
      attachments: [],
      timestamp: null,
      contentMode: "full",
      starter: false,
    };
    await runInDurableObject(stub, (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO conversation_state (
          conversation_key, completed_ordinal, updated_at
        ) VALUES (?, 0, ?)`,
        "ordered-conversation",
        now,
      );
      for (const [eventId, ordinal, outboxState] of [
        ["ordered-event-1", 1, "enqueued"],
        ["ordered-event-2", 2, "enqueued"],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO ingress_outbox (
            event_id, discord_message_id, conversation_key, ordinal,
            binding_version, payload_json, state, lease_token,
            lease_expires_at, enqueue_attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, NULL, 1, ?, ?)`,
          eventId,
          `message-${ordinal}`,
          "ordered-conversation",
          ordinal,
          JSON.stringify({
            ...payload,
            discordMessageId: `message-${ordinal}`,
            ordinal,
          }),
          outboxState,
          now,
          now,
        );
      }
    });

    const ordered = await requestJson(
      stub,
      "/internal/v1/deliveries/ordered-event-2/claim",
      { method: "POST" },
    );
    expect(ordered.body).toEqual({ ok: true, status: "ordered_wait" });

    const predecessor = await requestJson(
      stub,
      "/internal/v1/deliveries/ordered-event-1/claim",
      { method: "POST" },
    );
    expect(predecessor.body.status).toBe("claimed");
    await requestJson(
      stub,
      "/internal/v1/deliveries/ordered-event-1/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leaseToken: predecessor.body.leaseToken }),
      },
    );

    await runInDurableObject(stub, async (instance, state) => {
      expect(state.storage.sql.exec<{
        state: string;
        payload_json: string | null;
      }>(
        "SELECT state, payload_json FROM ingress_outbox WHERE event_id = ?",
        "ordered-event-2",
      ).toArray()[0]).toMatchObject({
        state: "pending",
        payload_json: expect.any(String),
      });
      const actor = instance as unknown as { alarm(): Promise<void> };
      await actor.alarm();
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM ingress_outbox WHERE event_id = ?",
        "ordered-event-2",
      ).toArray()[0]?.state).toBe("enqueued");
    });
    expect(published).toEqual([
      { version: 1, eventId: "ordered-event-2" },
    ]);

    const successor = await requestJson(
      stub,
      "/internal/v1/deliveries/ordered-event-2/claim",
      { method: "POST" },
    );
    expect(successor.body).toMatchObject({
      status: "claimed",
      leaseToken: expect.any(String),
      payload: {
        discordMessageId: "message-2",
        ordinal: 2,
      },
    });
  });

  it("accepts only this bot's managed role mention in the bound parent channel", async () => {
    const botUserId = "123456789012345678";
    const botRoleId = "223456789012345678";
    const otherRoleId = "323456789012345678";
    const stub = controlStub();
    await installRest(stub, fakeDiscordRest({
      getGuildRoles: async (guildId: string) => [
        { id: guildId, name: "@everyone", permissions: "309237763072" },
        {
          id: botRoleId,
          name: "Camel",
          permissions: "0",
          managed: true,
          tags: { bot_id: botUserId },
        },
        {
          id: otherRoleId,
          name: "Support",
          permissions: "0",
          managed: false,
        },
      ],
    }));
    await claim(stub, claimBody({ idempotencyKey: "managed-role-binding" }));
    const queueSend = vi.fn(async () => undefined);
    await installQueue(stub, queueSend);

    await runInDurableObject(stub, async (instance, state) => {
      const actor = instance as unknown as {
        setBotIdentity(id: string): Promise<void>;
        handleGatewayDispatch(event: Record<string, unknown>): Promise<void>;
      };
      await actor.setBotIdentity(botUserId);
      await actor.handleGatewayDispatch({
        op: 0,
        s: 20,
        t: "MESSAGE_CREATE",
        d: {
          id: "unrelated-role-message",
          guild_id: "guild-1",
          channel_id: "channel-1",
          content: `<@&${otherRoleId}> should stay filtered`,
          type: 0,
          author: { id: "discord-user-1", username: "tester", bot: false },
          mentions: [],
          mention_roles: [otherRoleId],
          attachments: [],
        },
      });
      expect(queueSend).not.toHaveBeenCalled();

      await actor.handleGatewayDispatch({
        op: 0,
        s: 21,
        t: "MESSAGE_CREATE",
        d: {
          id: "managed-bot-role-message",
          guild_id: "guild-1",
          channel_id: "channel-1",
          content: `<@&${botRoleId}> parent channel test`,
          type: 0,
          author: { id: "discord-user-1", username: "tester", bot: false },
          mentions: [],
          mention_roles: [botRoleId],
          attachments: [],
        },
      });

      expect(queueSend).toHaveBeenCalledOnce();
      const row = state.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM ingress_outbox WHERE discord_message_id = ?",
        "managed-bot-role-message",
      ).toArray()[0];
      expect(JSON.parse(row.payload_json)).toMatchObject({
        content: "parent channel test",
        starter: true,
      });
    });
  });

  it("uses DLQ authority over an active lease, advances ordering, and notices once", async () => {
    const sendNotice = vi.fn(async () => ({ id: "failure-notice-1" }));
    const stub = controlStub();
    await installRest(stub, fakeDiscordRest({ createStarterFailureNotice: sendNotice }));
    await claim(stub, claimBody({ idempotencyKey: "delivery-binding" }));

    const payload = {
      kind: "message",
      discordMessageId: "message-1",
      guildId: "guild-1",
      channelId: "thread-1",
      parentChannelId: "channel-1",
      threadId: "thread-1",
      integrationId: "integration-1",
      orgId: "org-1",
      workspaceId: "workspace-1",
      bindingVersion: 1,
      ordinal: 1,
      content: "hello",
      messageType: 0,
      author: { id: "user-1", username: "user", globalName: null, guildNickname: null },
      mentions: [],
      attachments: [],
      timestamp: null,
      contentMode: "full",
      starter: false,
    };
    await runInDurableObject(stub, (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "INSERT INTO conversation_state (conversation_key, completed_ordinal, updated_at) VALUES (?, 0, ?)",
        "conversation-1",
        now,
      );
      for (const [eventId, ordinal, outboxState] of [
        ["event-1", 1, "pending"],
        ["event-2", 2, "enqueued"],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO ingress_outbox (
            event_id, discord_message_id, conversation_key, ordinal,
            binding_version, payload_json, state, lease_token,
            lease_expires_at, enqueue_attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, NULL, 0, ?, ?)`,
          eventId,
          `message-${ordinal}`,
          "conversation-1",
          ordinal,
          JSON.stringify({ ...payload, discordMessageId: `message-${ordinal}`, ordinal }),
          outboxState,
          now,
          now,
        );
      }
    });

    const activeLease = await requestJson(
      stub,
      "/internal/v1/deliveries/event-1/claim",
      { method: "POST" },
    );
    expect(activeLease.body.status).toBe("claimed");

    const deadLetter = await requestJson(
      stub,
      "/internal/v1/deliveries/event-1/dead-letter",
      { method: "POST" },
    );
    expect(deadLetter.body.status).toBe("failed");

    const duplicate = await requestJson(
      stub,
      "/internal/v1/deliveries/event-1/dead-letter",
      { method: "POST" },
    );
    expect(duplicate.body.status).toBe("failed");
    expect(sendNotice).toHaveBeenCalledTimes(1);

    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec<{
        event_id: string;
        state: string;
        payload_json: string | null;
      }>(
        "SELECT event_id, state, payload_json FROM ingress_outbox ORDER BY ordinal",
      ).toArray();
      expect(rows).toEqual([
        { event_id: "event-1", state: "failed", payload_json: null },
        {
          event_id: "event-2",
          state: expect.stringMatching(/^(pending|enqueued)$/),
          payload_json: expect.any(String),
        },
      ]);
      expect(state.storage.sql.exec<{ completed_ordinal: number }>(
        "SELECT completed_ordinal FROM conversation_state WHERE conversation_key = ?",
        "conversation-1",
      ).toArray()[0]?.completed_ordinal).toBe(1);
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM failure_notices WHERE event_id = ?",
        "event-1",
      ).toArray()[0]?.state).toBe("sent");
    });
  });

  it("recovers a proactive thread by its stable starter message after an ambiguous response and restart", async () => {
    const createdThreadId = "stable-starter-message-1";
    const createMessages = vi.fn(async () => ({
      messageIds: [createdThreadId],
      chunkCount: 1,
    }));
    const startThreadFromMessage = vi.fn()
      .mockRejectedValueOnce(
        new DiscordBridgeError("provider_unavailable", "response lost"),
      )
      .mockResolvedValueOnce({
        id: createdThreadId,
        type: 11,
        name: "Daily update",
        parent_id: "channel-1",
      });
    const stub = controlStub();
    await installRest(stub, fakeDiscordRest({
      createMessages,
      startThreadFromMessage,
      getActiveGuildThreads: vi.fn(() => {
        throw new Error("name/time recovery must not be used");
      }),
    }));
    await runInDurableObject(stub, (instance) => {
      const currentEnv = Reflect.get(instance, "env") as Record<string, unknown>;
      Reflect.set(instance, "env", {
        ...currentEnv,
        DISCORD_MESSAGE_CONTENT_MODE: "mention_only",
      });
    });
    await claim(stub, claimBody({ idempotencyKey: "proactive-binding" }));
    createMessages.mockClear();

    const input = {
      integrationId: "integration-1",
      name: "Daily update",
      starterText: "Daily update body",
      idempotencyKey: "stable-tool-call:thread",
    };
    const first = await requestJson(stub, "/internal/v1/threads/proactive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(first.response.status).toBe(503);
    expect(first.body.error).toBe("provider_unavailable");
    await runInDurableObject(stub, (instance) => {
      Reflect.set(instance, "proactiveThreadInFlight", new Map());
      const currentEnv = Reflect.get(instance, "env") as Record<string, unknown>;
      Reflect.set(instance, "env", {
        ...currentEnv,
        DISCORD_MESSAGE_CONTENT_MODE: "full",
      });
    });

    const recovered = await requestJson(stub, "/internal/v1/threads/proactive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(recovered.response.status).toBe(200);
    expect(recovered.body.threadId).toBe(createdThreadId);
    expect(recovered.body.starterMessageId).toBe(createdThreadId);

    const replay = await requestJson(stub, "/internal/v1/threads/proactive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(replay.body.threadId).toBe(createdThreadId);
    expect(createMessages).toHaveBeenCalledTimes(1);
    expect(createMessages).toHaveBeenCalledWith(expect.objectContaining({
      text:
        "Daily update body\n\nMention @Camel in every follow-up while Discord is in mention-only mode.",
    }));
    expect(startThreadFromMessage).toHaveBeenCalledTimes(2);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ starter_notice_included: number }>(
        `SELECT starter_notice_included
         FROM proactive_thread_intents WHERE operation_id = ?`,
        "stable-tool-call:thread",
      ).toArray()[0]?.starter_notice_included).toBe(1);
      expect(state.storage.sql.exec<{ mention_notice_sent: number }>(
        "SELECT mention_notice_sent FROM thread_bindings WHERE thread_id = ?",
        createdThreadId,
      ).toArray()[0]?.mention_notice_sent).toBe(1);
    });
  });

  it("isolates concurrent same-name proactive operations by starter-message identity", async () => {
    const stub = controlStub();
    const createMessages = vi.fn(async (args: { operationId: string }) => ({
      messageIds: [`starter:${args.operationId}`],
      chunkCount: 1,
    }));
    const startThreadFromMessage = vi.fn(async (args: {
      parentChannelId: string;
      messageId: string;
      name: string;
    }) => ({
      id: args.messageId,
      name: args.name,
      parent_id: args.parentChannelId,
    }));
    await installRest(stub, fakeDiscordRest({
      createMessages,
      startThreadFromMessage,
      getActiveGuildThreads: vi.fn(() => ({
        threads: [
          { id: "unrelated-1", type: 11, name: "Same name", parent_id: "channel-1" },
          { id: "unrelated-2", type: 11, name: "Same name", parent_id: "channel-1" },
        ],
      })),
    }));
    await claim(stub, claimBody({ idempotencyKey: "proactive-binding" }));
    createMessages.mockClear();

    const send = (operationId: string) => requestJson(
      stub,
      "/internal/v1/threads/proactive",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationId: "integration-1",
          name: "Same name",
          starterText: "Same body",
          idempotencyKey: operationId,
        }),
      },
    );
    const [first, second] = await Promise.all([
      send("proactive-operation-1"),
      send("proactive-operation-2"),
    ]);

    expect(first.body.threadId).toBe(
      "starter:proactive-starter:proactive-operation-1",
    );
    expect(second.body.threadId).toBe(
      "starter:proactive-starter:proactive-operation-2",
    );
    expect(new Set([first.body.threadId, second.body.threadId]).size).toBe(2);
    expect(createMessages).toHaveBeenCalledTimes(2);
    expect(startThreadFromMessage).toHaveBeenCalledTimes(2);
  });
});
