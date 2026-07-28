import {
  envFlag,
  type DiscordBridgeEnv,
  type DiscordGatewayHealthState,
} from "./types.js";

const MINIMUM_HEARTBEAT_FRESHNESS_MS = 120_000;

export interface DiscordBridgeReadiness {
  ready: boolean;
  status: "ready" | "degraded" | "unavailable";
  reason:
    | "ready"
    | "ingress_disabled"
    | "outbound_disabled"
    | "gateway_disconnected"
    | "heartbeat_unacknowledged"
    | "heartbeat_stale";
  message: string;
}

export function evaluateDiscordBridgeReadiness(
  env: Pick<DiscordBridgeEnv, "DISCORD_INGRESS_ENABLED" | "DISCORD_OUTBOUND_ENABLED">,
  gateway: DiscordGatewayHealthState,
  now = Date.now(),
): DiscordBridgeReadiness {
  if (!envFlag(env.DISCORD_OUTBOUND_ENABLED, true)) {
    return {
      ready: false,
      status: "unavailable",
      reason: "outbound_disabled",
      message: "Discord outbound delivery is disabled",
    };
  }
  if (!envFlag(env.DISCORD_INGRESS_ENABLED, false)) {
    return {
      ready: false,
      status: "unavailable",
      reason: "ingress_disabled",
      message: "Discord inbound delivery is disabled",
    };
  }
  if (gateway.state !== "ready" && gateway.state !== "resumed") {
    return {
      ready: false,
      status: "unavailable",
      reason: "gateway_disconnected",
      message: "Discord Gateway is not connected",
    };
  }
  if (!gateway.lastHeartbeatAckAt) {
    return {
      ready: false,
      status: "degraded",
      reason: "heartbeat_unacknowledged",
      message: "Discord Gateway has not acknowledged a heartbeat yet",
    };
  }
  const freshnessWindow = Math.max(
    MINIMUM_HEARTBEAT_FRESHNESS_MS,
    (gateway.heartbeatIntervalMs ?? 0) * 2,
  );
  if (now - gateway.lastHeartbeatAckAt > freshnessWindow) {
    return {
      ready: false,
      status: "degraded",
      reason: "heartbeat_stale",
      message: "Discord Gateway heartbeat acknowledgement is stale",
    };
  }
  return {
    ready: true,
    status: "ready",
    reason: "ready",
    message: "Discord bridge is ready",
  };
}

export { MINIMUM_HEARTBEAT_FRESHNESS_MS };
