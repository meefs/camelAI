import { describe, expect, it, vi } from "vitest";

import { AUXILIARY_AI_MODEL } from "@/lib/auxiliary-ai.server";
import {
  CHAT_GROUP_ICON_GENERATION_SYSTEM_PROMPT,
  CHAT_GROUP_ICON_MAX_OUTPUT_TOKENS,
  generateChatGroupIconWithOpenAI,
} from "@/lib/chat-group-avatar-generation.server";
import { isChatGroupIconName } from "@/lib/chat-group-icons";

function chatCompletion(content: string | null) {
  return { choices: [{ message: { content } }] };
}

describe("chat group avatar generation", () => {
  it("uses only the short title as user content with deterministic settings", async () => {
    const ai = {
      run: vi.fn(async () => chatCompletion("rocket, cloud upload, server")),
    };

    const icon = await generateChatGroupIconWithOpenAI(
      ai,
      "  Deploy API to Staging  ",
      {
        orgId: "org_1",
        workspaceId: "workspace_1",
        threadId: "thread_1",
        groupId: "group_1",
      },
      { gatewayName: "gateway_1" },
    );

    expect(icon).toBe("rocket");
    expect(ai.run).toHaveBeenCalledWith(
      AUXILIARY_AI_MODEL,
      {
        messages: [
          { role: "system", content: CHAT_GROUP_ICON_GENERATION_SYSTEM_PROMPT },
          { role: "user", content: '"Deploy API to Staging"' },
        ],
        max_tokens: CHAT_GROUP_ICON_MAX_OUTPUT_TOKENS,
        temperature: 0,
      },
      expect.any(Object),
    );
    expect(CHAT_GROUP_ICON_MAX_OUTPUT_TOKENS).toBe(48);
  });

  it("resolves ordinary pictograms through Lucide metadata", async () => {
    const ai = {
      run: vi.fn(async () => chatCompletion("waving hand, hand, smile")),
    };

    const icon = await generateChatGroupIconWithOpenAI(ai, "Hello");

    expect(icon).toBe("hand");
    expect(icon && isChatGroupIconName(icon)).toBe(true);
  });

  it("tries ordered alternatives when an earlier phrase is ambiguous", async () => {
    const ai = {
      run: vi.fn(async () => chatCompletion("envelope, email, mail")),
    };

    await expect(
      generateChatGroupIconWithOpenAI(ai, "Write Customer Support Email"),
    ).resolves.toBe("mail");
  });

  it("returns null for empty, malformed, and unmatched model responses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const response of [null, "", "💬", "xyzzy plugh frobnicate"]) {
      const ai = { run: vi.fn(async () => chatCompletion(response)) };
      await expect(
        generateChatGroupIconWithOpenAI(ai, "Unclear Request"),
      ).resolves.toBeNull();
    }
  });

  it("reports selector outcomes without exposing model text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcomes: string[] = [];
    const ai = { run: vi.fn(async () => chatCompletion("💬")) };

    await generateChatGroupIconWithOpenAI(ai, "Hello", undefined, {
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(outcomes).toEqual(["unparseable_output"]);
  });

  it("keeps AI failures observable to the lifecycle caller", async () => {
    const outcomes: string[] = [];
    const ai = {
      run: vi.fn(async () => {
        throw new Error("AI unavailable");
      }),
    };

    await expect(
      generateChatGroupIconWithOpenAI(ai, "Hello", undefined, {
        onOutcome: (outcome) => outcomes.push(outcome),
      }),
    ).rejects.toThrow("AI unavailable");
    expect(outcomes).toEqual(["ai_error"]);
  });
});
