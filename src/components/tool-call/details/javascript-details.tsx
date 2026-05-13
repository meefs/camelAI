"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';

interface JavaScriptDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

export function JavaScriptDetails({ tool, result }: JavaScriptDetailsProps) {
  const input = tool?.input ?? {};
  const code = typeof input.code === 'string' ? input.code : '';
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined;
  const maxOutputCharacters =
    typeof input.maxOutputCharacters === 'number' ? input.maxOutputCharacters : undefined;
  const output = getResultText(result);

  return (
    <div className="space-y-1">
      <DetailRow label="Runtime:" value="JavaScript code mode" />
      {timeoutMs !== undefined ? <DetailRow label="Timeout:" value={`${timeoutMs}ms`} /> : null}
      {maxOutputCharacters !== undefined ? (
        <DetailRow label="Output limit:" value={`${maxOutputCharacters} chars`} />
      ) : null}
      <OutputBlock value={code} label="Code" copyValue={code} />
      <OutputBlock value={output} label="Output" copyValue={output} />
      {!code && !output ? <DetailRow label="Details:" value="No additional data" /> : null}
    </div>
  );
}
