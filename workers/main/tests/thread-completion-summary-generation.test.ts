import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractThreadCompletionSummarySource,
  generateThreadCompletionSummaryWithOpenAI,
  THREAD_COMPLETION_SUMMARY_GENERATION_MODEL,
  THREAD_COMPLETION_SUMMARY_REASONING_EFFORT,
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

  it("uses a final tool result when it is the only tail conclusion artifact", () => {
    const source = extractThreadCompletionSummarySource(
      [
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "apply_patch", input: { path: "file.ts" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              content: [{ type: "text", text: "Patch applied and tests passed." }],
            },
          ],
        },
      ],
      null,
    );

    expect(source).toBe("Patch applied and tests passed.");
  });

  it("uses the OpenAI Responses API through Cloudflare AI Gateway", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [
            {
              id: "msg_1",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "  Generated concise summary.  ",
                  annotations: [],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const summary = await generateThreadCompletionSummaryWithOpenAI(
      {
        CF_ACCOUNT_ID: "acct_1",
        CF_GATEWAY_NAME: "gw_1",
        CF_GATEWAY_TOKEN: "tok_1",
      },
      "Final answer: This is a much longer raw assistant response with details.",
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        threadId: "thread_1",
      },
    );

    expect(summary).toBe("Generated concise summary.");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/openai/responses",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok_1");
    expect(headers.get("cf-aig-metadata")).toContain(
      '"uid":"org_1:ws_1:thread_1"',
    );

    const body = JSON.parse(String(init.body)) as {
      model?: string;
      instructions?: string;
      input?: string;
      reasoning?: { effort?: string };
      max_output_tokens?: number;
      store?: boolean;
    };
    expect(body).toMatchObject({
      model: THREAD_COMPLETION_SUMMARY_GENERATION_MODEL,
      instructions: THREAD_COMPLETION_SUMMARY_SYSTEM_PROMPT,
      input: "Final answer: This is a much longer raw assistant response with details.",
      reasoning: { effort: THREAD_COMPLETION_SUMMARY_REASONING_EFFORT },
      max_output_tokens: 80,
      store: false,
    });
  });
});
