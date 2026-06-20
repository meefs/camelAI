import { describe, expect, it } from "vitest";

import { sanitizeGeneratedChatGroupEmoji } from "@/lib/chat-group-avatar-generation.server";

describe("chat group avatar generation", () => {
  it("accepts a single generated emoji and strips surrounding punctuation", () => {
    expect(sanitizeGeneratedChatGroupEmoji("🌊")).toBe("🌊");
    expect(sanitizeGeneratedChatGroupEmoji('"🧠"')).toBe("🧠");
    expect(sanitizeGeneratedChatGroupEmoji("`🚀`")).toBe("🚀");
  });

  it("rejects words, empty values, and multiple emoji", () => {
    expect(sanitizeGeneratedChatGroupEmoji(null)).toBeNull();
    expect(sanitizeGeneratedChatGroupEmoji("")).toBeNull();
    expect(sanitizeGeneratedChatGroupEmoji("Use 🌊")).toBeNull();
    expect(sanitizeGeneratedChatGroupEmoji("🌊🚀")).toBeNull();
  });
});
