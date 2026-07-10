import { describe, expect, it } from "vitest";

import { extractVitestUnhandledErrors } from "../scripts/eval-harness-errors.mjs";

describe("eval harness unhandled error classification", () => {
  it("keeps source-manifest failures unfiltered", () => {
    const result = extractVitestUnhandledErrors(`
Unhandled Errors
Unhandled Rejection
Error: File not found: /workspace/demo.source-manifest.json
`);

    expect(result.filteredHarnessErrors).toEqual([]);
    expect(result.harnessErrors).toEqual([
      {
        tool: "harness",
        reason: "vitest_unhandled_error",
        output: "Error: File not found: /workspace/demo.source-manifest.json",
      },
    ]);
  });

  it("still filters known duplicate tool-envelope errors", () => {
    const result = extractVitestUnhandledErrors(`
Unhandled Errors
Unhandled Rejection
Error: already delivered to the tool caller
    at callToolEnvelope (code-mode-tools.ts:1:1)
`);

    expect(result.harnessErrors).toEqual([]);
    expect(result.filteredHarnessErrors).toEqual([
      {
        tool: "harness",
        reason: "enveloped_tool_duplicate",
        output: "Error: already delivered to the tool caller",
      },
    ]);
  });
});
