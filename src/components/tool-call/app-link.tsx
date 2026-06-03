"use client";

import type { ReactNode } from 'react';
import { useState } from 'react';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import { cn } from '@/lib/utils';
import type { PreviewTarget } from '@/types';

interface AppLinkProps {
  scriptName: string;
  isPublic?: boolean;
  children?: ReactNode;
  className?: string;
}

export function AppLink({ scriptName, isPublic, children, className }: AppLinkProps) {
  const previewContext = useChatPreviewContext();
  const [isResolving, setIsResolving] = useState(false);

  if (!previewContext) {
    return (
      <span className={cn('inline-flex min-w-0 max-w-full', className)}>
        {children ?? scriptName}
      </span>
    );
  }

  const openPreview = async () => {
    let resolvedIsPublic = isPublic;
    if (typeof resolvedIsPublic !== 'boolean') {
      if (!previewContext.resolveAppVisibility || isResolving) return;
      setIsResolving(true);
      try {
        const resolved = await previewContext.resolveAppVisibility(scriptName);
        if (typeof resolved !== 'boolean') return;
        resolvedIsPublic = resolved;
      } catch {
        return;
      } finally {
        setIsResolving(false);
      }
    }

    const target: PreviewTarget = { kind: 'app', scriptName, isPublic: resolvedIsPublic };
    previewContext.openPreviewTarget(target);
  };

  return (
    <button
      type="button"
      disabled={isResolving}
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1 hover:underline',
        'text-foreground/80 hover:text-foreground',
        isResolving && 'cursor-wait opacity-70',
        className
      )}
      onClick={(event) => {
        event.stopPropagation();
        void openPreview();
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
