"use client";

import type { ToolUseBlock } from '@/types';
import { buildFilePreviewLinkTarget } from '@/lib/file-preview-target';
import { DetailRow, OutputBlock } from './shared';
import { getPreviewLines, safeJsonStringify } from '../tool-utils';

interface NotebookDetailsProps {
  tool?: ToolUseBlock;
}

export function NotebookDetails({ tool }: NotebookDetailsProps) {
  const input = tool?.input ?? {};
  const path = typeof input.path === 'string' ? input.path : '';
  const filePreview = buildFilePreviewLinkTarget({
    path,
    location: input.location,
    project: input.project,
    contentType: input.contentType,
    content_type: input.content_type,
  });
  const cellId = typeof input.cell_id === 'string' ? input.cell_id : '';
  const contentValue =
    typeof input.content === 'string'
      ? input.content
      : typeof input.new_content === 'string'
        ? input.new_content
        : safeJsonStringify(input.content ?? input.new_content);
  const { preview } = getPreviewLines(contentValue, 10);

  return (
    <div className="space-y-1">
      <DetailRow
        label="Notebook:"
        value={path}
        copyValue={path}
        mono
        asFileLink
        filePreview={filePreview}
      />
      {cellId ? <DetailRow label="Cell:" value={cellId} copyValue={cellId} mono /> : null}
      <OutputBlock value={preview} label="Content" copyValue={contentValue} />
    </div>
  );
}
