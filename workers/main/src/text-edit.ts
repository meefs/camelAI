import * as Diff from "diff";

export interface TextEdit {
  oldText: string;
  newText: string;
}

export interface TextEditDetails {
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

export interface AppliedTextEdits extends TextEditDetails {
  before: string;
  after: string;
  replacementCount: number;
  usedFuzzyMatch: boolean;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

type Replacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

interface LineSpan {
  start: number;
  end: number;
}

export function normalizeTextEditArguments(args: Record<string, unknown>): TextEdit[] {
  let rawEdits = args.edits;
  if (typeof rawEdits === "string") {
    try {
      const parsed = JSON.parse(rawEdits);
      if (Array.isArray(parsed)) rawEdits = parsed;
    } catch {
      // The validation error below is more useful than a JSON parser error.
    }
  }

  const edits: TextEdit[] = [];
  if (Array.isArray(rawEdits)) {
    rawEdits.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`edits[${index}] must be an object`);
      }
      const record = entry as Record<string, unknown>;
      const oldText = typeof record.oldText === "string"
        ? record.oldText
        : typeof record.old_string === "string"
          ? record.old_string
          : undefined;
      const newText = typeof record.newText === "string"
        ? record.newText
        : typeof record.new_string === "string"
          ? record.new_string
          : undefined;
      if (oldText === undefined) throw new Error(`edits[${index}].oldText must be a string`);
      if (newText === undefined) throw new Error(`edits[${index}].newText must be a string`);
      edits.push({ oldText, newText });
    });
  }

  const legacyOldText = typeof args.oldText === "string"
    ? args.oldText
    : typeof args.old_string === "string"
      ? args.old_string
      : undefined;
  const legacyNewText = typeof args.newText === "string"
    ? args.newText
    : typeof args.new_string === "string"
      ? args.new_string
      : undefined;
  if (legacyOldText !== undefined || legacyNewText !== undefined) {
    if (legacyOldText === undefined) throw new Error("oldText must be a string");
    if (legacyNewText === undefined) throw new Error("newText must be a string");
    edits.push({ oldText: legacyOldText, newText: legacyNewText });
  }

  if (edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return edits;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1 || crlfIndex === -1) return "\n";
  return crlfIndex <= lfIndex ? "\r\n" : "\n";
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function replacementLineRange(lines: LineSpan[], replacement: Replacement) {
  const start = replacement.matchIndex;
  const end = replacement.matchIndex + replacement.matchLength;
  let startLine = lines.findIndex((line) => start >= line.start && start < line.end);
  if (startLine === -1 && start === 0 && lines.length === 0) startLine = 0;
  if (startLine < 0 || startLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < end) endLine += 1;
  if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.slice(0, matchIndex) +
      replacement.newText +
      result.slice(matchIndex + replacement.matchLength);
  }
  return result;
}

function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  normalizedContent: string,
  replacements: Replacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const normalizedLineSpans = getLineSpans(normalizedContent);
  if (originalLines.length !== normalizedLineSpans.length) {
    throw new Error("Cannot preserve unchanged lines because normalization changed the line count.");
  }

  const groups: Array<{ startLine: number; endLine: number; replacements: Replacement[] }> = [];
  for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = replacementLineRange(normalizedLineSpans, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
    } else {
      groups.push({ ...range, replacements: [replacement] });
    }
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStart = normalizedLineSpans[group.startLine].start;
    const groupEnd = normalizedLineSpans[group.endLine - 1].end;
    result += applyReplacements(
      normalizedContent.slice(groupStart, groupEnd),
      group.replacements,
      groupStart,
    );
    originalLineIndex = group.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join("");
}

function occurrenceCount(content: string, oldText: string): number {
  if (!oldText) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const match = content.indexOf(oldText, offset);
    if (match === -1) break;
    count += 1;
    offset = match + oldText.length;
  }
  return count;
}

function displayEditIndex(index: number, total: number): string {
  return total === 1 ? "text" : `edits[${index}]`;
}

