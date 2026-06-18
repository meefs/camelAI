import { describe, expect, it, vi } from "vitest";

import {
  AUXILIARY_AI_MODEL,
  runAuxiliaryAiChatCompletion,
} from "../../../src/lib/auxiliary-ai.server";
import {
  generateThreadTitleWithOpenAI,
  THREAD_TITLE_GENERATION_MODEL,
} from "../../../src/lib/thread-title-generation.server";
import { THREAD_TITLE_GENERATION_SYSTEM_PROMPT } from "../../../src/lib/thread-title";

function chatCompletion(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("thread title generation", () => {
  it("uses Workers AI with Llama 3.2 1B", async () => {
    const run = vi.fn().mockResolvedValue(chatCompletion("  Fix login form  "));
    const ai = { run };

    const title = await generateThreadTitleWithOpenAI(
      ai,
      "The login form throws when the submit button is clicked.",
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        threadId: "thread_1",
      },
      { gatewayName: "gw_1" },
    );

    expect(title).toBe("Fix login form");
    expect(run).toHaveBeenCalledWith(
      AUXILIARY_AI_MODEL,
      {
        messages: [
          { role: "system", content: THREAD_TITLE_GENERATION_SYSTEM_PROMPT },
          {
            role: "user",
            content: "The login form throws when the submit button is clicked.",
          },
        ],
        max_tokens: 50,
      },
      {
        gateway: {
          id: "gw_1",
          metadata: {
            uid: "org_1:ws_1:thread_1",
            chiridion: JSON.stringify({
              orgId: "org_1",
              workspaceId: "ws_1",
              threadId: "thread_1",
            }),
          },
        },
        tags: ["org:org_1", "workspace:ws_1", "thread:thread_1"],
      },
    );
    expect(THREAD_TITLE_GENERATION_MODEL).toBe(AUXILIARY_AI_MODEL);
  });

  it("throws when Workers AI is not configured", async () => {
    await expect(
      generateThreadTitleWithOpenAI(undefined, "Hello"),
    ).rejects.toThrow("Workers AI binding is not configured");
  });
});

describe("auxiliary ai chat completion", () => {
  it("runs without gateway metadata when context is omitted", async () => {
    const run = vi.fn().mockResolvedValue(chatCompletion("Done"));
    const ai = { run };

    const text = await runAuxiliaryAiChatCompletion(ai, {
      systemPrompt: "System",
      userMessage: "User",
      maxTokens: 25,
    });

    expect(text).toBe("Done");
    expect(run).toHaveBeenCalledWith(
      AUXILIARY_AI_MODEL,
      {
        messages: [
          { role: "system", content: "System" },
          { role: "user", content: "User" },
        ],
        max_tokens: 25,
      },
      undefined,
    );
  });
});
