import type {
  NotebookCell,
  NotebookOutput,
  NotebookOutputRender,
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

function getVegaSpecFromHtml(html: string): Record<string, unknown> | null {
  if (!/vegaEmbed\s*\(/.test(html)) return null;

  const scriptBlocks = extractScriptBlocks(html);
  const sources = scriptBlocks.length > 0 ? scriptBlocks : [html];

  for (const source of sources) {
    if (!/vegaEmbed\s*\(/.test(source)) continue;

    const invocationRegex = /\}\)\s*\(/g;
    let match: RegExpExecArray | null = invocationRegex.exec(source);

    while (match) {
      const openParenIndex = source.indexOf('(', match.index);
      if (openParenIndex === -1) {
        match = invocationRegex.exec(source);
        continue;
      }

      const args = splitCallArguments(source, openParenIndex);
      if (!args || args.length < 1) {
        match = invocationRegex.exec(source);
        continue;
      }

      const specValue = resolveJsArgValue(args[0], source);
      const spec = toRecord(specValue);
      if (!spec) {
        match = invocationRegex.exec(source);
        continue;
      }

      const embedOpt =
        args.length > 1 ? toRecord(resolveJsArgValue(args[1], source)) : null;
      const mode = typeof embedOpt?.mode === 'string' ? embedOpt.mode : '';
      const schema = typeof spec.$schema === 'string' ? spec.$schema : '';
      const looksLikeVegaSpec = /\/schema\/vega(?:-lite)?\//i.test(schema);
      const looksLikeVegaMode = mode === 'vega-lite' || mode === 'vega';

      if (looksLikeVegaSpec || looksLikeVegaMode) {
        return spec;
      }

      match = invocationRegex.exec(source);
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
    for (const rawLine of lines) {
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