export function generateTextEditDetails(
  path: string,
  before: string,
  after: string,
): TextEditDetails {
  const parts = Diff.diffLines(before, after);
  const maxLineNumber = Math.max(before.split("\n").length, after.split("\n").length);
  const width = String(maxLineNumber).length;
  const output: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let firstChangedLine: number | undefined;
  const contextLines = 4;

  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (part.added || part.removed) {
      firstChangedLine ??= newLine;
      for (const line of lines) {
        if (part.added) {
          output.push(`+${String(newLine).padStart(width, " ")} ${line}`);
          newLine += 1;
        } else {
          output.push(`-${String(oldLine).padStart(width, " ")} ${line}`);
          oldLine += 1;
        }
      }
      continue;
    }

    const previousChanged = partIndex > 0 && Boolean(parts[partIndex - 1].added || parts[partIndex - 1].removed);
    const nextChanged = partIndex + 1 < parts.length && Boolean(parts[partIndex + 1].added || parts[partIndex + 1].removed);
    let visibleStart = 0;
    let visibleEnd = lines.length;
    if (!previousChanged) visibleStart = Math.max(0, lines.length - contextLines);
    if (!nextChanged) visibleEnd = Math.min(lines.length, contextLines);
    if (previousChanged && nextChanged && lines.length > contextLines * 2) {
      const leading = lines.slice(0, contextLines);
      const trailing = lines.slice(-contextLines);
      for (const line of leading) {
        output.push(` ${String(oldLine).padStart(width, " ")} ${line}`);
        oldLine += 1;
        newLine += 1;
      }
      output.push(` ${"".padStart(width, " ")} ...`);
      oldLine += lines.length - contextLines * 2;
      newLine += lines.length - contextLines * 2;
      for (const line of trailing) {
        output.push(` ${String(oldLine).padStart(width, " ")} ${line}`);
        oldLine += 1;
        newLine += 1;
      }
      continue;
    }
    if (visibleStart > 0) {
      output.push(` ${"".padStart(width, " ")} ...`);
      oldLine += visibleStart;
      newLine += visibleStart;
    }
    for (const line of lines.slice(visibleStart, visibleEnd)) {
      output.push(` ${String(oldLine).padStart(width, " ")} ${line}`);
      oldLine += 1;
      newLine += 1;
    }
    const skippedTail = lines.length - visibleEnd;
    if (skippedTail > 0) {
      output.push(` ${"".padStart(width, " ")} ...`);
      oldLine += skippedTail;
      newLine += skippedTail;
    }
  }

  return {
    diff: output.join("\n"),
    patch: Diff.createTwoFilesPatch(path, path, before, after, undefined, undefined, {
      context: contextLines,
    }),
    firstChangedLine,
  };
}

export function applyTextEdits(content: string, edits: TextEdit[], path: string): AppliedTextEdits {
  if (edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  const { bom, text } = content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
  const lineEnding = detectLineEnding(text);
  const baseContent = normalizeToLf(text);
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }));

  normalizedEdits.forEach((edit, index) => {
    if (!edit.oldText) throw new Error(`${displayEditIndex(index, edits.length)} must not be empty in ${path}.`);
  });

  const needsFuzzyMatch = normalizedEdits.some((edit) => !baseContent.includes(edit.oldText));
  const replacementBase = needsFuzzyMatch ? normalizeForFuzzyMatch(baseContent) : baseContent;
  const matched: MatchedEdit[] = normalizedEdits.map((edit, index) => {
    const matchText = needsFuzzyMatch ? normalizeForFuzzyMatch(edit.oldText) : edit.oldText;
    if (needsFuzzyMatch && !matchText) {
      throw new Error(`${displayEditIndex(index, edits.length)} must contain non-whitespace text in ${path}.`);
    }
    const matchIndex = replacementBase.indexOf(matchText);
    if (matchIndex === -1) {
      throw new Error(
        `Could not find ${displayEditIndex(index, edits.length)} in ${path}. ` +
        "The old text must match including its surrounding whitespace and newlines.",
      );
    }
    const occurrences = occurrenceCount(replacementBase, matchText);
    if (occurrences > 1) {
      throw new Error(
        `Found ${occurrences} occurrences of ${displayEditIndex(index, edits.length)} in ${path}. ` +
        "Add more context to make it unique.",
      );
    }
    return {
      editIndex: index,
      matchIndex,
      matchLength: matchText.length,
      newText: edit.newText,
    };
  }).sort((a, b) => a.matchIndex - b.matchIndex);

  for (let index = 1; index < matched.length; index += 1) {
    const previous = matched[index - 1];
    const current = matched[index];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. ` +
        "Merge them into one edit or target disjoint regions.",
      );
    }
  }

  const editedNormalized = needsFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(baseContent, replacementBase, matched)
    : applyReplacements(replacementBase, matched);
  if (editedNormalized === baseContent) {
    throw new Error(`No changes made to ${path}. The replacements produced identical content.`);
  }
  const restored = lineEnding === "\r\n"
    ? editedNormalized.replace(/\n/g, "\r\n")
    : editedNormalized;
  const before = bom + text;
  const after = bom + restored;
  return {
    before,
    after,
    replacementCount: edits.length,
    usedFuzzyMatch: needsFuzzyMatch,
    ...generateTextEditDetails(path, before, after),
  };
}
