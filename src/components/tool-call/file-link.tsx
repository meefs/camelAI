"use client";

import type { ReactNode } from 'react';
import { useState } from 'react';
import { useAuthData } from '@/hooks/use-auth-data';
import { cn } from '@/lib/utils';
import { FilePreviewPopover } from '@/components/chat-file-preview';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import type { PreviewTarget } from '@/types';

const WORKSPACE_ROOT_PREFIXES = ['/home/claude', '/workspace', '/root'];

const TEMP_FILE_PREFIXES = [
  { prefix: '/mnt/user-uploads/', type: 'upload' as const, urlSegment: 'uploads' },
  { prefix: '/mnt/user-outputs/', type: 'output' as const, urlSegment: 'outputs' },
];

function normalizeWorkspacePath(input: string): string {
  const trimmed = input?.trim?.() ?? '';
  if (!trimmed) return '';
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  for (const prefix of WORKSPACE_ROOT_PREFIXES) {
    if (normalized === prefix) return '/';
    if (normalized.startsWith(`${prefix}/`)) {
      const remainder = normalized.slice(prefix.length);
      return remainder.startsWith('/') ? remainder : `/${remainder}`;
    }
  }
  return normalized;
}

function getTempFileInfo(input: string) {
  const trimmed = input?.trim?.() ?? '';
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  for (const { prefix, type, urlSegment } of TEMP_FILE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      const relativePath = normalized.slice(prefix.length);
      if (!relativePath) return null;
      return { type, relativePath, urlSegment };
    }
  }
  return null;
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function getBasename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

interface FileLinkProps {
  path: string;
  children?: ReactNode;
  className?: string;
  mono?: boolean;
}

export function FileLink({
  path,
  children,
  className,
  mono = false,
}: FileLinkProps) {
  const { currentWorkspace } = useAuthData();
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewContext = useChatPreviewContext();
  const tempInfo = getTempFileInfo(path);
  const normalizedPath = normalizeWorkspacePath(path);

  if (!normalizedPath || !currentWorkspace?.id) {
    return (
      <span className={cn(mono && "font-mono", className)}>
        {children ?? path}
      </span>
    );
  }

  if (tempInfo) {
    const previewUrl = `/api/workspaces/${currentWorkspace.id}/${tempInfo.urlSegment}/${encodePathSegments(tempInfo.relativePath)}`;
    const displayName = tempInfo.relativePath.split('/').pop() || tempInfo.relativePath;
    const previewTarget: PreviewTarget = {
      kind: 'file',
      source: tempInfo.type,
      workspaceId: currentWorkspace.id,
      path: tempInfo.relativePath,
      filename: displayName,
    };

    if (previewContext) {
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
            previewContext.openPreviewTarget(previewTarget);
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation();
            }
          }}
        >
          {children ?? displayName}
        </button>
      );
    }

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
          {children ?? displayName}
        </button>
        <FilePreviewPopover
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          filename={displayName}
          previewUrl={previewUrl}
        />
      </>
    );
  }

  if (previewContext) {
    const previewTarget: PreviewTarget = {
      kind: 'file',
      source: 'workspace',
      workspaceId: currentWorkspace.id,
      path: normalizedPath,
      filename: getBasename(normalizedPath),
    };

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
          previewContext.openPreviewTarget(previewTarget);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
          }
        }}
      >
        {children ?? path}
      </button>
    );
  }

  const displayName = getBasename(normalizedPath);
  const previewUrl = `/api/workspaces/${currentWorkspace.id}/fs/content/${encodePathSegments(normalizedPath.replace(/^\/+/, ''))}`;

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
        {children ?? path}
      </button>
      <FilePreviewPopover
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        filename={displayName}
        previewUrl={previewUrl}
      />
    </>
  );
}
