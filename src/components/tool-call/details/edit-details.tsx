"use client";

import type { ToolUseBlock } from '@/types';
import { cn } from '@/lib/utils';
import { DetailRow } from './shared';

interface EditDetailsProps {
  tool?: ToolUseBlock;
}

type EditEntry = {
  old_string?: string;
  new_string?: string;
};

type DiffLine = {
  type: 'add' | 'remove' | 'context';
  text: string;
};

function buildDiffLines(edit: EditEntry, maxLines = 6): DiffLine[] {
  const lines: DiffLine[] = [];
  const oldText = typeof edit.old_string === 'string' ? edit.old_string : '';
  const newText = typeof edit.new_string === 'string' ? edit.new_string : '';

  const oldLines = oldText ? oldText.split(/\r?\n/) : [];
  const newLines = newText ? newText.split(/\r?\n/) : [];

  const trimmedOld = oldLines.slice(0, maxLines);
  const trimmedNew = newLines.slice(0, maxLines);

  trimmedOld.forEach(line => lines.push({ type: 'remove', text: line }));
  if (oldLines.length > maxLines) lines.push({ type: 'context', text: '...' });
  trimmedNew.forEach(line => lines.push({ type: 'add', text: line }));
  if (newLines.length > maxLines) lines.push({ type: 'context', text: '...' });

  return lines;
}

export function EditDetails({ tool }: EditDetailsProps) {
  const input = tool?.input ?? {};
  const path =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.path === 'string' && input.path) ||
    '';
  const edits: EditEntry[] = Array.isArray(input.edits)
    ? (input.edits as EditEntry[])
    : [
        {
          old_string: typeof input.old_string === 'string' ? input.old_string : undefined,
          new_string: typeof input.new_string === 'string' ? input.new_string : undefined,
        },
      ];

  const replacementCount = edits.filter(edit => edit.old_string || edit.new_string).length;
  const diffLines = edits.flatMap(edit => buildDiffLines(edit));

  return (
    <div className="space-y-1">
      <DetailRow label="Path:" value={path} copyValue={path} mono asFileLink />
      <DetailRow label="Changes:" value={replacementCount ? `${replacementCount} replacements` : '0'} />
      {diffLines.length > 0 ? (
        <div className="mt-2 font-mono text-xs bg-muted/30 rounded p-2 max-h-32 overflow-auto">
          <div className="space-y-0.5 font-mono text-xs">
            {diffLines.map((line, index) => (
              <div
                key={`${line.type}-${index}`}
                className={cn(
                  "whitespace-pre-wrap",
                  line.type === 'add' && "text-green-600/80 dark:text-green-400/80",
                  line.type === 'remove' && "text-red-600/80 dark:text-red-400/80",
                  line.type === 'context' && "text-muted-foreground/60"
                )}
              >
                {line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : ''}{line.text}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <DetailRow label="Diff:" value="No diff available" />
      )}
    </div>
  );
}
