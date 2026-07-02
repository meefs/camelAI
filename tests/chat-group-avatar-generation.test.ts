import { describe, expect, it, vi } from "vitest";

import { AUXILIARY_AI_MODEL } from "@/lib/auxiliary-ai.server";
import {
  CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS,
  generateChatGroupEmojiWithOpenAI,
  sanitizeGeneratedChatGroupEmoji,
} from "@/lib/chat-group-avatar-generation.server";

describe("chat group avatar generation", () => {
  it("takes the first emoji out of whatever the model returns", () => {
    expect(sanitizeGeneratedChatGroupEmoji("🌊")).toBe("🌊");
    expect(sanitizeGeneratedChatGroupEmoji('"🧠"')).toBe("🧠");
    expect(sanitizeGeneratedChatGroupEmoji("`🚀`")).toBe("🚀");
    expect(sanitizeGeneratedChatGroupEmoji("Use 🌊")).toBe("🌊");
    expect(sanitizeGeneratedChatGroupEmoji("Emoji: 🧠")).toBe("🧠");
    expect(sanitizeGeneratedChatGroupEmoji('{ "emoji": "🛠️" }')).toBe("🛠️");
    expect(sanitizeGeneratedChatGroupEmoji("The best emoji is 🧠.")).toBe("🧠");
  });

  it("uses the first emoji even when the model returns several", () => {
    expect(sanitizeGeneratedChatGroupEmoji("🌊🚀")).toBe("🌊");
    expect(sanitizeGeneratedChatGroupEmoji("🌊 and 🚀")).toBe("🌊");
  });

  it("returns null when there is no emoji", () => {
    expect(sanitizeGeneratedChatGroupEmoji(null)).toBeNull();
    expect(sanitizeGeneratedChatGroupEmoji("")).toBeNull();
    expect(sanitizeGeneratedChatGroupEmoji("Use the ocean")).toBeNull();
  });

  it("uses enough output tokens for short prefixed responses", () => {
    expect(CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(24);
  });

  it("passes the emoji model and token budget when calling auxiliary AI", async () => {
    const ai = {
      run: vi.fn(async () => ({
        choices: [{ message: { content: "Emoji: 🧠" } }],
      })),
    };

    await expect(
      generateChatGroupEmojiWithOpenAI(ai, "Architecture planning"),
    ).resolves.toBe("🧠");

    expect(ai.run).toHaveBeenCalledWith(
      AUXILIARY_AI_MODEL,
      expect.objectContaining({
        max_tokens: CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS,
      }),
      undefined,
    );
  });
});
