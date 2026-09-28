import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallDetails } from "@/components/tool-call/tool-details";
import type { ToolResultBlock, ToolUseBlock } from "@/types";

const tool: ToolUseBlock = { type: "tool_use", id: "call_9", name: "connections_query", input: {} };

describe("ToolCallDetails and a cut result", () => {
  it("links to the whole result when the runtime cut it", () => {
    const result: ToolResultBlock = {
      type: "tool_result", tool_use_id: "call_9", content: "rows…",
      details: { fullResult: { path: "/workspace/tool-results/3-call_9.txt", href: "/api/threads/t1/files/workspace/tool-results/3-call_9.txt" } },
    };
    render(<ToolCallDetails tool={tool} result={result} />);
    const link = screen.getByRole("link", { name: "View full result" });
    expect(link.getAttribute("href")).toBe("/api/threads/t1/files/workspace/tool-results/3-call_9.txt");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("shows no link otherwise", () => {
    render(<ToolCallDetails tool={tool} result={{ type: "tool_result", tool_use_id: "call_9", content: "ok" }} />);
    expect(screen.queryByRole("link", { name: "View full result" })).toBeNull();
  });
});
