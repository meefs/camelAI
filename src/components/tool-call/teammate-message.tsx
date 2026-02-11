"use client";

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { DetailRow } from './details/shared';

interface TeammateMessageProps {
  teammateId: string;
  content: string;
}

function getMessagePreview(content: string): string {
  const firstLine = content.split(/\r?\n/).find(line => line.trim()) ?? '';
  const trimmed = firstLine.trim();
  const max = 72;
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

export function TeammateMessage({ teammateId, content }: TeammateMessageProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [messageExpanded, setMessageExpanded] = useState(false);
  const preview = getMessagePreview(content);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "tool-call group/toolcall flex w-full items-center gap-2 py-1 text-sm text-muted-foreground",
            "hover:bg-muted/30 rounded px-2 -mx-2 cursor-pointer text-left",
            "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          )}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setIsExpanded(prev => !prev);
            }
          }}
        >
          <span className="tool-call__dot w-1.5 h-1.5 rounded-full shrink-0 bg-green-500" />
          <span className="tool-call__text min-w-0 flex-1 truncate">
            Received update from {teammateId}
          </span>
          <ChevronRight
            className={cn(
              "tool-call__chevron h-4 w-4 text-muted-foreground/50 opacity-0 transition-all duration-150",
              "group-hover/toolcall:opacity-100",
              isExpanded && "opacity-100 rotate-90"
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "group/details overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
          "motion-reduce:animate-none"
        )}
      >
        <div className="pl-4 mt-1 text-xs text-muted-foreground/80 border-l border-border/50 ml-1">
          <div className="space-y-2">
            <DetailRow label="Agent:" value={teammateId} />
            <Collapsible open={messageExpanded} onOpenChange={setMessageExpanded}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group/result flex w-full items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/30"
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 text-muted-foreground/60 transition-transform",
                      messageExpanded && "rotate-90"
                    )}
                  />
                  <span className="shrink-0">Message</span>
                  {!messageExpanded && preview ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
                      {preview}
                    </span>
                  ) : null}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pl-6 pt-1">
                <div className="rounded bg-muted/30 p-2">
                  <MarkdownRenderer content={content} />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
