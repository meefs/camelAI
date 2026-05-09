import { describe, expect, it } from "vitest";
import { parseChatDebugFlags } from "@/lib/chat-debug-flags";

describe("parseChatDebugFlags", () => {
  it("parses JSON flags with aliases", () => {
    const flags = parseChatDebugFlags(
      JSON.stringify({
        cache: false,
        snapshot: false,
        statusRevalidate: 0,
        markViewed: "off",
      }),
    );

    expect(flags.messageCache).toBe(false);
    expect(flags.snapshots).toBe(false);
    expect(flags.statusRevalidate).toBe(false);
    expect(flags.markViewed).toBe(false);
    expect(flags.prefetch).toBe(true);
    expect(flags.statusSocket).toBe(true);
  });

  it("parses compact comma-separated flags", () => {
    const flags = parseChatDebugFlags(
      "cache=0,snapshots=0,prefetch=0,status=0,revalidate=0,viewed=0",
    );

    expect(flags).toEqual({
      messageCache: false,
      snapshots: false,
      prefetch: false,
      statusSocket: false,
      statusRevalidate: false,
      markViewed: false,
    });
  });
});
