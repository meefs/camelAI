/**
 * Jupyter notebook (.ipynb) normalization applied when the agent writes or
 * edits a notebook through the workspace/project file tools.
 *
 * nbformat is strict in ways that cost the agent write→run→fix roundtrips:
 * code cells must carry `outputs: []` and `execution_count: null`, markdown
 * cells must NOT carry them, nbformat >= 4.5 requires unique cell ids, and
 * multi-element `source` arrays are concatenated verbatim — an element without
 * a trailing "\n" silently merges with the next line (the classic
 * `import urllib.request` + `import pandas` → `urllib.requestimport pandas`
 * failure). Jupyter's own canonical form is one newline-terminated line per
 * element, so we repair toward that instead of failing the run later.
 *
 * Invalid JSON is rejected here, loudly, so the author fixes it at write time
 * rather than debugging an opaque nbconvert failure on the next run_notebook.
 */

const NOTEBOOK_CELL_TYPES = new Set(["code", "markdown", "raw"]);

/**
 * A source element starting with one of these tokens reads as a continuation
 * of the previous line (`["obj", ".method()"]` means `obj.method()`), not a
 * new statement — a Python line outside brackets cannot begin with them. The
 * newline repair skips such boundaries and joins verbatim, since inserting a
 * newline there would change what the code means.
 */
const CONTINUATION_START = /^[.,)\]}+\-*/%=<>&|^~@]/;

export interface NotebookNormalizationResult {
  /** The content to persist (original string when no fixes were needed). */
  content: string;
  changed: boolean;
  /** Human-readable descriptions of every repair applied. */
  fixes: string[];
}

export function isNotebookPath(path: string): boolean {
  return path.toLowerCase().endsWith(".ipynb");
}

function invalidNotebook(message: string): Error {
  return new Error(
    `Invalid .ipynb notebook: ${message}. ` +
      "Notebooks are structured JSON (nbformat): a top-level object with a cells array; " +
      "code cells need source, metadata, outputs, and execution_count fields.",
  );
}

/**
 * Parse, validate, and repair a notebook JSON string. Throws on structural
 * problems that cannot be repaired safely (unparseable JSON, cells that are
 * not objects, non-string source elements); repairs the well-known nbformat
 * papercuts and reports each fix.
 */
