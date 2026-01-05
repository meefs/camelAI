"use client";

import type { ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { formatBytes, getPreviewLines, safeJsonStringify } from '../tool-utils';

interface WriteDetailsProps {
  tool?: ToolUseBlock;
}

export function WriteDetails({ tool }: WriteDetailsProps) {
  const input = tool?.input ?? {};
  const path =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.path === 'string' && input.path) ||
    '';
  const rawContent = input.content;
  const content = typeof rawContent === 'string' ? rawContent : safeJsonStringify(rawContent);
  const size = typeof rawContent === 'string' ? formatBytes(rawContent.length) : '';
  const { preview } = getPreviewLines(content, 10);

  return (
    <div className="space-y-1">
      <DetailRow label="Path:" value={path} copyValue={path} mono asFileLink />
      {size ? <DetailRow label="Size:" value={size} /> : null}
      <OutputBlock value={preview} label="Preview" copyValue={content} />
    </div>
  );
}
