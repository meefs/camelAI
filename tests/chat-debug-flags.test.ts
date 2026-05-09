import { describe, expect, it } from "vitest";
import { parseChatDebugFlags } from "@/lib/chat-debug-flags";

describe("parseChatDebugFlags", () => {
  it("parses JSON flags with aliases", () => {
    const flags = parseChatDebugFlags(
      JSON.stringify({
        statusRevalidate: 0,
        markViewed: "off",
      }),
    );

    expect(flags.statusRevalidate).toBe(false);
    expect(flags.markViewed).toBe(false);
    expect(flags.statusSocket).toBe(true);
  });

  it("parses compact comma-separated flags", () => {
    const flags = parseChatDebugFlags(
      "status=0,revalidate=0,viewed=0",
    );

    expect(flags).toEqual({
      statusSocket: false,
      statusRevalidate: false,
      markViewed: false,
    });
  });
});