export function normalizeNotebookJson(content: string): NotebookNormalizationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw invalidNotebook(
      `JSON parse failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidNotebook("top level must be a JSON object");
  }
  const nb = parsed as Record<string, unknown>;
  if (!Array.isArray(nb.cells)) {
    throw invalidNotebook("top-level cells must be an array");
  }

  const fixes: string[] = [];

  if (typeof nb.nbformat !== "number") {
    nb.nbformat = 4;
    fixes.push("set nbformat: 4");
  }
  if (typeof nb.nbformat_minor !== "number") {
    nb.nbformat_minor = 5;
    fixes.push("set nbformat_minor: 5");
  }
  if (!nb.metadata || typeof nb.metadata !== "object" || Array.isArray(nb.metadata)) {
    nb.metadata = {};
    fixes.push("added notebook metadata: {}");
  }

  const requiresCellIds =
    (nb.nbformat as number) > 4 ||
    ((nb.nbformat as number) === 4 && (nb.nbformat_minor as number) >= 5);
  // All ids present in the input (so generated ids never collide with an id
  // appearing later in the notebook) plus the ids already assigned while
  // walking (so duplicates get re-assigned, and re-assignments stay unique).
  const existingIds = new Set<string>();
  for (const cell of nb.cells) {
    if (cell && typeof cell === "object" && typeof (cell as { id?: unknown }).id === "string") {
      existingIds.add((cell as { id: string }).id);
    }
  }
  const usedIds = new Set<string>();
  const nextUniqueId = (index: number): string => {
    let id = `cell-${index}`;
    for (let suffix = 2; existingIds.has(id) || usedIds.has(id); suffix += 1) {
      id = `cell-${index}-${suffix}`;
    }
    return id;
  };

  nb.cells.forEach((rawCell, index) => {
    if (!rawCell || typeof rawCell !== "object" || Array.isArray(rawCell)) {
      throw invalidNotebook(`cell ${index} is not an object`);
    }
    const cell = rawCell as Record<string, unknown>;
    const cellType = cell.cell_type;
    if (typeof cellType !== "string" || !NOTEBOOK_CELL_TYPES.has(cellType)) {
      throw invalidNotebook(
        `cell ${index} has cell_type ${JSON.stringify(cellType)} (expected "code", "markdown", or "raw")`,
      );
    }

    if (!cell.metadata || typeof cell.metadata !== "object" || Array.isArray(cell.metadata)) {
      cell.metadata = {};
      fixes.push(`cell ${index}: added metadata: {}`);
    }

    if (requiresCellIds) {
      if (typeof cell.id !== "string") {
        const id = nextUniqueId(index);
        cell.id = id;
        fixes.push(`cell ${index}: added id ${JSON.stringify(id)}`);
      } else if (usedIds.has(cell.id)) {
        // nbformat >= 4.5 requires UNIQUE ids; keep the first occurrence and
        // re-assign later duplicates.
        const id = nextUniqueId(index);
        fixes.push(`cell ${index}: replaced duplicate id ${JSON.stringify(cell.id)} with ${JSON.stringify(id)}`);
        cell.id = id;
      }
      usedIds.add(cell.id as string);
    }

    if (cell.source === undefined) {
      cell.source = [];
      fixes.push(`cell ${index}: added empty source`);
    } else if (Array.isArray(cell.source)) {
      const source = cell.source;
      let repairedNewlines = 0;
      source.forEach((line, lineIndex) => {
        if (typeof line !== "string") {
          throw invalidNotebook(`cell ${index} source[${lineIndex}] is not a string`);
        }
        // Elements are concatenated verbatim; a missing trailing newline glues
        // two intended lines together. Jupyter's canonical form terminates
        // every element but the last with "\n", so repair toward
        // line-per-element — EXCEPT when the next element starts with a
        // continuation token (see CONTINUATION_START): there the split reads
        // as an intentional mid-expression break, and inserting a newline
        // would change the code's meaning, so that boundary joins verbatim.
        if (lineIndex >= source.length - 1 || line.endsWith("\n")) return;
        const next = source[lineIndex + 1];
        if (typeof next === "string" && CONTINUATION_START.test(next)) return;
        source[lineIndex] = `${line}\n`;
        repairedNewlines += 1;
      });
      if (repairedNewlines > 0) {
        fixes.push(
          `cell ${index}: added ${repairedNewlines} missing newline${repairedNewlines === 1 ? "" : "s"} between source lines`,
        );
      }
    } else if (typeof cell.source !== "string") {
      throw invalidNotebook(`cell ${index} source must be a string or array of strings`);
    }

    if (cellType === "code") {
      if (!Array.isArray(cell.outputs)) {
        cell.outputs = [];
        fixes.push(`cell ${index}: added outputs: []`);
      }
      const count = cell.execution_count;
      if (count !== null && (typeof count !== "number" || !Number.isInteger(count))) {
        cell.execution_count = null;
        fixes.push(`cell ${index}: set execution_count: null`);
      }
    } else {
      // nbformat rejects outputs/execution_count on markdown and raw cells.
      if ("outputs" in cell) {
        delete cell.outputs;
        fixes.push(`cell ${index}: removed outputs from ${cellType} cell`);
      }
      if ("execution_count" in cell) {
        delete cell.execution_count;
        fixes.push(`cell ${index}: removed execution_count from ${cellType} cell`);
      }
    }
  });

  if (fixes.length === 0) {
    return { content, changed: false, fixes };
  }
  // Indent 1 matches Jupyter's own serialization.
  return { content: `${JSON.stringify(nb, null, 1)}\n`, changed: true, fixes };
}
