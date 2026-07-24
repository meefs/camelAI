import { describe, expect, it } from "vitest";
import {
  classifyDiscordGatewayClose,
  discordIdentifyPayload,
  discordReconnectDelayMs,
  normalizeDiscordThreadName,
  splitDiscordMessage,
  stableDiscordNonce,
} from "../src/gateway-protocol";

describe("Discord Gateway protocol helpers", () => {
  it("uses the documented intent bitsets", () => {
    expect(discordIdentifyPayload({ token: "secret", mode: "full", shardId: 0, shardCount: 1 }).d.intents).toBe(33_281);
    expect(discordIdentifyPayload({ token: "secret", mode: "mention_only", shardId: 0, shardCount: 1 }).d.intents).toBe(513);
  });

  it("classifies resumable, re-identify, and fatal closes", () => {
    expect(classifyDiscordGatewayClose(4000)).toBe("resume");
    expect(classifyDiscordGatewayClose(4007)).toBe("reidentify");
    expect(classifyDiscordGatewayClose(4004)).toBe("fatal");
    expect(classifyDiscordGatewayClose(4014)).toBe("fatal");
  });

  it("bounds reconnect jitter", () => {
    expect(discordReconnectDelayMs(0, () => 0)).toBe(0);
    expect(discordReconnectDelayMs(20, () => 1)).toBe(60_000);
  });

  it("normalizes Unicode thread names to 100 code points", () => {
    const name = normalizeDiscordThreadName(`<@123> ${"🦊".repeat(120)}`);
    expect(Array.from(name)).toHaveLength(100);
    expect(name).not.toContain("<@123>");
    expect(normalizeDiscordThreadName("  ")).toBe("Camel request");
  });

  it("splits long messages and balances fenced code blocks", () => {
    const source = `Intro\n\n\`\`\`ts\n${"const value = 1;\n".repeat(180)}\`\`\`\nDone`;
    const chunks = splitDiscordMessage(source);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every((chunk) => (chunk.match(/```/g) || []).length % 2 === 0)).toBe(true);
  });

  it("never splits a Unicode surrogate pair", () => {
    const chunks = splitDiscordMessage(`prefix ${"🦊".repeat(1_100)}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).not.toContain("�");
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("creates stable collision-resistant nonces under Discord's limit", async () => {
    const first = await stableDiscordNonce("operation", 0);
    expect(first).toBe(await stableDiscordNonce("operation", 0));
    expect(first).not.toBe(await stableDiscordNonce("operation", 1));
    expect(first.length).toBeLessThanOrEqual(25);
  });
});
