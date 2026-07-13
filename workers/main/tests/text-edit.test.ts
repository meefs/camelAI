import { describe, expect, it } from "vitest";

import {
  applyTextEdits,
  normalizeTextEditArguments,
} from "../src/text-edit";

describe("text edit engine", () => {
  it("applies disjoint edits against the original content and emits separate diff hunks", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${String(index + 1).padStart(2, "0")}`).join("\n");
    const result = applyTextEdits(before, [
      { oldText: "line 02", newText: "changed 02" },
      { oldText: "line 19", newText: "changed 19" },
    ], "example.txt");

    expect(result.after).toContain("changed 02");
    expect(result.after).toContain("changed 19");
    expect(result.diff).toContain("...");
    expect(result.diff).not.toContain("-10 line 10");
    expect(result.patch).toContain("@@");
    expect(result.firstChangedLine).toBe(2);
  });

  it("matches LF model text in a CRLF file and preserves CRLF", () => {
    const result = applyTextEdits(
      "alpha\r\nbeta\r\ngamma\r\n",
      [{ oldText: "beta\ngamma", newText: "two\nthree" }],
      "windows.txt",
    );
    expect(result.after).toBe("alpha\r\ntwo\r\nthree\r\n");
  });

  it("uses conservative fuzzy matching without rewriting untouched lines", () => {
    const result = applyTextEdits(
      "keep trailing   \nA “smart” — line   \nuntouched   \n",
      [{ oldText: 'A "smart" - line', newText: "A plain line" }],
      "unicode.txt",
    );
    expect(result.usedFuzzyMatch).toBe(true);
    expect(result.after).toBe("keep trailing   \nA plain line\nuntouched   \n");
  });

  it("preserves a UTF-8 BOM", () => {
    const result = applyTextEdits("\uFEFFhello\n", [{ oldText: "hello", newText: "goodbye" }], "bom.txt");
    expect(result.after).toBe("\uFEFFgoodbye\n");
  });

  it("rejects duplicate, overlapping, empty, missing, and no-op edits", () => {
    expect(() => applyTextEdits("x x", [{ oldText: "x", newText: "y" }], "a.txt"))
      .toThrow("2 occurrences");
    expect(() => applyTextEdits("abcdef", [
      { oldText: "abc", newText: "x" },
      { oldText: "bc", newText: "y" },
    ], "a.txt")).toThrow("overlap");
    expect(() => applyTextEdits("abc", [{ oldText: "", newText: "x" }], "a.txt"))
      .toThrow("must not be empty");
    expect(() => applyTextEdits("abc\u00A0", [{ oldText: " ", newText: "x" }], "a.txt"))
      .toThrow("must contain non-whitespace text");
    expect(() => applyTextEdits("abc", [{ oldText: "z", newText: "x" }], "a.txt"))
      .toThrow("Could not find");
    expect(() => applyTextEdits("abc", [{ oldText: "abc", newText: "abc" }], "a.txt"))
      .toThrow("No changes made");
  });

  it("normalizes stringified, camelCase, snake_case, and legacy arguments", () => {
    expect(normalizeTextEditArguments({
      edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
      old_string: "c",
      new_string: "d",
    })).toEqual([
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d" },
    ]);
  });
});
