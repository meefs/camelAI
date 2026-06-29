"use client";

import type { ReactNode } from 'react';
import { useState } from 'react';
import { useAuthData } from '@/hooks/use-auth-data';
import { cn } from '@/lib/utils';
import { FilePreviewPopover } from '@/components/chat-file-preview';
import {
  buildRawFilePreviewRoute,
  buildTextPreviewUrls,
} from '@/components/chat-file-preview/file-preview-urls';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import {
  buildFilePreviewLinkTarget,
  type FilePreviewLinkTarget,
} from '@/lib/file-preview-target';
import type { PreviewTarget } from '@/types';

function getPopoverPreviewDescriptor(
  workspaceId: string,
  target: FilePreviewLinkTarget,
) {
  if (target.source === 'vm') return null;

  return {
    workspaceId,
    source: target.source,
    path: target.path,
    project: target.project,
  };
}

function buildPreviewTarget(
  workspaceId: string,
  target: FilePreviewLinkTarget,
): PreviewTarget | null {
  if ((target.source === 'project' || target.source === 'vm') && !target.project) return null;
  return {
    kind: 'file',
    source: target.source,
    workspaceId,
    path: target.path,
    filename: target.filename,
    ...(target.project ? { project: target.project } : {}),
    ...(target.contentType ? { contentType: target.contentType } : {}),
  };
}

interface FileLinkProps {
  path: string;
  previewTarget?: FilePreviewLinkTarget;
  workspaceId?: string;
  children?: ReactNode;
  className?: string;
  mono?: boolean;
}

export function FileLink({
  path,
  previewTarget,
  workspaceId,
  children,
  className,
  mono = false,
}: FileLinkProps) {
  const { currentWorkspace } = useAuthData();
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewContext = useChatPreviewContext();
  const resolvedWorkspaceId =
    workspaceId ?? previewContext?.workspaceId ?? currentWorkspace?.id;
  const resolvedTarget = previewTarget ?? buildFilePreviewLinkTarget({ path });
  const previewTargetForContext = resolvedWorkspaceId && resolvedTarget
    ? buildPreviewTarget(resolvedWorkspaceId, resolvedTarget)
    : null;
  const displayContent = children ?? (
    resolvedTarget?.source === 'workspace' && !previewTarget
      ? path
      : resolvedTarget?.filename
  );

  if (!resolvedTarget || !resolvedWorkspaceId) {
    return (
      <span className={cn(mono && "font-mono", className)}>
        {children ?? path}
      </span>
    );
  }

  if (previewContext && previewTargetForContext) {
    return (
      <button
        type="button"
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-1 hover:underline",
          "text-foreground/80 hover:text-foreground",
          mono && "font-mono",
          className
        )}
        onClick={(event) => {
          event.stopPropagation();
          previewContext.openPreviewTarget(previewTargetForContext);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
          }
        }}
      >
        {displayContent}
      </button>
    );
  }

  const previewDescriptor = getPopoverPreviewDescriptor(
    resolvedWorkspaceId,
    resolvedTarget,
  );
  if (!previewDescriptor) {
    return (
      <span className={cn(mono && "font-mono", className)}>
        {children ?? path}
      </span>
    );
  }

  const previewUrl = buildRawFilePreviewRoute(previewDescriptor);
  const textPreviewUrls = buildTextPreviewUrls(previewDescriptor);

  return (
    <>
      <button
        type="button"
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-1 hover:underline",
          "text-foreground/80 hover:text-foreground",
          mono && "font-mono",
          className
        )}
        onClick={(event) => {
          event.stopPropagation();
          setPreviewOpen(true);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
          }
        }}
      >
        {displayContent}
      </button>
      <FilePreviewPopover
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        filename={resolvedTarget.filename}
        previewUrl={previewUrl}
        textPreviewUrl={textPreviewUrls.initialUrl}
        fullTextPreviewUrl={textPreviewUrls.fullUrl}
      />
    </>
  );
}
