"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';

interface BashDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

type BashParsedResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

function parseBashResult(resultText: string): BashParsedResult {
  const trimmed = resultText.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      exitCode: typeof parsed.exit_code === 'number'
        ? parsed.exit_code
        : typeof parsed.exitCode === 'number'
          ? parsed.exitCode
          : undefined,
      stdout: typeof parsed.stdout === 'string' ? parsed.stdout : undefined,
      stderr: typeof parsed.stderr === 'string' ? parsed.stderr : undefined,
    };
  } catch {
    return {};
  }
}

export function BashDetails({ tool, result }: BashDetailsProps) {
  const input = tool?.input ?? {};
  const command = typeof input.command === 'string' ? input.command : '';
  const description = typeof input.description === 'string' ? input.description : '';
  const resultText = getResultText(result);
  const parsed = parseBashResult(resultText);
  const exitCode = parsed.exitCode;

  return (
    <div className="space-y-1">
      <DetailRow label="Command:" value={command} copyValue={command} mono />
      {description ? <DetailRow label="Description:" value={description} /> : null}
      {exitCode !== undefined ? <DetailRow label="Exit code:" value={String(exitCode)} /> : null}
      {parsed.stdout ? (
        <OutputBlock value={parsed.stdout} label="Stdout" copyValue={parsed.stdout} />
      ) : null}
      {parsed.stderr ? (
        <OutputBlock value={parsed.stderr} label="Stderr" copyValue={parsed.stderr} />
      ) : null}
      {!parsed.stdout && !parsed.stderr ? (
        <OutputBlock value={resultText} label="Output" copyValue={resultText} />
      ) : null}
    </div>
  );
}
