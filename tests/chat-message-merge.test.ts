import { describe, expect, it } from "vitest";

import { mergeServerAndLocalMessages } from "@/lib/chat-message-merge";
import type { ContentBlock, Message } from "@/types";

function message(args: {
  id: string;
  role: Message["role"];
  createdAt: number;
  content: string | ContentBlock[];
  isStreaming?: boolean;
  isMeta?: boolean;
  forkEntryId?: string;
  sourceToolUseID?: string;
}): Message {
  return {
    id: args.id,
    thread_id: "thread-1",
    role: args.role,
    content: args.content,
    created_at: args.createdAt,
    isStreaming: args.isStreaming,
    isMeta: args.isMeta,
    forkEntryId: args.forkEntryId,
    sourceToolUseID: args.sourceToolUseID,
  };
}

describe("mergeServerAndLocalMessages", () => {
  it("keeps richer local tool blocks when a same-id server refresh is stale", () => {
    const serverMessages = [
      message({ id: "user", role: "user", createdAt: 1000, content: [{ type: "text", text: "Run pwd" }] }),
      message({
        id: "assistant",
        role: "assistant",
        createdAt: 2000,
        content: [{ type: "text", text: "I'll check." }],
      }),
    ];
    const localMessages = [
      serverMessages[0],
      message({
        id: "assistant",
        role: "assistant",
        createdAt: 2000,
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
          { type: "tool_result", tool_use_id: "tool-1", content: "/home/claude\n[exit code: 0]" },
          { type: "text", text: "The working directory is `/home/claude`." },
        ],
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged.map((entry) => entry.id)).toEqual(["user", "assistant"]);
    const assistant = merged[1];
    expect(Array.isArray(assistant.content)).toBe(true);
    expect((assistant.content as ContentBlock[]).map((block) => block.type)).toEqual([
      "tool_use",
      "tool_result",
      "text",
    ]);
  });

  it("keeps streaming same-id content when the server only has an empty placeholder", () => {
    const serverMessages = [
      message({ id: "user", role: "user", createdAt: 1000, content: [{ type: "text", text: "Edit the file" }] }),
      message({
        id: "assistant",
        role: "assistant",
        createdAt: 2000,
        content: [],
      }),
    ];
    const localMessages = [
      serverMessages[0],
      message({
        id: "assistant",
        role: "assistant",
        createdAt: 2000,
        isStreaming: true,
        content: [
          { type: "tool_use", id: "tool-1", name: "Edit", input: { file_path: "app.tsx" } },
        ],
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged).toHaveLength(2);
    expect(merged[1].isStreaming).toBe(true);
    expect((merged[1].content as ContentBlock[])[0]).toMatchObject({
      type: "tool_use",
      id: "tool-1",
    });
  });

  it("keeps richer local Kimi tool blocks when server history uses the grouped assistant id", () => {
    const serverMessages = [
      message({
        id: "server-user",
        role: "user",
        createdAt: 1000,
        content: [{ type: "text", text: "Inspect the app" }],
      }),
      message({
        id: "pi-entry-root",
        role: "assistant",
        createdAt: 3000,
        forkEntryId: "pi-entry-leaf",
        content: [{ type: "text", text: "I'll inspect it." }],
      }),
    ];
    const localMessages = [
      serverMessages[0],
      message({
        id: "pi-entry-leaf",
        role: "assistant",
        createdAt: 3000,
        content: [
          {
            type: "tool_use",
            id: "tool-kimi-1",
            name: "Bash",
            input: { command: "ls" },
          },
          {
            type: "tool_result",
            tool_use_id: "tool-kimi-1",
            content: "package.json\nsrc\n[exit code: 0]",
          },
          { type: "text", text: "The app has a package.json and src directory." },
        ],
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged.map((entry) => entry.id)).toEqual(["server-user", "pi-entry-root"]);
    expect(merged[1].forkEntryId).toBe("pi-entry-leaf");
    expect((merged[1].content as ContentBlock[]).map((block) => block.type)).toEqual([
      "tool_use",
      "tool_result",
      "text",
    ]);
  });

  it("deduplicates local rendered messages that match a server forkEntryId", () => {
    const serverMessages = [
      message({
        id: "server-user",
        role: "user",
        createdAt: 1000,
        content: [{ type: "text", text: "Run pwd" }],
      }),
      message({
        id: "pi-entry-root",
        role: "assistant",
        createdAt: 3000,
        forkEntryId: "pi-entry-leaf",
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
          { type: "tool_result", tool_use_id: "tool-1", content: "/home/claude" },
        ],
      }),
    ];
    const localMessages = [
      serverMessages[0],
      message({
        id: "pi-entry-leaf",
        role: "assistant",
        createdAt: 3000,
        forkEntryId: "pi-entry-leaf",
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
          { type: "tool_result", tool_use_id: "tool-1", content: "/home/claude" },
        ],
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged.map((entry) => entry.id)).toEqual(["server-user", "pi-entry-root"]);
  });

  it("preserves same-id meta source information when server history omits it", () => {
    const serverMessages = [
      message({
        id: "meta-tool-1",
        role: "user",
        createdAt: 2500,
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
      }),
    ];
    const localMessages = [
      message({
        id: "meta-tool-1",
        role: "user",
        createdAt: 2500,
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
        isMeta: true,
        sourceToolUseID: "tool-1",
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged[0].isMeta).toBe(true);
    expect(merged[0].sourceToolUseID).toBe("tool-1");
  });

  it("prefers same-id server tool details when they are at least as rich", () => {
    const serverMessages = [
      message({
        id: "assistant",
        role: "assistant",
        createdAt: 2000,
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "pwd", description: "Check workspace directory" },
          },
          { type: "text", text: "Done." },
        ],
      }),
    ];
    const localMessages = [
      message({
        id: "assistant",
        role: "assistant",
        createdAt: 2000,
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd", status: "completed" } },
          { type: "text", text: "Done." },
        ],
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);
    const tool = (merged[0].content as ContentBlock[]).find(
      (block) => block.type === "tool_use",
    );

    expect(tool?.type === "tool_use" ? tool.input.description : undefined).toBe(
      "Check workspace directory",
    );
  });

  it("does not treat nonempty server string content as an empty placeholder", () => {
    const serverMessages = [
      message({
        id: "assistant",
        role: "assistant",
        createdAt: 2000,
        content: "Final server text",
      }),
    ];
    const localMessages = [
      message({
        id: "assistant",
        role: "assistant",
        createdAt: 2000,
        content: [{ type: "text", text: "Partial" }],
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged[0].content).toBe("Final server text");
  });

  it("drops stale local Pi assistant rows when the server has the parsed turn under a different id", () => {
    const promptText = "Use the bash tool to run pwd.";
    const serverUserText = `[Local Dev (local-dev@camelai.local)]: ${promptText}`;
    const serverMessages = [
      message({ id: "server-user", role: "user", createdAt: 1000, content: [{ type: "text", text: serverUserText }] }),
      message({
        id: "server-tool-assistant",
        role: "assistant",
        createdAt: 2000,
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "pwd", description: "Check workspace directory" },
          },
          { type: "tool_result", tool_use_id: "tool-1", content: "/home/claude\n[exit code: 0]" },
          { type: "text", text: "The working directory is `/home/claude`." },
        ],
      }),
    ];
    const localMessages = [
      message({ id: "local-user", role: "user", createdAt: 1000, content: [{ type: "text", text: promptText }] }),
      message({
        id: "local-final-assistant",
        role: "assistant",
        createdAt: 3000,
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd", status: "completed" } },
          { type: "tool_result", tool_use_id: "tool-1", content: "/home/claude\n[exit code: 0]" },
          { type: "text", text: "The working directory is `/home/claude`." },
        ],
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged.map((entry) => entry.id)).toEqual(["server-user", "server-tool-assistant"]);
    const assistant = merged[1];
    expect(Array.isArray(assistant.content)).toBe(true);
    const tool = (assistant.content as ContentBlock[]).find((block) => block.type === "tool_use");
    expect(tool?.type === "tool_use" ? tool.input.description : undefined).toBe("Check workspace directory");
  });

  it("keeps genuinely unsynced local assistant rows when no matching server turn exists", () => {
    const serverMessages = [
      message({ id: "server-user", role: "user", createdAt: 1000, content: [{ type: "text", text: "previous" }] }),
    ];
    const localAssistant = message({
      id: "local-assistant",
      role: "assistant",
      createdAt: 3000,
      content: [{ type: "text", text: "still streaming" }],
    });
    const localMessages = [
      ...serverMessages,
      message({ id: "local-user", role: "user", createdAt: 2000, content: [{ type: "text", text: "new turn" }] }),
      localAssistant,
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged.map((entry) => entry.id)).toEqual(["server-user", "local-user", "local-assistant"]);
  });

  it("keeps repeated local prompts when only an earlier matching prompt is persisted", () => {
    const promptText = "Can you check the current status?";
    const serverMessages = [
      message({ id: "server-user", role: "user", createdAt: 1000, content: [{ type: "text", text: promptText }] }),
      message({ id: "server-assistant", role: "assistant", createdAt: 1500, content: [{ type: "text", text: "First answer" }] }),
    ];
    const localMessages = [
      ...serverMessages,
      message({ id: "local-user-repeat", role: "user", createdAt: 5000, content: [{ type: "text", text: promptText }] }),
      message({ id: "local-assistant-repeat", role: "assistant", createdAt: 5500, content: [{ type: "text", text: "Second answer is still streaming" }] }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged.map((entry) => entry.id)).toEqual([
      "server-user",
      "server-assistant",
      "local-user-repeat",
      "local-assistant-repeat",
    ]);
  });

  it("drops an optimistic local user when the persisted Pi user arrives later with a different id", () => {
    const promptText = "Start the task";
    const serverMessages = [
      message({
        id: "server-user",
        role: "user",
        createdAt: 3500,
        content: [{ type: "text", text: `[Miguel]: ${promptText}` }],
      }),
      message({
        id: "server-assistant",
        role: "assistant",
        createdAt: 6000,
        content: [{ type: "text", text: "Done" }],
      }),
    ];
    const localMessages = [
      message({
        id: "local-user",
        role: "user",
        createdAt: 1000,
        content: [{ type: "text", text: promptText }],
      }),
      message({
        id: "local-assistant",
        role: "assistant",
        createdAt: 6100,
        content: [{ type: "text", text: "Done" }],
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, localMessages);

    expect(merged.map((entry) => entry.id)).toEqual(["server-user", "server-assistant"]);
  });

  it("drops a stale local assistant after the local user was already replaced by the server user", () => {
    const promptText = "Please continue";
    const localAssistant = message({
      id: "stream-local-assistant",
      role: "assistant",
      createdAt: 2200,
      content: [{ type: "text", text: "Working on it" }],
    });

    const firstFetchServerMessages = [
      message({
        id: "server-user",
        role: "user",
        createdAt: 1500,
        content: [{ type: "text", text: `[Miguel]: ${promptText}` }],
      }),
    ];
    const firstFetchLocalMessages = [
      message({
        id: "local-user",
        role: "user",
        createdAt: 1000,
        content: [{ type: "text", text: promptText }],
      }),
      localAssistant,
    ];

    const afterFirstFetch = mergeServerAndLocalMessages(
      firstFetchServerMessages,
      firstFetchLocalMessages,
    );

    expect(afterFirstFetch.map((entry) => entry.id)).toEqual([
      "server-user",
      "stream-local-assistant",
    ]);

    const secondFetchServerMessages = [
      ...firstFetchServerMessages,
      message({
        id: "server-assistant",
        role: "assistant",
        createdAt: 3000,
        content: [{ type: "text", text: "Working on it" }],
      }),
    ];

    const afterSecondFetch = mergeServerAndLocalMessages(
      secondFetchServerMessages,
      afterFirstFetch,
    );

    expect(afterSecondFetch.map((entry) => entry.id)).toEqual([
      "server-user",
      "server-assistant",
    ]);
  });
});
