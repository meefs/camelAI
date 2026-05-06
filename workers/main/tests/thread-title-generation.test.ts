import { describe, expect, it, afterEach, vi } from "vitest";

import {
  generateThreadTitleWithOpenAI,
  resolveThreadTitleGatewayConfig,
  THREAD_TITLE_GENERATION_MODEL,
  THREAD_TITLE_GENERATION_REASONING_EFFORT,
} from "../../../src/lib/thread-title-generation.server";
import { THREAD_TITLE_GENERATION_SYSTEM_PROMPT } from "../../../src/lib/thread-title";

describe("thread title generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the Cloudflare AI Gateway OpenAI base URL", () => {
    expect(
      resolveThreadTitleGatewayConfig({
        CF_ACCOUNT_ID: "acct_1",
        CF_GATEWAY_NAME: "gw_1",
        CF_GATEWAY_TOKEN: "tok_1",
      }),
    ).toEqual({
      baseURL: "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/openai",
      authToken: "tok_1",
    });
  });

  it("returns null when gateway config is incomplete", () => {
    expect(
      resolveThreadTitleGatewayConfig({
        CF_ACCOUNT_ID: "acct_1",
        CF_GATEWAY_NAME: "gw_1",
      }),
    ).toBeNull();
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
                  text: "  Fix login form  ",
                  annotations: [],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const title = await generateThreadTitleWithOpenAI(
      {
        CF_ACCOUNT_ID: "acct_1",
        CF_GATEWAY_NAME: "gw_1",
        CF_GATEWAY_TOKEN: "tok_1",
      },
      "The login form throws when the submit button is clicked.",
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        threadId: "thread_1",
      },
    );

    expect(title).toBe("Fix login form");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/openai/responses",
    );
    expect(init.method).toBe("POST");

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
      model: THREAD_TITLE_GENERATION_MODEL,
      instructions: THREAD_TITLE_GENERATION_SYSTEM_PROMPT,
      input: "The login form throws when the submit button is clicked.",
      reasoning: { effort: THREAD_TITLE_GENERATION_REASONING_EFFORT },
      max_output_tokens: 50,
      store: false,
    });
  });
});
