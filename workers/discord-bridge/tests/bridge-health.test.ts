import { describe, expect, it } from "vitest";
import { evaluateDiscordBridgeReadiness } from "../src/bridge-health";
import type { DiscordGatewayHealthState } from "../src/types";

function gateway(
  overrides: Partial<DiscordGatewayHealthState> = {},
): DiscordGatewayHealthState {
  return {
    state: "ready",
    shardId: 0,
    shardCount: 1,
    readyAt: 900_000,
    resumedAt: null,
    heartbeatIntervalMs: 45_000,
    lastHeartbeatAt: 990_000,
    lastHeartbeatAckAt: 995_000,
    lastSequence: 10,
    reconnectCount: 0,
    lastCloseCode: null,
    sessionStartsRemaining: 999,
    sessionStartsResetAt: 2_000_000,
    maxConcurrency: 1,
    recommendedShardCount: 1,
    contentMode: "full",
    fatalReason: null,
    ...overrides,
  };
}

const enabled = {
  DISCORD_INGRESS_ENABLED: "true",
  DISCORD_OUTBOUND_ENABLED: "true",
};

describe("Discord bridge readiness", () => {
  it("rejects disabled ingress and outbound", () => {
    expect(evaluateDiscordBridgeReadiness(
      { ...enabled, DISCORD_INGRESS_ENABLED: "false" },
      gateway(),
      1_000_000,
    )).toMatchObject({ ready: false, status: "unavailable", reason: "ingress_disabled" });
    expect(evaluateDiscordBridgeReadiness(
      { ...enabled, DISCORD_OUTBOUND_ENABLED: "false" },
      gateway(),
      1_000_000,
    )).toMatchObject({ ready: false, status: "unavailable", reason: "outbound_disabled" });
    expect(evaluateDiscordBridgeReadiness(
      { DISCORD_INGRESS_ENABLED: "false", DISCORD_OUTBOUND_ENABLED: "false" },
      gateway(),
      1_000_000,
    )).toMatchObject({ ready: false, status: "unavailable", reason: "outbound_disabled" });
  });

  it("rejects disconnected, unacknowledged, and stale Gateway health", () => {
    expect(evaluateDiscordBridgeReadiness(
      enabled,
      gateway({ state: "reconnecting" }),
      1_000_000,
    ).reason).toBe("gateway_disconnected");
    expect(evaluateDiscordBridgeReadiness(
      enabled,
      gateway({ lastHeartbeatAckAt: null }),
      1_000_000,
    ).reason).toBe("heartbeat_unacknowledged");
    expect(evaluateDiscordBridgeReadiness(
      enabled,
      gateway({ lastHeartbeatAckAt: 800_000 }),
      1_000_000,
    ).reason).toBe("heartbeat_stale");
  });

  it("accepts a Ready or Resumed Gateway with a fresh acknowledgement", () => {
    expect(evaluateDiscordBridgeReadiness(enabled, gateway(), 1_000_000))
      .toMatchObject({ ready: true, status: "ready", reason: "ready" });
    expect(evaluateDiscordBridgeReadiness(
      enabled,
      gateway({ state: "resumed", readyAt: null, resumedAt: 999_000 }),
      1_000_000,
    ).ready).toBe(true);
  });
});
