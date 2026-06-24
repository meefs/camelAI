'use client';

import type { CondensedTranscript } from '@/types';
import { parseUploadRefs } from '@/components/chat-file-preview/parse-uploads';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { Skeleton } from '@/components/ui/skeleton';
import {
  buildUserUploadReference,
  isUserUploadMountPath,
} from '@/lib/chat-attachment-refs';
import { cn } from '@/lib/utils';

export type TranscriptPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; transcript: CondensedTranscript }
  | { status: 'error'; error: string };

function RoleLabel({ children }: { children: string }) {
  return (
    <p className="text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

function LoadingPreview() {
  return (
    <div className="space-y-3 py-3">
      <div className="space-y-3 px-3">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <div className="space-y-3 bg-muted/50 px-3 py-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

function UserTurnText({ content }: { content: string }) {
  const parsed = parseUploadRefs(content);
  return (
    <div className="space-y-1.5">
      {parsed.cleanContent ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-popover-foreground">
          {parsed.cleanContent}
        </p>
      ) : null}
      {parsed.refs.map((ref) => (
        <p
          key={`${ref.mountPath}:${ref.originalText}`}
          className="text-xs italic text-muted-foreground"
        >
          {isUserUploadMountPath(ref.mountPath)
            ? buildUserUploadReference(ref.mountPath)
            : ref.originalText}
        </p>
      ))}
    </div>
  );
}

export function TranscriptHoverPreview({
  state,
  className,
}: {
  state: TranscriptPreviewState;
  className?: string;
}) {
  return (
    <div className={cn('max-h-[360px] overflow-y-auto overflow-x-hidden', className)}>
      {state.status === 'idle' || state.status === 'loading' ? (
        <LoadingPreview />
      ) : state.status === 'error' ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">{state.error}</p>
      ) : state.transcript.turns.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">
          No completed turns yet.
        </p>
      ) : (
        <div className="space-y-4 py-3">
          {state.transcript.turns.map((turn, index) => (
            <div key={index} className="space-y-2">
              <div className="space-y-1.5 px-3">
                <RoleLabel>User</RoleLabel>
                <UserTurnText content={turn.user} />
              </div>
              <div className="space-y-1.5 bg-muted/50 px-3 py-3">
                <RoleLabel>Assistant</RoleLabel>
                {turn.omittedCount > 0 ? (
                  <p className="text-xs italic text-muted-foreground">
                    [{turn.omittedCount} messages omitted]
                  </p>
                ) : null}
                <MarkdownRenderer
                  content={turn.assistantFinal}
                  variant="default"
                  className="text-sm"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
