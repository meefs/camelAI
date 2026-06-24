'use client';

import { MessageSquare, Plus } from 'lucide-react';
import type { GroupNewChatTranscriptCard } from '@/types';
import { Badge } from '@/components/ui/badge';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import {
  TranscriptHoverPreview,
  type TranscriptPreviewState,
} from './transcript-hover-preview';

interface TranscriptCardProps {
  transcript: GroupNewChatTranscriptCard;
  previewState: TranscriptPreviewState;
  isInserting?: boolean;
  onPreviewRequest: (transcript: GroupNewChatTranscriptCard) => void;
  onInsert: (transcript: GroupNewChatTranscriptCard) => void;
}

export function TranscriptCard({
  transcript,
  previewState,
  isInserting = false,
  onPreviewRequest,
  onInsert,
}: TranscriptCardProps) {
  return (
    <HoverCard
      openDelay={200}
      closeDelay={100}
      onOpenChange={(open) => {
        if (open) onPreviewRequest(transcript);
      }}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={() => onInsert(transcript)}
          disabled={isInserting}
          aria-label={`Add transcript: ${transcript.title}`}
          className={cn(
            'group relative flex w-[200px] shrink-0 cursor-pointer flex-col gap-2 rounded-xl p-4 text-left',
            'border border-border bg-card transition-all duration-200 ease-out',
            'hover:border-ring hover:shadow-md',
            'disabled:pointer-events-none disabled:opacity-60',
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <Badge variant="outline" className="uppercase">
              Chat
            </Badge>
            <span className="text-muted-foreground" aria-hidden>
              <MessageSquare className="size-4 group-hover:hidden" />
              <Plus className="hidden size-4 group-hover:block" />
            </span>
          </div>
          <p className="min-w-0 truncate text-sm font-medium text-foreground">
            {transcript.title}
          </p>
          <p className="line-clamp-1 text-xs leading-relaxed text-muted-foreground">
            {transcript.openingLine}
          </p>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        collisionPadding={12}
        className="w-80 overflow-hidden p-0"
      >
        <TranscriptHoverPreview state={previewState} />
      </HoverCardContent>
    </HoverCard>
  );
}
