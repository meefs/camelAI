"use client";

import type { ReactNode } from 'react';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import { cn } from '@/lib/utils';
import type { PreviewTarget } from '@/types';

interface AppLinkProps {
  scriptName: string;
  isPublic: boolean;
  children?: ReactNode;
  className?: string;
}

export function AppLink({ scriptName, isPublic, children, className }: AppLinkProps) {
  const previewContext = useChatPreviewContext();

  if (!previewContext) {
    return (
      <span className={cn('inline-flex min-w-0 max-w-full', className)}>
        {children ?? scriptName}
      </span>
    );
  }

  const target: PreviewTarget = { kind: 'app', scriptName, isPublic };

  return (
    <button
      type="button"
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1 hover:underline',
        'text-foreground/80 hover:text-foreground',
        className
      )}
      onClick={(event) => {
        event.stopPropagation();
        previewContext.openPreviewTarget(target);
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
    >
      {children ?? scriptName}
    </button>
  );
}
