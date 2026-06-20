import { describe, expect, it } from "vitest";

import {
  AVATAR_COLORS,
  DEFAULT_CHAT_GROUP_EMOJI,
  generateDefaultAvatar,
  isEmoji,
  normalizeAvatarColor,
  normalizeChatGroupAvatar,
  validateAvatarContent,
} from "@/lib/avatar";

describe("avatar helpers", () => {
  it("accepts full emoji sequences and two-letter initials", () => {
    expect(isEmoji("😀")).toBe(true);
    expect(isEmoji("🇺🇸")).toBe(true);
    expect(isEmoji("👨‍👩‍👧")).toBe(true);
    expect(isEmoji("👍🏽")).toBe(true);
    expect(isEmoji("🏳️‍🌈")).toBe(true);

    expect(validateAvatarContent("😀")).toBe(true);
    expect(validateAvatarContent("🇺🇸")).toBe(true);
    expect(validateAvatarContent("👨‍👩‍👧")).toBe(true);
    expect(validateAvatarContent("👍🏽")).toBe(true);
    expect(validateAvatarContent("🏳️‍🌈")).toBe(true);
    expect(validateAvatarContent("JS")).toBe(true);
  });

  it("rejects invalid multi-character avatar content", () => {
    expect(isEmoji("AA")).toBe(false);
    expect(isEmoji("😀😀")).toBe(false);
    expect(validateAvatarContent("ABC")).toBe(false);
    expect(validateAvatarContent("A😀")).toBe(false);
    expect(validateAvatarContent("")).toBe(false);
  });

  it("generates consistent defaults", () => {
    const avatar = generateDefaultAvatar("Jane Doe");
    expect(avatar.content.length).toBe(2);
    expect(avatar.content).toBe("JA");
    expect(avatar.color).toMatch(/^#/);
  });

  it("generates consistent color for same input", () => {
    const first = generateDefaultAvatar("Jane Doe");
    const second = generateDefaultAvatar("Jane Doe");
    expect(second.color).toBe(first.color);
    expect(second.content).toBe(first.content);
  });

  it("handles empty string input", () => {
    const avatar = generateDefaultAvatar("");
    expect(avatar.content).toBe("US");
    expect(avatar.color).toMatch(/^#/);
  });

  it("handles Unicode names correctly", () => {
    const avatar = generateDefaultAvatar("Åke");
    expect(avatar.content.length).toBe(2);
    expect(avatar.color).toMatch(/^#/);
  });

  it("normalizes chat group avatar colors and requires emoji content", () => {
    expect(normalizeAvatarColor("#e0476b")).toBe("#E0476B");
    expect(normalizeAvatarColor("#fff")).toBeNull();
    expect(normalizeAvatarColor("red")).toBeNull();
    expect(normalizeChatGroupAvatar({ color: "#e0476b", content: "🌊" })).toEqual({
      color: "#E0476B",
      content: "🌊",
    });
    expect(normalizeChatGroupAvatar({ color: AVATAR_COLORS[0], content: "JS" })).toBeNull();
    expect(
      normalizeChatGroupAvatar({
        color: AVATAR_COLORS[0],
        content: "🌊",
        source: "user",
      }),
    ).toBeNull();
    expect(DEFAULT_CHAT_GROUP_EMOJI).toBe("💬");
  });
});
