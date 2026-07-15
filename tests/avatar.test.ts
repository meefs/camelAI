import { describe, expect, it } from "vitest";

import {
  AVATAR_COLORS,
  DEFAULT_CHAT_GROUP_EMOJI,
  generateDefaultAvatar,
  generateDefaultChatGroupAvatar,
  isEmoji,
  normalizeAvatarColor,
  normalizeChatGroupAvatar,
  validateAvatarContent,
} from "@/lib/avatar";
import {
  DEFAULT_CHAT_GROUP_ICON,
  isChatGroupIconName,
} from "@/lib/chat-group-icons";

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

  it("normalizes chat group avatars to a Lucide icon name", () => {
    expect(normalizeAvatarColor("#e0476b")).toBe("#E0476B");
    expect(normalizeAvatarColor("#fff")).toBeNull();
    expect(normalizeAvatarColor("red")).toBeNull();
    // Kebab-case icon name is accepted; color is normalized and carried through.
    expect(
      normalizeChatGroupAvatar({ color: "#e0476b", content: "bar-chart-3" }),
    ).toEqual({ color: "#E0476B", content: "bar-chart-3" });
    // Camel/Pascal input is coerced to lucide's canonical kebab id.
    expect(normalizeChatGroupAvatar({ content: "Rocket" })).toEqual({
      color: AVATAR_COLORS[0],
      content: "rocket",
    });
    // Emojis, initials, and non-icons are rejected.
    expect(normalizeChatGroupAvatar({ color: AVATAR_COLORS[0], content: "🌊" })).toBeNull();
    expect(
      normalizeChatGroupAvatar({ color: AVATAR_COLORS[0], content: "not-a-real-icon" }),
    ).toBeNull();
    // Unknown keys are still rejected.
    expect(
      normalizeChatGroupAvatar({
        color: AVATAR_COLORS[0],
        content: "rocket",
        source: "user",
      }),
    ).toBeNull();
  });

  it("validates icon names without accepting inherited object properties", () => {
    expect(isChatGroupIconName("rocket")).toBe(true);
    expect(isChatGroupIconName("toString")).toBe(false);
    expect(isChatGroupIconName("__proto__")).toBe(false);
  });

  it("defaults new chat group avatars to the fallback icon", () => {
    expect(generateDefaultChatGroupAvatar().content).toBe(DEFAULT_CHAT_GROUP_ICON);
    expect(generateDefaultChatGroupAvatar({ content: "Bug" }).content).toBe("bug");
    expect(generateDefaultChatGroupAvatar({ content: "🌊" }).content).toBe(
      DEFAULT_CHAT_GROUP_ICON,
    );
    // Legacy constant retained for the historical DB column default.
    expect(DEFAULT_CHAT_GROUP_EMOJI).toBe("💬");
  });
});
