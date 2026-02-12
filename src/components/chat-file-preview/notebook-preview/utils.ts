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

function buildPlotlyHtmlDocument(payload: unknown): string {
  const serializedPayload = JSON.stringify(payload ?? {}).replace(/</g, '\\u003c');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; }
      #plotly-root { width: 100%; min-height: 320px; height: 100%; }
      .plotly-error { padding: 12px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; color: #b91c1c; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  </head>
  <body>
    <div id="plotly-root"></div>
    <script>
      try {
        const payload = ${serializedPayload};
        const figure = payload?.data ? payload : (payload?.figure ?? {});
        const traces = Array.isArray(figure?.data) ? figure.data : [];
        const layout = typeof figure?.layout === 'object' && figure.layout ? figure.layout : {};
        const config = typeof payload?.config === 'object' && payload.config ? payload.config : { responsive: true };
        Plotly.newPlot('plotly-root', traces, layout, config);
      } catch (error) {
        const el = document.createElement('pre');
        el.className = 'plotly-error';
        el.textContent = 'Failed to render Plotly output: ' + (error?.message || String(error));
        document.body.appendChild(el);
      }
    </script>
  </body>
</html>`;
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

function getHtmlOutputDocument(output: NotebookOutput): string | null {
  const data = output.data ?? {};
  const plotly = data['application/vnd.plotly.v1+json'];
  if (typeof plotly !== 'undefined') {
    return buildPlotlyHtmlDocument(plotly);
  }

  const html = toHtml(data['text/html']);
  if (!html) return null;
  return buildHtmlDocument(html);
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
    return (
      'application/vnd.plotly.v1+json' in data ||
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
