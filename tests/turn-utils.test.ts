import { describe, expect, it } from "vitest";
import {
  buildFinalOutputMessageView,
  buildTraceMessageView,
  countTurnSteps,
  filterContentForRenderMode,
  formatTurnDuration,
  formatTurnDurationForScreenReader,
  hasFinalOutput,
} from "@/lib/turn-utils";
import type { ContentBlock, Message } from "@/types";

function assistantMessage(
  id: string,
  content: string | ContentBlock[],
  createdAt = 1,
): Message {
  return {
    id,
    thread_id: "thread-1",
    role: "assistant",
    content,
    created_at: createdAt,
  };
}

describe("turn utils", () => {
  describe("countTurnSteps", () => {
    it("returns 0 for empty turns", () => {
      expect(countTurnSteps([])).toBe(0);
    });

    it("counts tool calls", () => {
      expect(
        countTurnSteps([
          assistantMessage("a1", [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            { type: "tool_use", id: "tool-2", name: "Write", input: {} },
          ]),
        ]),
      ).toBe(2);
    });

    it("counts visible thinking but ignores redacted and empty thinking", () => {
      expect(
        countTurnSteps([
          assistantMessage("a1", [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            { type: "thinking", thinking: "Checking files" },
            { type: "thinking", thinking: "" },
            { type: "redacted_thinking" },
            {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              redacted: true,
            } as ContentBlock,
          ]),
        ]),
      ).toBe(2);
    });

    it("does not count tool results attached to visible tool calls", () => {
      expect(
        countTurnSteps([
          assistantMessage("a1", [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
          ]),
        ]),
      ).toBe(1);
    });

    it("does not count tool results attached to tool calls from another message in the turn", () => {
      expect(
        countTurnSteps([
          assistantMessage("a1", [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          ]),
          assistantMessage("a2", [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
          ]),
        ]),
      ).toBe(1);
    });

    it("counts standalone trace rows across messages", () => {
      expect(
        countTurnSteps([
          assistantMessage("a1", [
            { type: "tool_result", tool_use_id: "orphan", content: "ok" },
          ]),
          assistantMessage("a2", [
            {
              type: "teammate_message",
              teammateId: "alice",
              content: "Done",
            },
            {
              type: "task_notification",
              taskId: "task-1",
              outputFile: "/tmp/report.md",
              status: "completed",
              summary: "Finished",
            },
          ]),
        ]),
      ).toBe(3);
    });

    it("counts visible text before later work as a trace row", () => {
      expect(
        countTurnSteps([
          assistantMessage("a1", [
            { type: "text", text: "I'll inspect the files first." },
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          ]),
          assistantMessage("a2", [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
            { type: "text", text: "Done." },
          ]),
        ]),
      ).toBe(2);
    });

    it("does not count final text before later status rows as trace work", () => {
      expect(
        countTurnSteps([
          assistantMessage("a1", [
            { type: "text", text: "Done. I updated the tests." },
            {
              type: "task_notification",
              taskId: "task-1",
              outputFile: "/tmp/report.md",
              status: "completed",
              summary: "Task finished.",
            },
            {
              type: "teammate_message",
              teammateId: "alice",
              content: "I fixed the failing test.",
            },
          ]),
        ]),
      ).toBe(2);
    });
  });

  describe("filterContentForRenderMode", () => {
    it("keeps errors in final output but excludes them from trace-only output", () => {
      const content: ContentBlock[] = [
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        { type: "text", text: "Final answer" },
        { type: "error", error: "Failed" },
      ];

      expect(filterContentForRenderMode(content, "trace-only")).toEqual([
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      ]);
      expect(filterContentForRenderMode(content, "final-text-only")).toEqual([
        { type: "text", text: "Final answer" },
        { type: "error", error: "Failed" },
      ]);
    });
  });

  describe("buildTraceMessageView", () => {
    it("builds a synthetic trace message from multiple assistant messages", () => {
      const trace = buildTraceMessageView(
        [
          assistantMessage("a1", [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            { type: "text", text: "Interim text" },
          ], 100),
          assistantMessage("a2", [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
            { type: "error", error: "Failed" },
          ], 200),
        ],
        "a2",
      );

      expect(trace).toMatchObject({
        id: "a2",
        created_at: 200,
        content: [
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          { type: "text", text: "Interim text" },
          { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
        ],
      });
    });

    it("collapses interim text into the trace and leaves final text out", () => {
      const trace = buildTraceMessageView(
        [
          assistantMessage("a1", [
            { type: "text", text: "I'll inspect the files first." },
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          ], 100),
          assistantMessage("a2", [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
            { type: "text", text: "Done." },
          ], 200),
        ],
        "a2",
      );

      expect(trace?.content).toEqual([
        { type: "text", text: "I'll inspect the files first." },
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
      ]);
    });

    it("keeps task and teammate status rows in the trace without absorbing prior final text", () => {
      const finalText: ContentBlock = {
        type: "text",
        text: "Done. I updated the tests.",
      };
      const taskNotification: ContentBlock = {
        type: "task_notification",
        taskId: "task-1",
        outputFile: "/tmp/report.md",
        status: "completed",
        summary: "Task finished.",
      };
      const teammateMessage: ContentBlock = {
        type: "teammate_message",
        teammateId: "alice",
        content: "I fixed the failing test.",
      };

      const trace = buildTraceMessageView(
        [
          assistantMessage("a1", [
            finalText,
            taskNotification,
            teammateMessage,
          ], 100),
        ],
        "a1",
      );

      expect(trace?.content).toEqual([
        taskNotification,
        teammateMessage,
      ]);
    });
  });

  describe("formatTurnDuration", () => {
    it.each([
      [0, "0:00"],
      [14_000, "0:14"],
      [138_000, "2:18"],
      [3_600_000, "1:00:00"],
      [3_725_000, "1:02:05"],
    ])("formats %i ms as %s", (ms, expected) => {
      expect(formatTurnDuration(ms)).toBe(expected);
    });
  });

  describe("formatTurnDurationForScreenReader", () => {
    it.each([
      [0, "0 seconds"],
      [60_000, "1 minute"],
      [138_000, "2 minutes 18 seconds"],
    ])("formats %i ms as %s", (ms, expected) => {
      expect(formatTurnDurationForScreenReader(ms)).toBe(expected);
    });
  });

  describe("final output helpers", () => {
    it("detects visible text and error output", () => {
      expect(hasFinalOutput([assistantMessage("a1", [])])).toBe(false);
      expect(
        hasFinalOutput([
          assistantMessage("a1", [{ type: "text", text: "Answer" }]),
        ]),
      ).toBe(true);
      expect(
        hasFinalOutput([
          assistantMessage("a1", [
            {
              type: "text",
              text: "<camelai system message>hidden</camelai system message>",
            },
          ]),
        ]),
      ).toBe(false);
      expect(
        hasFinalOutput([
          assistantMessage("a1", [{ type: "error", error: "Failed" }]),
        ]),
      ).toBe(true);
      expect(
        hasFinalOutput([
          assistantMessage("a1", [
            { type: "text", text: "I'll inspect first." },
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          ]),
        ]),
      ).toBe(false);
    });

    it("builds a synthetic final output message from multiple assistant messages", () => {
      const final = buildFinalOutputMessageView(
        [
          assistantMessage("a1", [
            { type: "text", text: "First" },
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          ], 100),
          {
            ...assistantMessage("a2", [
              { type: "text", text: "Second" },
              { type: "error", error: "Failed" },
            ], 200),
            forkEntryId: "fork-1",
          },
        ],
        "a2",
      );

      expect(final).toMatchObject({
        id: "a2",
        forkEntryId: "fork-1",
        created_at: 200,
        content: [
          { type: "text", text: "Second" },
          { type: "error", error: "Failed" },
        ],
      });
    });

    it("keeps only text after the final work block in final output", () => {
      const final = buildFinalOutputMessageView(
        [
          assistantMessage("a1", [
            { type: "text", text: "I'll inspect the files first." },
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          ], 100),
          assistantMessage("a2", [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
            { type: "text", text: "Done." },
          ], 200),
        ],
        "a2",
      );

      expect(final?.content).toEqual([
        { type: "text", text: "Done." },
      ]);
    });

    it("keeps prior final text visible when status rows arrive after it", () => {
      const finalText: ContentBlock = {
        type: "text",
        text: "Done. I updated the tests.",
      };
      const taskNotification: ContentBlock = {
        type: "task_notification",
        taskId: "task-1",
        outputFile: "/tmp/report.md",
        status: "completed",
        summary: "Task finished.",
      };
      const teammateMessage: ContentBlock = {
        type: "teammate_message",
        teammateId: "alice",
        content: "I fixed the failing test.",
      };

      const final = buildFinalOutputMessageView(
        [
          assistantMessage("a1", [
            finalText,
            taskNotification,
            teammateMessage,
          ], 100),
        ],
        "a1",
      );

      expect(final?.content).toEqual([
        finalText,
      ]);
    });

    it("preserves mention annotations for the message renderer", () => {
      const annotated =
        'Check @camel ⟦ref: other "Camel" id=conn_123⟧ please';
      const final = buildFinalOutputMessageView(
        [
          assistantMessage("a1", [
            { type: "text", text: annotated },
          ]),
          assistantMessage(
            "a2",
            `${annotated}\n<camelai system message>hidden</camelai system message>`,
          ),
        ],
        "a2",
      );

      expect(final?.content).toEqual([
        { type: "text", text: annotated },
        {
          type: "text",
          text: `${annotated}\n<camelai system message>hidden</camelai system message>`,
        },
      ]);
    });
  });
});
