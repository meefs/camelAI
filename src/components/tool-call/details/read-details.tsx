"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getPreviewLines, getResultText } from '../tool-utils';

interface ReadDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

export function ReadDetails({ tool, result }: ReadDetailsProps) {
  const input = tool?.input ?? {};
  const path =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.path === 'string' && input.path) ||
    '';
  const resultText = getResultText(result);
  const lineCount = resultText ? resultText.split(/\r?\n/).length : 0;
  const { preview } = getPreviewLines(resultText, 10);

  return (
    <div className="space-y-1">
      <DetailRow label="Path:" value={path} copyValue={path} mono asFileLink />
      <DetailRow label="Lines:" value={lineCount ? String(lineCount) : '0'} />
      <OutputBlock value={preview} label="Preview" copyValue={resultText} />
    </div>
  );
}
