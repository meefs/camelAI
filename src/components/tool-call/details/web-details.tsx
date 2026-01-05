"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';

interface WebDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  mode: 'fetch' | 'search';
}

export function WebDetails({ tool, result, mode }: WebDetailsProps) {
  const input = tool?.input ?? {};
  const url = typeof input.url === 'string' ? input.url : '';
  const query = typeof input.query === 'string' ? input.query : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const resultText = getResultText(result);

  return (
    <div className="space-y-1">
      {mode === 'fetch' ? (
        <DetailRow label="URL:" value={url} copyValue={url} mono />
      ) : (
        <DetailRow label="Query:" value={query} copyValue={query} />
      )}
      {prompt ? <DetailRow label="Prompt:" value={prompt} copyValue={prompt} /> : null}
      <OutputBlock value={resultText} label="Response" copyValue={resultText} />
    </div>
  );
}
