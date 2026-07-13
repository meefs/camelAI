import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/tool-call/details/shared", () => ({
  DetailRow: ({ label, value }: { label: string; value: string }) => <div>{label} {value}</div>,
  ProjectDetailRow: () => null,
}));

import { EditDetails } from "@/components/tool-call/details/edit-details";

describe("EditDetails", () => {
  it("renders camelCase edit arguments while a call is in flight", () => {
    render(<EditDetails tool={{
      type: "tool_use",
      id: "edit-1",
      name: "Edit",
      input: {
        path: "/src/example.ts",
        edits: [{ oldText: "const oldValue = 1;", newText: "const newValue = 2;" }],
      },
    }} />);

    expect(screen.getByText(/1 replacements/)).toBeInTheDocument();
    expect(screen.getByText("- const oldValue = 1;")).toBeInTheDocument();
    expect(screen.getByText("+ const newValue = 2;")).toBeInTheDocument();
  });

  it("prefers the authoritative applied diff from the tool result", () => {
    render(<EditDetails
      tool={{
        type: "tool_use",
        id: "edit-1",
        name: "Edit",
        input: { path: "/src/example.ts", edits: [{ oldText: "old", newText: "requested" }] },
      }}
      result={{
        type: "tool_result",
        tool_use_id: "edit-1",
        content: "edited",
        details: {
          diff: "-1 old\n+1 applied",
          replacementCount: 1,
        },
      }}
    />);

    expect(screen.getByText("-1 old")).toBeInTheDocument();
    expect(screen.getByText("+1 applied")).toBeInTheDocument();
    expect(screen.queryByText("+ requested")).not.toBeInTheDocument();
  });
});
