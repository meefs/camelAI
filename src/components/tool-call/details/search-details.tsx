"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { CopyButton, DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';
import { FileLink } from '../file-link';

interface SearchDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  mode: 'glob' | 'grep';
}

function parseCount(resultText: string): number | null {
  const match = resultText.match(/Found\s+(\d+)\s+(files|matches)/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function extractResultLines(resultText: string): string {
  const lines = resultText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const filtered = lines.filter(line => !/^found\s+\d+/i.test(line) && !/^results are truncated/i.test(line));
  return filtered.length > 0 ? filtered.join('\n') : resultText;
}

type ParsedLine = {
  path: string;
  suffix: string;
  raw: string;
};

function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const colonIndex = trimmed.indexOf(':');
  const base = colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
  if (
    base.startsWith('/') ||
    base.startsWith('./') ||
    base.startsWith('../') ||
    base.includes('/')
  ) {
    return {
      path: base,
      suffix: colonIndex >= 0 ? trimmed.slice(colonIndex) : '',
      raw: trimmed,
    };
  }
  return null;
}

export function SearchDetails({ tool, result, mode }: SearchDetailsProps) {
  const input = tool?.input ?? {};
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const path = typeof input.path === 'string' ? input.path : '';
  const outputMode = typeof input.output_mode === 'string' ? input.output_mode : '';
  const resultText = getResultText(result);
  const count = parseCount(resultText);
  const lines = extractResultLines(resultText);
  const fileLines = lines.split(/\r?\n/).filter(Boolean);
  const parsedLines = fileLines
    .map(line => parseLine(line))
    .filter((entry): entry is ParsedLine => Boolean(entry));
  const copyValue = parsedLines.some(entry => entry.suffix)
    ? parsedLines.map(entry => entry.raw).join('\n')
    : parsedLines.map(entry => entry.path).join('\n');

  return (
    <div className="space-y-1">
      <DetailRow label="Pattern:" value={pattern} copyValue={pattern} mono />
      <DetailRow label="Path:" value={path} copyValue={path} mono asFileLink />
      {outputMode ? <DetailRow label="Mode:" value={outputMode} /> : null}
      {count !== null ? <DetailRow label="Count:" value={String(count)} /> : null}
      {parsedLines.length > 0 ? (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground/60 mb-1 group/filelist">
            <span>{mode === 'glob' ? 'Files' : 'Matches'}</span>
            <CopyButton
              value={copyValue}
              label="Copy list"
              hoverClassName="group-hover/details:opacity-100"
            />
          </div>
          <div className="bg-muted/30 rounded p-2 max-h-32 overflow-auto text-xs">
            {parsedLines.map((entry, index) => (
              <div key={`${entry.path}-${index}`} className="flex items-start gap-1">
                <FileLink
                  path={entry.path}
                  mono
                  className="truncate text-muted-foreground/80"
                >
                  {entry.path}
                </FileLink>
                {entry.suffix ? (
                  <span className="text-muted-foreground/60 whitespace-pre-wrap">
                    {entry.suffix}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <OutputBlock
          value={lines}
          label={mode === 'glob' ? 'Files' : 'Matches'}
          copyValue={lines}
        />
      )}
    </div>
  );
}
