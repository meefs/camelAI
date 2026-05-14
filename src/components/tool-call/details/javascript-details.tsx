"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';

interface JavaScriptDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

type TablePreview = {
  columns: string[];
  rows: Record<string, unknown>[];
};

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function parseTablePreview(output: string): TablePreview | null {
  if (!output.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: unknown[] }).data
      : null;
  if (!rows || rows.length === 0 || !rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    return null;
  }

  const columns = Array.from(new Set(
    rows.flatMap((row) => Object.keys(row as Record<string, unknown>))
  )).filter((column) => rows.some((row) => isScalar((row as Record<string, unknown>)[column]))).slice(0, 6);
  if (columns.length === 0) return null;

  return {
    columns,
    rows: rows.slice(0, 10) as Record<string, unknown>[],
  };
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (isScalar(value)) return String(value);
  return JSON.stringify(value);
}

function ResultTablePreview({ preview }: { preview: TablePreview }) {
  return (
    <div className="mt-2 overflow-auto rounded border border-border/60">
      <table className="w-full min-w-max text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            {preview.columns.map((column) => (
              <th key={column} className="px-2 py-1.5 text-left font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, index) => (
            <tr key={index} className="border-t border-border/50">
              {preview.columns.map((column) => (
                <td key={column} className="max-w-52 truncate px-2 py-1.5 text-muted-foreground">
                  {formatCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JavaScriptDetails({ tool, result }: JavaScriptDetailsProps) {
  const input = tool?.input ?? {};
  const code = typeof input.code === 'string' ? input.code : '';
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined;
  const maxOutputCharacters =
    typeof input.maxOutputCharacters === 'number' ? input.maxOutputCharacters : undefined;
  const output = getResultText(result);
  const tablePreview = parseTablePreview(output);

  return (
    <div className="space-y-1">
      <DetailRow label="Runtime:" value="JavaScript code mode" />
      {timeoutMs !== undefined ? <DetailRow label="Timeout:" value={`${timeoutMs}ms`} /> : null}
      {maxOutputCharacters !== undefined ? (
        <DetailRow label="Output limit:" value={`${maxOutputCharacters} chars`} />
      ) : null}
      <OutputBlock value={code} label="Code" copyValue={code} />
      {tablePreview ? <ResultTablePreview preview={tablePreview} /> : null}
      <OutputBlock value={output} label="Output" copyValue={output} />
      {!code && !output ? <DetailRow label="Details:" value="No additional data" /> : null}
    </div>
  );
}
