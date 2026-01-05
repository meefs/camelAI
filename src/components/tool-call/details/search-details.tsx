"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';

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

export function SearchDetails({ tool, result, mode }: SearchDetailsProps) {
  const input = tool?.input ?? {};
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const path = typeof input.path === 'string' ? input.path : '';
  const outputMode = typeof input.output_mode === 'string' ? input.output_mode : '';
  const resultText = getResultText(result);
  const count = parseCount(resultText);
  const lines = extractResultLines(resultText);

  return (
    <div className="space-y-1">
      <DetailRow label="Pattern:" value={pattern} copyValue={pattern} mono />
      <DetailRow label="Path:" value={path} copyValue={path} mono />
      {outputMode ? <DetailRow label="Mode:" value={outputMode} /> : null}
      {count !== null ? <DetailRow label="Count:" value={String(count)} /> : null}
      <OutputBlock
        value={lines}
        label={mode === 'glob' ? 'Files' : 'Matches'}
        copyValue={lines}
      />
    </div>
  );
}
