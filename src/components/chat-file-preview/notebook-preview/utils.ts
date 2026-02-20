import type {
  NotebookCell,
  NotebookFile,
  NotebookOutput,
  NotebookOutputRender,
  ParsedTable,
  TocEntry,
} from './types';

export function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : String(item))).join('');
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function getNotebookCells(notebook: NotebookFile): NotebookCell[] {
  return Array.isArray(notebook.cells) ? notebook.cells : [];
}

function toHtml(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const html = value.map((item) => (typeof item === 'string' ? item : String(item))).join('');
    return html || null;
  }
  return null;
}

function buildHtmlDocument(fragmentOrDocument: string): string {
  const trimmed = fragmentOrDocument.trim();
  if (trimmed.startsWith('<!doctype') || /<html[\s>]/i.test(trimmed)) {
    return fragmentOrDocument;
  }

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { margin: 0; padding: 0.5rem; font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
      pre, code { white-space: pre-wrap; }
      img, svg, canvas { max-width: 100%; }
    </style>
  </head>
  <body>${fragmentOrDocument}</body>
</html>`;
}

function isIdentifierChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_$]/.test(char));
}

function hasTokenBoundary(input: string, start: number, tokenLength: number): boolean {
  const before = input[start - 1];
  const after = input[start + tokenLength];
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

function normalizeNonJsonLiterals(input: string): string {
  let result = '';
  let inString: '"' | "'" | '`' | null = null;
  let escaping = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      result += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      result += char;
      continue;
    }

    if (input.startsWith('-Infinity', i) && hasTokenBoundary(input, i, '-Infinity'.length)) {
      result += 'null';
      i += '-Infinity'.length - 1;
      continue;
    }

    if (input.startsWith('Infinity', i) && hasTokenBoundary(input, i, 'Infinity'.length)) {
      result += 'null';
      i += 'Infinity'.length - 1;
      continue;
    }

    if (input.startsWith('NaN', i) && hasTokenBoundary(input, i, 'NaN'.length)) {
      result += 'null';
      i += 'NaN'.length - 1;
      continue;
    }

    if (input.startsWith('undefined', i) && hasTokenBoundary(input, i, 'undefined'.length)) {
      result += 'null';
      i += 'undefined'.length - 1;
      continue;
    }

    result += char;
  }

  return result;
}

