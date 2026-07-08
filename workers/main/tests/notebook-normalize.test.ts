import { describe, expect, it } from "vitest";
import { isNotebookPath, normalizeNotebookJson } from "../src/notebook-normalize";

function notebook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [],
    ...overrides,
  };
}

describe("isNotebookPath", () => {
  it("matches .ipynb case-insensitively and nothing else", () => {
    expect(isNotebookPath("/analysis.ipynb")).toBe(true);
    expect(isNotebookPath("/reports/Q4.IPYNB")).toBe(true);
    expect(isNotebookPath("/analysis.ipynb.bak")).toBe(false);
    expect(isNotebookPath("/analysis.py")).toBe(false);
  });
});

describe("normalizeNotebookJson", () => {
  it("returns unchanged content for an already-valid notebook", () => {
    const content = JSON.stringify(
      notebook({
        cells: [
          {
            cell_type: "code",
            id: "abc",
            metadata: {},
            source: ["import pandas as pd\n", "pd.DataFrame()"],
            outputs: [],
            execution_count: null,
          },
        ],
      }),
    );
    const result = normalizeNotebookJson(content);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.fixes).toEqual([]);
  });

  it("adds missing outputs and execution_count to code cells", () => {
    const result = normalizeNotebookJson(
      JSON.stringify(
        notebook({
          cells: [{ cell_type: "code", id: "a", metadata: {}, source: "print(1)" }],
        }),
      ),
    );
    expect(result.changed).toBe(true);
    expect(result.fixes).toEqual([
      "cell 0: added outputs: []",
      "cell 0: set execution_count: null",
    ]);
    const parsed = JSON.parse(result.content) as { cells: Array<Record<string, unknown>> };
    expect(parsed.cells[0].outputs).toEqual([]);
    expect(parsed.cells[0].execution_count).toBeNull();
  });

  it("repairs missing newlines between source array elements", () => {
    const result = normalizeNotebookJson(
      JSON.stringify(
        notebook({
          cells: [
            {
              cell_type: "code",
              id: "a",
              metadata: {},
              source: ["import urllib.request", "import pandas as pd\n", "print(1)"],
              outputs: [],
              execution_count: null,
            },
          ],
        }),
      ),
    );
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(result.content) as { cells: Array<{ source: string[] }> };
    expect(parsed.cells[0].source).toEqual([
      "import urllib.request\n",
      "import pandas as pd\n",
      "print(1)",
    ]);
    expect(result.fixes).toContain("cell 0: added 1 missing newline between source lines");
  });

  it("leaves boundaries where the next element starts with a continuation token", () => {
    const result = normalizeNotebookJson(
      JSON.stringify(
        notebook({
          cells: [
            {
              cell_type: "code",
              id: "a",
              metadata: {},
              // ["obj", ".method()"] means obj.method(); a newline there would
              // change the code. The wordlike boundary before print(1) is a
              // genuine missing line break and still gets repaired.
              source: ["obj", ".method()", "print(1)"],
              outputs: [],
              execution_count: null,
            },
          ],
        }),
      ),
    );
    const parsed = JSON.parse(result.content) as { cells: Array<{ source: string[] }> };
    expect(parsed.cells[0].source).toEqual(["obj", ".method()\n", "print(1)"]);
  });

  it("re-assigns duplicate cell ids, keeping the first occurrence", () => {
    const result = normalizeNotebookJson(
      JSON.stringify(
        notebook({
          cells: [
            { cell_type: "code", id: "dup", metadata: {}, source: "", outputs: [], execution_count: null },
            { cell_type: "code", id: "dup", metadata: {}, source: "", outputs: [], execution_count: null },
          ],
        }),
      ),
    );
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(result.content) as { cells: Array<{ id: string }> };
    expect(parsed.cells[0].id).toBe("dup");
    expect(parsed.cells[1].id).not.toBe("dup");
    expect(result.fixes.some((fix) => fix.includes("duplicate id"))).toBe(true);
  });

  it("removes outputs and execution_count from markdown cells", () => {
    const result = normalizeNotebookJson(
      JSON.stringify(
        notebook({
          cells: [
            {
              cell_type: "markdown",
              id: "a",
              metadata: {},
              source: "# Title",
              outputs: [],
              execution_count: 3,
            },
          ],
        }),
      ),
    );
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(result.content) as { cells: Array<Record<string, unknown>> };
    expect("outputs" in parsed.cells[0]).toBe(false);
    expect("execution_count" in parsed.cells[0]).toBe(false);
  });

  it("adds unique cell ids when nbformat requires them", () => {
    const result = normalizeNotebookJson(
      JSON.stringify(
        notebook({
          cells: [
            { cell_type: "code", id: "cell-1", metadata: {}, source: "", outputs: [], execution_count: null },
            { cell_type: "code", metadata: {}, source: "", outputs: [], execution_count: null },
          ],
        }),
      ),
    );
    const parsed = JSON.parse(result.content) as { cells: Array<{ id: string }> };
    const ids = parsed.cells.map((cell) => cell.id);
    expect(ids[0]).toBe("cell-1");
    expect(ids[1]).toMatch(/^cell-1(-\d+)?$/);
    expect(new Set(ids).size).toBe(2);
  });

  it("does not add cell ids for nbformat < 4.5", () => {
    const result = normalizeNotebookJson(
      JSON.stringify(
        notebook({
          nbformat_minor: 2,
          cells: [{ cell_type: "code", metadata: {}, source: "", outputs: [], execution_count: null }],
        }),
      ),
    );
    expect(result.changed).toBe(false);
  });

  it("fills top-level nbformat fields and metadata", () => {
    const result = normalizeNotebookJson(JSON.stringify({ cells: [] }));
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.nbformat).toBe(4);
    expect(parsed.nbformat_minor).toBe(5);
    expect(parsed.metadata).toEqual({});
  });

  it("normalizes non-integer execution_count to null", () => {
    const result = normalizeNotebookJson(
      JSON.stringify(
        notebook({
          cells: [
            { cell_type: "code", id: "a", metadata: {}, source: "", outputs: [], execution_count: "3" },
          ],
        }),
      ),
    );
    const parsed = JSON.parse(result.content) as { cells: Array<Record<string, unknown>> };
    expect(parsed.cells[0].execution_count).toBeNull();
  });

  it("rejects unparseable JSON with an actionable message", () => {
    expect(() => normalizeNotebookJson("{ not json")).toThrowError(/Invalid \.ipynb notebook: JSON parse failed/);
  });

  it("rejects notebooks without a cells array", () => {
    expect(() => normalizeNotebookJson(JSON.stringify({ nbformat: 4 }))).toThrowError(/cells must be an array/);
  });

  it("rejects unknown cell types", () => {
    expect(() =>
      normalizeNotebookJson(JSON.stringify(notebook({ cells: [{ cell_type: "python", source: "" }] }))),
    ).toThrowError(/cell 0 has cell_type "python"/);
  });

  it("rejects non-string source elements", () => {
    expect(() =>
      normalizeNotebookJson(
        JSON.stringify(notebook({ cells: [{ cell_type: "code", metadata: {}, source: [42], outputs: [], execution_count: null }] })),
      ),
    ).toThrowError(/source\[0\] is not a string/);
  });
});
