import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatThreadDO } from "../src/chat-thread-do";

describe("ChatThreadDO completion summaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createFakeThread() {
    const waitUntilPromises: Promise<unknown>[] = [];
    const recordThreadAssistantCompletion = vi.fn(
      async (_threadId: string, input: { completedAt: number }) => input.completedAt,
    );
    const recordThreadStreaming = vi.fn(async () => undefined);
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.chatContext = {
      orgId: "org1",
      workspaceId: "workspace1",
      threadId: "thread1",
      userId: "user1",
    };
    fake.chatIsStreaming = true;
    fake.assistantCompletionRecordedAt = null;
    fake.assistantCompletionSummaryRequestedAt = null;
    fake.currentTodos = [];
    fake.trace = vi.fn();
    fake.broadcastRealtime = vi.fn();
    fake.ctx = {
      storage: { kv: { delete: vi.fn() } },
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      }),
      getWebSockets: vi.fn(() => [] as WebSocket[]),
    };
    fake.env = {
      CF_ACCOUNT_ID: "acct_1",
      CF_GATEWAY_NAME: "gw_1",
      CF_GATEWAY_TOKEN: "tok_1",
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          recordThreadAssistantCompletion,
        })),
      },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          recordThreadStreaming,
        })),
      },
    };

    return {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    };
  }

  it("stores generated completion summaries instead of raw final text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
                  text: "Generated hover summary.",
                  annotations: [],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();
    const rawFinalText =
      "Final answer: I changed several files, ran commands, and here are verbose details.";

    ChatThreadDO.prototype["setChatIsStreaming"].call(fake, false, {
      markUnread: true,
      summarySource: rawFinalText,
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenCalledTimes(2);
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(1, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "pending",
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(2, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "ready",
      summary: "Generated hover summary.",
    });
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      1,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: null,
        summaryStatus: "pending",
      },
    );
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      2,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: "Generated hover summary.",
        summaryStatus: "ready",
      },
    );
    expect(recordThreadAssistantCompletion).not.toHaveBeenCalledWith(
      "thread1",
      expect.objectContaining({ summary: rawFinalText }),
    );
  });

  it("marks summary generation failures as failed after completion is persisted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();

    ChatThreadDO.prototype["setChatIsStreaming"].call(fake, false, {
      markUnread: true,
      summarySource: "Raw final answer that should not be stored on failure.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenCalledTimes(2);
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(1, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "pending",
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(2, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "failed",
    });
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      1,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: null,
        summaryStatus: "pending",
      },
    );
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      2,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: null,
        summaryStatus: "failed",
      },
    );
  });

  it("uses the stored completion timestamp for generated summaries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
                  text: "Stored timestamp summary.",
                  annotations: [],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();
    const storedCompletedAt = 123456;
    recordThreadAssistantCompletion.mockImplementation(
      async (
        _threadId: string,
        input: { completedAt: number; summaryStatus?: string | null },
      ) =>
        input.summaryStatus === "pending" ? storedCompletedAt : input.completedAt,
    );

    ChatThreadDO.prototype["setChatIsStreaming"].call(fake, false, {
      markUnread: true,
      completedAt: 100,
      summarySource: "Raw final answer.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(2, "thread1", {
      completedAt: storedCompletedAt,
      summary: "Stored timestamp summary.",
      summaryStatus: "ready",
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(1, "thread1", false, {
      completedAt: storedCompletedAt,
      summaryStatus: "pending",
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(2, "thread1", false, {
      completedAt: storedCompletedAt,
      summaryStatus: "ready",
      summary: "Stored timestamp summary.",
    });
  });

  it("does not clear workspace running state when OrgDO rejects a stale completion", async () => {
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();
    recordThreadAssistantCompletion.mockResolvedValue(false);

    ChatThreadDO.prototype["setChatIsStreaming"].call(fake, false, {
      markUnread: true,
      completedAt: 100,
      summarySource: "Stale final answer.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadAssistantCompletion).toHaveBeenCalledWith("thread1", {
      completedAt: 100,
      summary: null,
      summaryStatus: "pending",
    });
    expect(recordThreadStreaming).not.toHaveBeenCalled();
  });

  it("clears workspace running state when completion persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();
    recordThreadAssistantCompletion.mockRejectedValue(new Error("transient"));

    ChatThreadDO.prototype["setChatIsStreaming"].call(fake, false, {
      markUnread: true,
      completedAt: 100,
      summarySource: "Completed final answer.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadAssistantCompletion).toHaveBeenCalledWith("thread1", {
      completedAt: 100,
      summary: null,
      summaryStatus: "pending",
    });
    expect(recordThreadStreaming).toHaveBeenCalledWith("thread1", false, {
      completedAt: 100,
      summaryStatus: "failed",
    });
  });

  it("marks empty generated summaries as failed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
                  text: "   ",
                  annotations: [],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();

    ChatThreadDO.prototype["setChatIsStreaming"].call(fake, false, {
      markUnread: true,
      summarySource: "Raw final answer.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenNthCalledWith(2, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "failed",
    });
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      2,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: null,
        summaryStatus: "failed",
      },
    );
  });

  it("marks completion summary as failed when no source text is available", async () => {
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();

    ChatThreadDO.prototype["setChatIsStreaming"].call(fake, false, {
      markUnread: true,
      summarySource: null,
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenCalledWith("thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "failed",
    });
    expect(recordThreadAssistantCompletion).toHaveBeenCalledWith("thread1", {
      completedAt: expect.any(Number),
      summary: null,
      summaryStatus: "failed",
    });
  });
});