function parseJsonExpression(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const normalized = normalizeNonJsonLiterals(trimmed);
    if (normalized !== trimmed) {
      try {
        return JSON.parse(normalized);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractScriptBlocks(html: string): string[] {
  const scripts: string[] = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null = scriptRegex.exec(html);
  while (match) {
    scripts.push(match[1]);
    match = scriptRegex.exec(html);
  }
  return scripts;
}

function parseExpressionAt(source: string, startIndex: number): string | null {
  let i = startIndex;
  while (i < source.length && /\s/.test(source[i])) {
    i += 1;
  }
  if (i >= source.length) return null;

  let current = '';
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let escaping = false;

  for (; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      current += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      if (depth > 0) {
        depth -= 1;
      }
      current += char;
      continue;
    }

    if ((char === ';' || char === '\n') && depth === 0) {
      return current.trim();
    }

    current += char;
  }

  const trimmed = current.trim();
  return trimmed || null;
}

function splitCallArguments(source: string, openParenIndex: number): string[] | null {
  if (openParenIndex < 0 || openParenIndex >= source.length) return null;
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let escaping = false;

  for (let i = openParenIndex + 1; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      current += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      if (char === ')' && depth === 0) {
        args.push(current.trim());
        return args;
      }
      if (depth > 0) {
        depth -= 1;
      }
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  return null;
}

function splitPlotlyCallArgs(source: string): string[] | null {
  const callMatch = /(?:window\.)?Plotly\.(?:newPlot|react)\s*\(/.exec(source);
  if (!callMatch) return null;

  const openParenOffset = callMatch[0].lastIndexOf('(');
  if (openParenOffset === -1) return null;
  return splitCallArguments(source, callMatch.index + openParenOffset);
}

function resolveJsArgValue(expr: string, script: string): unknown {
  const parsedDirect = parseJsonExpression(expr);
  if (parsedDirect !== null) return parsedDirect;

  const trimmed = expr.trim();
  const identifierMatch = trimmed.match(/^(?:window\.)?([A-Za-z_$][\w$]*)$/);
  if (!identifierMatch) return null;
  const identifier = identifierMatch[1];

  const assignmentRegex = new RegExp(
    `(?:\\b(?:var|let|const)\\s+)?${escapeRegExp(identifier)}\\s*=`,
    'g'
  );
  let assignmentMatch: RegExpExecArray | null = assignmentRegex.exec(script);
  while (assignmentMatch) {
    const valueStart = assignmentMatch.index + assignmentMatch[0].length;
    const expression = parseExpressionAt(script, valueStart);
    if (expression) {
      const parsedAssigned = parseJsonExpression(expression);
      if (parsedAssigned !== null) return parsedAssigned;
    }
    assignmentMatch = assignmentRegex.exec(script);
  }

  return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function getRecordFromMimeData(
  data: Record<string, unknown>,
  mimePattern: RegExp
): Record<string, unknown> | null {
  for (const [mimeType, value] of Object.entries(data)) {
    if (!mimePattern.test(mimeType)) {
      continue;
    }

    const parsed = typeof value === 'string' ? parseJsonExpression(value) : value;
    const record = toRecord(parsed);
    if (record) {
      return record;
    }
  }
  return null;
}

function getPlotlyPayloadFromHtml(html: string): Record<string, unknown> | null {
  if (!/(?:window\.)?Plotly\.(?:newPlot|react)/.test(html)) return null;

  const scriptBlocks = extractScriptBlocks(html);
  const sources = scriptBlocks.length > 0 ? scriptBlocks : [html];

  for (const source of sources) {
    const args = splitPlotlyCallArgs(source);
    if (!args || args.length < 3) continue;

    const dataArg = resolveJsArgValue(args[1], source);
    if (!Array.isArray(dataArg)) continue;

    const layoutArg = resolveJsArgValue(args[2], source);
    if (
      layoutArg !== null &&
      (typeof layoutArg !== 'object' || layoutArg === null || Array.isArray(layoutArg))
    ) {
      continue;
    }

    const configArg = args.length > 3 ? resolveJsArgValue(args[3], source) : null;
    if (
      configArg !== null &&
      (typeof configArg !== 'object' || configArg === null || Array.isArray(configArg))
    ) {
      continue;
    }

    const payload: Record<string, unknown> = { data: dataArg };
    if (layoutArg && typeof layoutArg === 'object') {
      payload.layout = layoutArg as Record<string, unknown>;
    }
    if (configArg && typeof configArg === 'object') {
      payload.config = configArg as Record<string, unknown>;
    }
    return payload;
  }

  return null;
}

function isVegaSpec(
  spec: Record<string, unknown>,
  embedOpt: Record<string, unknown> | null
): boolean {
  const mode = typeof embedOpt?.mode === 'string' ? embedOpt.mode : '';
  const schema = typeof spec.$schema === 'string' ? spec.$schema : '';
  const looksLikeVegaSpec = /\/schema\/vega(?:-lite)?\//i.test(schema);
  const looksLikeVegaMode = mode === 'vega-lite' || mode === 'vega';

  return looksLikeVegaSpec || looksLikeVegaMode;
}

function getVegaSpecFromEmbedCalls(source: string): Record<string, unknown> | null {
  const callRegex = /\b(?:window\.)?vegaEmbed\s*\(/g;
  let callMatch: RegExpExecArray | null = callRegex.exec(source);

  while (callMatch) {
    const openParenOffset = callMatch[0].lastIndexOf('(');
    if (openParenOffset === -1) {
      callMatch = callRegex.exec(source);
      continue;
    }

    const args = splitCallArguments(source, callMatch.index + openParenOffset);
    if (!args || args.length < 2) {
      callMatch = callRegex.exec(source);
      continue;
    }

    const spec = toRecord(resolveJsArgValue(args[1], source));
    if (!spec) {
      callMatch = callRegex.exec(source);
      continue;
    }

    const embedOpt =
      args.length > 2 ? toRecord(resolveJsArgValue(args[2], source)) : null;
    if (isVegaSpec(spec, embedOpt)) {
      return spec;
    }

    callMatch = callRegex.exec(source);
  }

  return null;
}

function getVegaSpecFromWrappedInvocation(source: string): Record<string, unknown> | null {
  const invocationRegex = /\}\)\s*\(/g;
  let match: RegExpExecArray | null = invocationRegex.exec(source);

  while (match) {
    const openParenOffset = match[0].lastIndexOf('(');
    if (openParenOffset === -1) {
      match = invocationRegex.exec(source);
      continue;
    }

    const args = splitCallArguments(source, match.index + openParenOffset);
    if (!args || args.length < 1) {
      match = invocationRegex.exec(source);
      continue;
    }

    const spec = toRecord(resolveJsArgValue(args[0], source));
    if (!spec) {
      match = invocationRegex.exec(source);
      continue;
    }

    const embedOpt =
      args.length > 1 ? toRecord(resolveJsArgValue(args[1], source)) : null;
    if (isVegaSpec(spec, embedOpt)) {
      return spec;
    }

    match = invocationRegex.exec(source);
  }

  return null;
}

function getVegaSpecFromHtml(html: string): Record<string, unknown> | null {
  if (!/vegaEmbed\s*\(/.test(html)) return null;

  const scriptBlocks = extractScriptBlocks(html);
  const sources = scriptBlocks.length > 0 ? scriptBlocks : [html];

  for (const source of sources) {
    if (!/vegaEmbed\s*\(/.test(source)) continue;

    const directCallSpec = getVegaSpecFromEmbedCalls(source);
    if (directCallSpec) {
      return directCallSpec;
    }

    const wrappedInvocationSpec = getVegaSpecFromWrappedInvocation(source);
    if (wrappedInvocationSpec) {
      return wrappedInvocationSpec;
    }
  }

  return null;
}

function getPlotlyPayload(output: NotebookOutput): Record<string, unknown> | null {
  const data = output.data ?? {};
  const directPayload = getRecordFromMimeData(data, /^application\/vnd\.plotly\.v\d+\+json$/i);
  if (directPayload) {
    return directPayload;
  }

  const html = toHtml(data['text/html']);
  if (html) {
    const extracted = getPlotlyPayloadFromHtml(html);
    if (extracted) return extracted;
  }

  return null;
}

const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

const HTML_NAMED_ENTITY_CACHE = new Map<string, string | null>();
let htmlNamedEntityDecoder:
  | {
      innerHTML: string;
      value: string;
    }
  | null
  | undefined;

function getHtmlNamedEntityDecoder():
  | {
      innerHTML: string;
      value: string;
    }
  | null {
  if (typeof htmlNamedEntityDecoder !== 'undefined') {
    return htmlNamedEntityDecoder;
  }

  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    htmlNamedEntityDecoder = null;
    return null;
  }

  htmlNamedEntityDecoder = document.createElement('textarea');
  return htmlNamedEntityDecoder;
}

function decodeNamedHtmlEntity(entity: string): string | null {
  if (entity in HTML_NAMED_ENTITIES) {
    return HTML_NAMED_ENTITIES[entity];
  }

  if (HTML_NAMED_ENTITY_CACHE.has(entity)) {
    return HTML_NAMED_ENTITY_CACHE.get(entity) ?? null;
  }

  const decoder = getHtmlNamedEntityDecoder();
  if (!decoder) {
    HTML_NAMED_ENTITY_CACHE.set(entity, null);
    return null;
  }

  const token = `&${entity};`;
  decoder.innerHTML = token;
  const decoded = decoder.value;
  const hasUnresolvedSuffix = decoded !== ';' && /[A-Za-z0-9_]+;$/.test(decoded);
  const resolved = decoded === token || hasUnresolvedSuffix ? null : decoded;

  HTML_NAMED_ENTITY_CACHE.set(entity, resolved);
  return resolved;
}

function fromCodePointSafe(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi,
    (match: string, entityRaw: string): string => {
      const entity = entityRaw.toLowerCase();
      if (entity.startsWith('#x')) {
        const codePoint = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(codePoint) ? fromCodePointSafe(codePoint, match) : match;
      }

      if (entity.startsWith('#')) {
        const codePoint = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(codePoint) ? fromCodePointSafe(codePoint, match) : match;
      }

      const decodedNamedEntity = decodeNamedHtmlEntity(entity);
      return decodedNamedEntity ?? match;
    }
  );
}

function stripHtmlTags(html: string): string {
  const withoutLineBreakTags = html.replace(/<br\s*\/?>/gi, '\n');
  const withoutTags = withoutLineBreakTags.replace(/<[^>]*>/g, '');
  const decoded = decodeHtmlEntities(withoutTags).replace(/\u00a0/g, ' ');
  return decoded.replace(/\s+/g, ' ').trim();
}

interface ParsedHtmlTableCell {
  tag: 'th' | 'td';
  text: string;
  hasSpan: boolean;
}

function parseRowCells(trInnerHtml: string): ParsedHtmlTableCell[] {
  const cells: ParsedHtmlTableCell[] = [];
  const cellRegex = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null = cellRegex.exec(trInnerHtml);

  while (match) {
    const tag = match[1].toLowerCase() as 'th' | 'td';
    const attrs = match[2] ?? '';
    const text = stripHtmlTags(match[3]);
    const hasSpan = /\b(?:rowspan|colspan)\s*=/i.test(attrs);
    cells.push({ tag, text, hasSpan });
    match = cellRegex.exec(trInnerHtml);
  }

  return cells;
}

function parseRowCellTexts(trInnerHtml: string): string[] {
  return parseRowCells(trInnerHtml).map((cell) => cell.text);
}

function getMaxRowLength(rows: readonly string[][]): number {
  let max = 0;
  for (const row of rows) {
    if (row.length > max) {
      max = row.length;
    }
  }
  return max;
}

function flattenHeaderRows(theadHtml: string): string[] | null {
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const headerRows: string[][] = [];
  let trMatch: RegExpExecArray | null = trRegex.exec(theadHtml);

  while (trMatch) {
    if (/\b(?:rowspan|colspan)\s*=/i.test(trMatch[1])) {
      return null;
    }
    headerRows.push(parseRowCellTexts(trMatch[1]));
    trMatch = trRegex.exec(theadHtml);
  }

  if (headerRows.length === 0) return [];
  if (headerRows.length === 1) return headerRows[0];

  const maxLen = getMaxRowLength(headerRows);
  const merged: string[] = [];
  for (let i = 0; i < maxLen; i += 1) {
    let value = '';
    for (let rowIndex = headerRows.length - 1; rowIndex >= 0; rowIndex -= 1) {
      const candidate = (headerRows[rowIndex]?.[i] ?? '').trim();
      if (candidate.length > 0) {
        value = candidate;
        break;
      }
    }
    merged.push(value);
  }

  return merged;
}

function parseBodyRows(
  tbodyHtml: string,
  options?: { inferHeaderFromLeadingThRow?: boolean }
): {
  rows: string[][];
  indexColumns: number;
  unsupportedSpanLayout: boolean;
  inferredHeaders: string[] | null;
} {
  const inferHeaderFromLeadingThRow = options?.inferHeaderFromLeadingThRow ?? false;
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: string[][] = [];
  let indexColumns = 0;
  let indexColumnsDetected = false;
  let inferredHeaders: string[] | null = null;
  let trMatch: RegExpExecArray | null = trRegex.exec(tbodyHtml);

  while (trMatch) {
    const parsedCells = parseRowCells(trMatch[1]);
    if (parsedCells.some((cell) => cell.hasSpan)) {
      return { rows: [], indexColumns: 0, unsupportedSpanLayout: true, inferredHeaders: null };
    }

    if (parsedCells.length === 0) {
      trMatch = trRegex.exec(tbodyHtml);
      continue;
    }

    let leadingThCount = 0;
    let seenTd = false;
    const rowValues: string[] = [];
    for (const cell of parsedCells) {
      rowValues.push(cell.text);
      if (!seenTd && cell.tag === 'th') {
        leadingThCount += 1;
      } else if (cell.tag === 'td') {
        seenTd = true;
      }
    }

    const isImplicitHeaderCandidate =
      inferHeaderFromLeadingThRow && inferredHeaders === null && rows.length === 0 && !indexColumnsDetected && !seenTd;
    if (isImplicitHeaderCandidate) {
      inferredHeaders = rowValues;
      trMatch = trRegex.exec(tbodyHtml);
      continue;
    }

    if (!indexColumnsDetected) {
      indexColumns = leadingThCount;
      indexColumnsDetected = true;
    }

    rows.push(rowValues);
    trMatch = trRegex.exec(tbodyHtml);
  }

  return { rows, indexColumns, unsupportedSpanLayout: false, inferredHeaders };
}

function getTbodySections(tableInnerHtml: string): string[] {
  const sections: string[] = [];
  const tbodyRegex = /<tbody[^>]*>([\s\S]*?)<\/tbody>/gi;
  let tbodyMatch: RegExpExecArray | null = tbodyRegex.exec(tableInnerHtml);

  while (tbodyMatch) {
    sections.push(tbodyMatch[1]);
    tbodyMatch = tbodyRegex.exec(tableInnerHtml);
  }

  return sections;
}

function extractTableCaption(tableHtml: string): string | null {
  const captionMatch = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
  if (!captionMatch) return null;
  const captionText = stripHtmlTags(captionMatch[1]);
  return captionText || null;
}

function stripNonRenderedHtmlBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

function hasSignificantContentOutsidePrimaryTable(html: string, primaryTableHtml: string): boolean {
  const remaining = html.replace(primaryTableHtml, '');
  if (remaining.trim().length === 0) {
    return false;
  }

  const withoutNonRenderedBlocks = stripNonRenderedHtmlBlocks(remaining)
    // Pandas appends a <p>N rows × M columns</p> summary outside the table — not significant.
    .replace(/<p>\s*\d+\s+rows?\s*×\s*\d+\s+columns?\s*<\/p>/gi, '')
    .trim();

  if (withoutNonRenderedBlocks.length === 0) {
    return false;
  }

  // Preserve surrounding tables/media by keeping iframe rendering for mixed HTML payloads.
  if (/<table\b/i.test(withoutNonRenderedBlocks)) {
    return true;
  }
  if (/<(?:img|svg|canvas|video|audio|iframe|object|embed|picture|math)\b/i.test(withoutNonRenderedBlocks)) {
    return true;
  }

  return stripHtmlTags(withoutNonRenderedBlocks).length > 0;
}

function formatTableDimensions(rowCount: number, columnCount: number): string {
  const rowLabel = rowCount === 1 ? 'row' : 'rows';
  const columnLabel = columnCount === 1 ? 'column' : 'columns';
  return `${rowCount} ${rowLabel} × ${columnCount} ${columnLabel}`;
}

/**
 * Extract the total row count from a pandas dimension `<p>` tag like
 * `<p>3122 rows × 11 columns</p>` that appears outside the `<table>`.
 */
function extractPandasSourceRowCount(html: string): number | null {
  const match = html.match(/<p>\s*(\d+)\s+rows?\s*×\s*\d+\s+columns?\s*<\/p>/i);
  return match ? parseInt(match[1], 10) : null;
}

function getTableData(output: NotebookOutput): ParsedTable | null {
  const data = output.data ?? {};
  const html = toHtml(data['text/html']);
  if (!html) return null;
  const htmlWithoutNonRenderedBlocks = stripNonRenderedHtmlBlocks(html);

  if (!/<table[\s>]/i.test(htmlWithoutNonRenderedBlocks)) return null;
  if (!/<tr[\s>]/i.test(htmlWithoutNonRenderedBlocks)) return null;

  // Chart outputs are already handled via dedicated parsers.
  if (/vegaEmbed\s*\(/i.test(html)) return null;
  if (/(?:window\.)?Plotly\s*\.\s*(?:newPlot|react)\s*\(/i.test(html)) return null;

  // Keep pandas styler outputs in the iframe path so custom CSS still applies.
  if (/id=(["'])T_[^"']+\1/i.test(html)) return null;
  if (/class=(["'])[^"']*\bStyler\b[^"']*\1/i.test(html)) return null;

  const tableMatch = htmlWithoutNonRenderedBlocks.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return null;
  const tableHtml = tableMatch[0];
  const tableInnerHtml = tableMatch[1];
  if (hasSignificantContentOutsidePrimaryTable(html, tableHtml)) return null;
  if (!/<tr[\s>]/i.test(tableInnerHtml)) return null;

  // Multi-index headers (colspan/rowspan) are intentionally left to iframe for now.
  if (/\b(?:rowspan|colspan)\s*=/i.test(tableInnerHtml)) return null;

  const theadMatch = tableInnerHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  const flattenedHeaders = flattenHeaderRows(theadMatch?.[1] ?? '');
  if (flattenedHeaders === null) return null;

  const tbodySections = getTbodySections(tableInnerHtml);
  const bodySource = tbodySections.length > 0
    ? tbodySections.join('\n')
    : tableInnerHtml
        .replace(/<thead[^>]*>[\s\S]*?<\/thead>/gi, '')
        .replace(/<tfoot[^>]*>[\s\S]*?<\/tfoot>/gi, '')
        .replace(/<caption[^>]*>[\s\S]*?<\/caption>/gi, '');

  const body = parseBodyRows(bodySource, { inferHeaderFromLeadingThRow: !theadMatch });
  if (body.unsupportedSpanLayout || body.rows.length === 0) return null;

  const maxRowWidth = getMaxRowLength(body.rows);
  const resolvedHeaders = flattenedHeaders.length ? flattenedHeaders : (body.inferredHeaders ?? []);
  const columnCount = Math.max(resolvedHeaders.length, maxRowWidth);
  const headers = resolvedHeaders.length
    ? [...resolvedHeaders]
    : Array.from({ length: columnCount }, () => '');
  while (headers.length < columnCount) {
    headers.push('');
  }

  const sourceRowCount = extractPandasSourceRowCount(html);
  const dataColumns = Math.max(0, columnCount - body.indexColumns);
  const caption = extractTableCaption(tableHtml) ?? formatTableDimensions(body.rows.length, dataColumns);

  return {
    headers,
    rows: body.rows,
    indexColumns: body.indexColumns,
    caption,
    sourceRowCount,
  };
}

function getHtmlOutputDocument(output: NotebookOutput): string | null {
  const data = output.data ?? {};
  const html = toHtml(data['text/html']);
  if (!html) return null;
  return buildHtmlDocument(html);
}

function getVegaLiteSpec(output: NotebookOutput): Record<string, unknown> | null {
  const data = output.data ?? {};
  const directVegaLite = getRecordFromMimeData(data, /^application\/vnd\.vegalite\.v\d+\+json$/i);
  if (directVegaLite) {
    return directVegaLite;
  }

  const directVega = getRecordFromMimeData(data, /^application\/vnd\.vega\.v\d+\+json$/i);
  if (directVega) {
    return directVega;
  }

  const html = toHtml(data['text/html']);
  if (html) {
    const extracted = getVegaSpecFromHtml(html);
    if (extracted) return extracted;
  }

  return null;
}

export function getOutputText(output: NotebookOutput): string {
  if (output.output_type === 'stream') {
    return toText(output.text);
  }

  if (output.output_type === 'error') {
    const trace = Array.isArray(output.traceback) ? output.traceback.join('\n') : '';
    const errorLine = [output.ename, output.evalue].filter(Boolean).join(': ');
    return [errorLine, trace].filter(Boolean).join('\n');
  }

  const data = output.data ?? {};
  if (typeof data['text/plain'] !== 'undefined') {
    return toText(data['text/plain']);
  }
  if (typeof data['application/json'] !== 'undefined') {
    return toText(data['application/json']);
  }

  return '';
}

function getImageDataUrl(output: NotebookOutput): string | null {
  const data = output.data ?? {};
  const png = data['image/png'];
  const jpeg = data['image/jpeg'];
  const svg = data['image/svg+xml'];

  if (typeof png === 'string' && png.length > 0) {
    return `data:image/png;base64,${png}`;
  }
  if (typeof jpeg === 'string' && jpeg.length > 0) {
    return `data:image/jpeg;base64,${jpeg}`;
  }
  if (typeof svg === 'string' && svg.length > 0) {
    const trimmed = svg.trim();
    if (trimmed.startsWith('<')) {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }
    return `data:image/svg+xml;base64,${svg}`;
  }

  return null;
}

export function getOutputRender(output: NotebookOutput): NotebookOutputRender {
  const vegaLiteSpec = getVegaLiteSpec(output);
  if (vegaLiteSpec) {
    return { kind: 'vegalite', spec: vegaLiteSpec };
  }

  const plotlyPayload = getPlotlyPayload(output);
  if (plotlyPayload) {
    return { kind: 'plotly', payload: plotlyPayload };
  }

  const tableData = getTableData(output);
  if (tableData) {
    return { kind: 'table', table: tableData };
  }

  const htmlOutput = getHtmlOutputDocument(output);
  if (htmlOutput) {
    return { kind: 'html', html: htmlOutput };
  }

  const imageOutput = getImageDataUrl(output);
  if (imageOutput) {
    return { kind: 'image', src: imageOutput };
  }

  const textOutput = getOutputText(output);
  if (textOutput) {
    return { kind: 'text', text: textOutput };
  }

  return { kind: 'unsupported' };
}

export function formatExecutionTime(startIso?: string, endIso?: string): string | null {
  if (!startIso || !endIso) return null;

  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const ms = end - start;
  if (Number.isNaN(ms) || ms < 0) return null;

  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .trim();
}

export function formatNotebookDate(date: Date): string {
  return (
    date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }) +
    '  ·  ' +
    date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  );
}

export function hasVisualOutput(outputs: NotebookOutput[]): boolean {
  return outputs.some((output) => {
    const data = output.data ?? {};
    const mimeTypes = Object.keys(data);
    const hasVegaMime = mimeTypes.some((mimeType) =>
      /^application\/vnd\.vega(?:lite)?\.v\d+\+json$/i.test(mimeType)
    );
    const hasPlotlyMime = mimeTypes.some((mimeType) =>
      /^application\/vnd\.plotly\.v\d+\+json$/i.test(mimeType)
    );

    return (
      hasVegaMime ||
      hasPlotlyMime ||
      'image/png' in data ||
      'image/jpeg' in data ||
      'image/svg+xml' in data ||
      'text/html' in data
    );
  });
}

interface MarkdownFenceState {
  marker: '`' | '~';
  length: number;
}

function getMarkdownFenceState(line: string): MarkdownFenceState | null {
  const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
  if (!fenceMatch) {
    return null;
  }

  const marker = fenceMatch[1][0] as '`' | '~';
  return { marker, length: fenceMatch[1].length };
}

function isFenceClose(line: string, fence: MarkdownFenceState): boolean {
  const closeMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
  if (!closeMatch) {
    return false;
  }

  const marker = closeMatch[1][0] as '`' | '~';
  return marker === fence.marker && closeMatch[1].length >= fence.length;
}

export function extractTocEntries(
  cells: NotebookCell[],
  _titleCellIndex: number | null
): TocEntry[] {
  const entries: TocEntry[] = [];
  let counter = 0;

  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell.cell_type !== 'markdown') continue;

    const lines = toText(cell.source).split('\n');
    let activeFence: MarkdownFenceState | null = null;
    for (const rawLine of lines) {
      const fenceState = getMarkdownFenceState(rawLine);
      if (activeFence) {
        if (fenceState && isFenceClose(rawLine, activeFence)) {
          activeFence = null;
        }
        continue;
      }

      if (fenceState) {
        activeFence = fenceState;
        continue;
      }

      const line = rawLine.trim();
      const h2Match = line.match(/^##\s+(.+)/);
      const h3Match = line.match(/^###\s+(.+)/);

      if (h2Match) {
        entries.push({
          id: `toc-${counter}`,
          text: stripMarkdownFormatting(h2Match[1]),
          level: 2,
          cellIndex: i,
        });
        counter += 1;
      } else if (h3Match) {
        entries.push({
          id: `toc-${counter}`,
          text: stripMarkdownFormatting(h3Match[1]),
          level: 3,
          cellIndex: i,
        });
        counter += 1;
      }
    }
  }

  return entries;
}
