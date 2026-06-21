import { describe, expect, it, vi } from "vitest";

import {
  CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS,
  generateChatGroupEmojiWithOpenAI,
  parseGeneratedChatGroupEmoji,
  sanitizeGeneratedChatGroupEmoji,
} from "@/lib/chat-group-avatar-generation.server";

describe("chat group avatar generation", () => {
  it("accepts a single generated emoji and strips surrounding punctuation", () => {
    expect(sanitizeGeneratedChatGroupEmoji("🌊")).toBe("🌊");
    expect(sanitizeGeneratedChatGroupEmoji('"🧠"')).toBe("🧠");
    expect(sanitizeGeneratedChatGroupEmoji("`🚀`")).toBe("🚀");
    expect(sanitizeGeneratedChatGroupEmoji("Use 🌊")).toBe("🌊");
    expect(sanitizeGeneratedChatGroupEmoji("Emoji: 🧠")).toBe("🧠");
    expect(sanitizeGeneratedChatGroupEmoji('{ "emoji": "🛠️" }')).toBe("🛠️");
  });

  it("rejects words, empty values, and multiple emoji", () => {
    expect(sanitizeGeneratedChatGroupEmoji(null)).toBeNull();
    expect(sanitizeGeneratedChatGroupEmoji("")).toBeNull();
    expect(sanitizeGeneratedChatGroupEmoji("Use the ocean")).toBeNull();
    expect(sanitizeGeneratedChatGroupEmoji("🌊🚀")).toBeNull();
    expect(parseGeneratedChatGroupEmoji("🌊 and 🚀")).toMatchObject({
      reason: "multiple_emoji",
      emojiMatchCount: 2,
    });
  });

  it("uses enough output tokens for short prefixed responses", () => {
    expect(CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(24);
    expect(sanitizeGeneratedChatGroupEmoji("The best emoji is 🧠.")).toBe("🧠");
  });

  it("uses the larger token budget when calling auxiliary AI", async () => {
    const ai = {
      run: vi.fn(async () => ({
        choices: [{ message: { content: "Emoji: 🧠" } }],
      })),
    };

    await expect(
      generateChatGroupEmojiWithOpenAI(ai, "Architecture planning"),
    ).resolves.toBe("🧠");

    expect(ai.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        max_tokens: CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS,
      }),
      undefined,
    );
  });
});
