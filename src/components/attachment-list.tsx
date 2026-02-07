'use client';

import { X, File, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';

export interface Attachment {
  id: string;
  name: string;
  path: string;
  size: number;
  contentType?: string;
  originalName?: string;
  progress?: number;
  status: 'uploading' | 'complete' | 'error';
  error?: string;
}

interface AttachmentListProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  className?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentList({ attachments, onRemove, className }: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap gap-2 px-3 pb-2', className)}>
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={cn(
            'flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm',
            attachment.status === 'error'
              ? 'border-destructive/50 bg-destructive/10 text-destructive'
              : 'border-border bg-muted/50'
          )}
        >
          {attachment.status === 'uploading' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : attachment.status === 'error' ? (
            <AlertCircle className="h-3.5 w-3.5" />
          ) : (
            <File className="h-3.5 w-3.5 text-muted-foreground" />
          )}

          <div className="min-w-0">
            <span className="block max-w-[160px] truncate">
              {attachment.name}
            </span>

            {attachment.status === 'uploading' && (
              <div className="mt-1 flex items-center gap-2">
                <Progress
                  value={attachment.progress ?? 0}
                  className="h-1 w-24"
                />
                <span className="text-xs text-muted-foreground tabular-nums">
                  {Math.max(0, Math.min(100, Math.round(attachment.progress ?? 0)))}%
                </span>
              </div>
            )}
          </div>

          {attachment.status === 'complete' && (
            <span className="text-xs text-muted-foreground">
              ({formatFileSize(attachment.size)})
            </span>
          )}

          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className={cn(
              'ml-1 rounded p-0.5 hover:bg-accent',
              attachment.status === 'error' && 'hover:bg-destructive/20'
            )}
            aria-label={`Remove ${attachment.name}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
