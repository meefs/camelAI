import { describe, expect, it, vi } from "vitest";
import {
  discordApplicationIdConfigured,
  getDiscordChannelAvailability,
} from "../workers/main/src/discord-types";

const applicationId = "123456789012345678";

function discordEnv(readiness: { ready: boolean; reason: string }) {
  return {
    DISCORD_CHANNEL_ENABLED: "true",
    DISCORD_CLIENT_ID: applicationId,
    DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
    DISCORD_BRIDGE: {
      fetch: vi.fn(async () => Response.json({
        ok: true,
        applicationId,
        botUserId: applicationId,
        readiness,
        gateway: {
          state: "ready",
          heartbeatIntervalMs: 45_000,
          lastHeartbeatAckAt: Date.now(),
        },
      })),
    },
  };
}

describe("Discord integration availability", () => {
  it("rejects placeholder application IDs", () => {
    expect(discordApplicationIdConfigured("SET_IN_DISCORD_DEVELOPER_PORTAL")).toBe(false);
    expect(discordApplicationIdConfigured("000000000000000000")).toBe(false);
    expect(discordApplicationIdConfigured(applicationId)).toBe(true);
  });

  it("separates dark-launch catalog visibility from operational readiness", async () => {
    await expect(getDiscordChannelAvailability(discordEnv({
      ready: false,
      reason: "ingress_disabled",
    }) as never)).resolves.toMatchObject({
      catalogAvailable: true,
      operationalReady: false,
      reason: "ingress_disabled",
    });

    await expect(getDiscordChannelAvailability(discordEnv({
      ready: true,
      reason: "ready",
    }) as never)).resolves.toMatchObject({
      catalogAvailable: true,
      operationalReady: true,
      reason: "ready",
    });
  });
});
