"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock, ProjectDetailRow } from './shared';
import { getResultText, safeJsonStringify } from '../tool-utils';

interface GenericDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  showProject?: boolean;
}

export function GenericDetails({ tool, result, showProject = true }: GenericDetailsProps) {
  const inputText = tool?.input ? safeJsonStringify(tool.input) : '';
  const resultText = getResultText(result);

  return (
    <div className="space-y-1">
      {showProject ? <ProjectDetailRow input={tool?.input} /> : null}
      {inputText ? <OutputBlock value={inputText} label="Input" copyValue={inputText} /> : null}
      {resultText ? <OutputBlock value={resultText} label="Output" copyValue={resultText} /> : null}
      {!inputText && !resultText ? <DetailRow label="Details:" value="No additional data" /> : null}
    </div>
  );
}
