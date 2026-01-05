"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';

interface TaskDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

export function TaskDetails({ tool, result }: TaskDetailsProps) {
  const input = tool?.input ?? {};
  const description = typeof input.description === 'string' ? input.description : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const agent = typeof input.agent === 'string' ? input.agent : '';
  const model = typeof input.model === 'string' ? input.model : '';
  const resultText = getResultText(result);

  return (
    <div className="space-y-1">
      {agent ? <DetailRow label="Agent:" value={agent} /> : null}
      {model ? <DetailRow label="Model:" value={model} /> : null}
      {description ? <DetailRow label="Description:" value={description} /> : null}
      {prompt ? <DetailRow label="Prompt:" value={prompt} copyValue={prompt} /> : null}
      <OutputBlock value={resultText} label="Result" copyValue={resultText} />
    </div>
  );
}
