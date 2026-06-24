"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { buildFilePreviewLinkTarget } from '@/lib/file-preview-target';
import { DetailRow, OutputBlock } from './shared';
import { copyTargetFromToolInput } from './file-copy';
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
  const filePreview = buildFilePreviewLinkTarget({
    path,
    location: input.location,
    project: input.project,
    contentType: input.contentType,
    content_type: input.content_type,
  });
  const resultText = getResultText(result);
  const lineCount = resultText ? resultText.split(/\r?\n/).length : 0;
  const { preview } = getPreviewLines(resultText, 10);

  return (
    <div className="space-y-1">
      <DetailRow
        label="Path:"
        value={path}
        copyFileTarget={copyTargetFromToolInput(input, path)}
        mono
        asFileLink
        filePreview={filePreview}
      />
      <DetailRow label="Lines:" value={lineCount ? String(lineCount) : '0'} />
      <OutputBlock value={preview} label="Preview" copyValue={resultText} />
    </div>
  );
}
