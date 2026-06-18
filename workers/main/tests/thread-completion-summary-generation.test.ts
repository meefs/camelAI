import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractThreadCompletionSummarySource,
  generateThreadCompletionSummaryWithOpenAI,
  THREAD_COMPLETION_SUMMARY_GENERATION_MODEL,
  THREAD_COMPLETION_SUMMARY_SYSTEM_PROMPT,
} from "../../../src/lib/thread-completion-summary-generation.server";

describe("thread completion summary generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts the final user-visible assistant conclusion from tail messages", () => {
    const source = extractThreadCompletionSummarySource(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "Earlier analysis that should not win." }],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "bash", input: { command: "bun test" } },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Final answer: Implemented the hover-card summary flow and tests.",
            },
          ],
        },
      ],
      "Fallback text",
    );

    expect(source).toBe(
      "Final answer: Implemented the hover-card summary flow and tests.",
    );
  });

  it("uses a final Pi toolResult when it is the only tail conclusion artifact", () => {
    const source = extractThreadCompletionSummarySource(
      [
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "apply_patch", input: { path: "file.ts" } },
          ],
        },
        {
          role: "toolResult",
          content: [
            {
              type: "text",
              text: "Patch applied and tests passed.",
            },
          ],
        },
      ],
      null,
    );

    expect(source).toBe("Patch applied and tests passed.");
  });

  it("skips tail assistant tool-call noise and selects the following Pi toolResult", () => {
    const source = extractThreadCompletionSummarySource(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "Earlier answer." }],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "task", input: { prompt: "summarize" } },
          ],
        },
        {
          role: "toolResult",
          content: [
            {
              type: "text",
              text: "Identified the account-level BYOK configuration issue.",
            },
          ],
        },
      ],
      "Fallback text",
    );

    expect(source).toBe("Identified the account-level BYOK configuration issue.");
  });

  it("uses Workers AI with GLM 4.7 Flash", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "  Generated concise summary.  " } }],
    });

    const summary = await generateThreadCompletionSummaryWithOpenAI(
      { run },
      "Final answer: This is a much longer raw assistant response with details.",
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        threadId: "thread_1",
      },
      { gatewayName: "gw_1" },
    );

    expect(summary).toBe("Generated concise summary.");
    expect(run).toHaveBeenCalledWith(
      THREAD_COMPLETION_SUMMARY_GENERATION_MODEL,
      {
        messages: [
          { role: "system", content: THREAD_COMPLETION_SUMMARY_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              "Final answer: This is a much longer raw assistant response with details.",
          },
        ],
        max_tokens: 80,
      },
      expect.objectContaining({
        gateway: expect.objectContaining({ id: "gw_1" }),
      }),
    );
  });
});
