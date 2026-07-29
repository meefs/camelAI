import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { DiscordGatewayDO } from "../src/discord-gateway-do";
import type { DiscordGatewayHealthState } from "../src/types";

interface DiscordBridgeTestEnv {
  GATEWAY: DurableObjectNamespace<DiscordGatewayDO>;
}

const testEnv = env as unknown as DiscordBridgeTestEnv;

function gatewayStub(
  name = `gateway-state-test:${crypto.randomUUID()}`,
): DurableObjectStub<DiscordGatewayDO> {
  return testEnv.GATEWAY.get(testEnv.GATEWAY.idFromName(name));
}

async function verifyConfigurationRecovery(options: {
  fatalReason: "gateway_close_4004" | "application_identity_mismatch";
  correctedEnv: Record<string, string>;
}): Promise<void> {
  const stub = gatewayStub();

  await runInDurableObject(stub, async (instance, state) => {
    const actor = instance as unknown as {
      ensureConnected(): Promise<DiscordGatewayHealthState>;
      health(): DiscordGatewayHealthState;
      refreshConfigurationIdentity(): Promise<boolean>;
    };
    const initialEnv = Reflect.get(instance, "env") as Record<string, unknown>;
    Reflect.set(instance, "env", {
      ...initialEnv,
      DISCORD_APPLICATION_ID: "wrong-application",
      DISCORD_BOT_TOKEN: "wrong-token",
    });

    expect(await actor.refreshConfigurationIdentity()).toBe(false);
    const fatalHealth = {
      ...actor.health(),
      state: "fatal",
      fatalReason: options.fatalReason,
    } satisfies DiscordGatewayHealthState;
    Reflect.set(instance, "healthState", fatalHealth);
    state.storage.kv.put("gateway_health", fatalHealth);
    state.storage.kv.put("gateway_session", {
      sessionId: "stale-session",
      resumeGatewayUrl: "wss://gateway.discord.test",
      sequence: 42,
      updatedAt: Date.now(),
    });
    state.storage.kv.put("unrelated_state", "preserved");

    expect(await actor.refreshConfigurationIdentity()).toBe(false);
    expect(actor.health()).toMatchObject({
      state: "fatal",
      fatalReason: options.fatalReason,
    });
    expect(state.storage.kv.get("gateway_session")).not.toBeNull();

    Reflect.set(instance, "env", {
      ...(Reflect.get(instance, "env") as Record<string, unknown>),
      ...options.correctedEnv,
    });
    const openGatewayConnection = vi.fn(async () => actor.health());
    Reflect.set(instance, "openGatewayConnection", openGatewayConnection);
    await expect(actor.ensureConnected()).resolves.toMatchObject({
      state: "idle",
      fatalReason: null,
    });
    expect(openGatewayConnection).toHaveBeenCalledOnce();
    expect(state.storage.kv.get("gateway_session")).toBeUndefined();
    expect(state.storage.kv.get("unrelated_state")).toBe("preserved");

    const fingerprint = state.storage.kv.get<string>(
      "gateway_configuration_fingerprint",
    );
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("correct");
  });
}

describe("DiscordGatewayDO configuration recovery", () => {
  it("recovers a persisted wrong-token fatal state after the token changes", async () => {
    await verifyConfigurationRecovery({
      fatalReason: "gateway_close_4004",
      correctedEnv: { DISCORD_BOT_TOKEN: "correct-token" },
    });
  });

  it("recovers an application-identity mismatch after the application ID changes", async () => {
    await verifyConfigurationRecovery({
      fatalReason: "application_identity_mismatch",
      correctedEnv: { DISCORD_APPLICATION_ID: "correct-application" },
    });
  });
});
