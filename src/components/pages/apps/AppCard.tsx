'use client';

import { useEffect, useRef, useState } from 'react';
import type { AppCreator, WorkerScriptWithCreator, WorkspaceWithAccess } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { getAppUrl } from '@/lib/app-url';
import { getContrastTextColor } from '@/lib/avatar';
import {
  Check,
  Copy,
  ExternalLink,
  FileCode,
  Globe,
  Lock,
  MessageSquare,
  Settings,
} from 'lucide-react';

interface AppCardProps {
  app: WorkerScriptWithCreator;
  creator?: AppCreator;
  workspace?: WorkspaceWithAccess | null;
  showWorkspaceBadge?: boolean;
  isAdmin: boolean;
  hostname?: string;
  now?: number;
  onOpenSettings: (app: WorkerScriptWithCreator) => void;
  onStartChat: (app: WorkerScriptWithCreator) => void;
  onViewSource: (app: WorkerScriptWithCreator) => void;
}

function getCreatorLabel(creator: AppCreator | undefined, createdBy: string): string {
  const trimmedName = creator?.name?.trim();
  if (trimmedName) return trimmedName;
  const trimmedEmail = creator?.email?.trim();
  if (trimmedEmail) return trimmedEmail;
  if (createdBy?.startsWith('system')) return 'System';
  return 'Unknown';
}

function getInitials(label: string): string {
  const parts = label.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase() || '?';
}

function getRelativeTime(timestamp: number, referenceTime?: number): string {
  const now = referenceTime ?? Date.now();
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

export function AppCard({
  app,
  creator: creatorOverride,
  workspace,
  showWorkspaceBadge,
  isAdmin,
  hostname,
  now,
  onOpenSettings,
  onStartChat,
  onViewSource,
}: AppCardProps) {
  const [copied, setCopied] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const previewRef = useRef<HTMLImageElement | null>(null);
  const appUrl = getAppUrl(app.script_name, hostname);
  const displayUrl = appUrl.replace(/^https?:\/\//, '');
  const creator = creatorOverride ?? app.creator;
  const creatorLabel = getCreatorLabel(creator, app.created_by);
  const creatorAvatar = creator?.avatar ?? null;
  const creatorContent = creatorAvatar?.content ?? getInitials(creatorLabel);
  const creatorFallbackStyle = creatorAvatar?.color
    ? {
        backgroundColor: creatorAvatar.color,
        color: getContrastTextColor(creatorAvatar.color),
      }
    : undefined;
  // Extract filename from config_path (e.g., "/home/claude/my-app/wrangler.jsonc" -> "wrangler.jsonc")
  const sourceLabel = app.config_path
    ? app.config_path.split('/').pop() ?? 'wrangler.jsonc'
    : null;
  const previewVersion = app.preview_updated_at ?? app.updated_at;
  const previewUrl = app.preview_status === 'ready' && app.preview_key
    ? `/api/apps/${encodeURIComponent(app.script_name)}/preview?v=${previewVersion}`
    : null;
  const showPreview = Boolean(previewUrl) && !previewFailed;
  const previewLoading = showPreview && !previewLoaded;
  const workspaceBadge = showWorkspaceBadge && workspace ? (
    <Badge
      variant="secondary"
      className="gap-1 pl-1 pr-2 text-[10px] text-muted-foreground max-w-[140px] min-w-0 shrink justify-start"
    >
      <Avatar size="xs">
        <AvatarFallback
          content={workspace.avatar.content}
          style={{
            backgroundColor: workspace.avatar.color,
            color: getContrastTextColor(workspace.avatar.color),
          }}
        >
          {workspace.avatar.content}
        </AvatarFallback>
      </Avatar>
      <span className="truncate min-w-0">{workspace.name}</span>
    </Badge>
  ) : null;

  useEffect(() => {
    if (!copyMessage) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
      setCopyMessage('');
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [copyMessage]);

  useEffect(() => {
    setPreviewFailed(false);
    setPreviewLoaded(false);
  }, [previewUrl]);

  useEffect(() => {
    if (!showPreview || previewLoaded || previewFailed) return;
    const img = previewRef.current;
    if (!img || !img.complete) return;
    if (img.naturalWidth > 0) {
      setPreviewLoaded(true);
    } else {
      setPreviewFailed(true);
    }
  }, [previewFailed, previewLoaded, previewUrl, showPreview]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(appUrl);
      setCopied(true);
      setCopyMessage('Copied app URL to clipboard.');
    } catch {
      setCopied(false);
      setCopyMessage('Failed to copy app URL.');
    }
  };

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="relative aspect-video w-full">
        {workspaceBadge ? (
          <div className="absolute right-2 top-2 z-10">
            {workspaceBadge}
          </div>
        ) : null}
        {showPreview ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={previewRef}
              src={previewUrl ?? undefined}
              alt={`${app.script_name} preview`}
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${previewLoaded ? 'opacity-100' : 'opacity-0'}`}
              loading="lazy"
              decoding="async"
              onLoad={() => setPreviewLoaded(true)}
              onError={() => {
                setPreviewFailed(true);
                setPreviewLoaded(false);
              }}
            />
            {previewLoading ? (
              <div className="absolute inset-0" aria-hidden="true">
                <Skeleton className="h-full w-full rounded-none" />
              </div>
            ) : null}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted/80 via-muted/40 to-muted/80">
            <Globe className="size-8 text-muted-foreground/60" />
          </div>
        )}
      </div>
      <CardHeader className="pb-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate text-base font-semibold">
              {app.script_name}
            </CardTitle>
            {sourceLabel && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1.5 px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => onViewSource(app)}
                  >
                    <FileCode className="size-3" />
                    <span>{sourceLabel}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View source file</TooltipContent>
              </Tooltip>
            )}
          </div>
          <Badge
            variant={app.is_public ? 'default' : 'secondary'}
            className="shrink-0"
          >
            {app.is_public ? (
              <Globe className="size-3" />
            ) : (
              <Lock className="size-3" />
            )}
            {app.is_public ? 'Public' : 'Private'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pb-4 pt-0">
        <div className="flex items-center gap-2 text-xs/relaxed text-muted-foreground">
          <Avatar size="2xs">
            <AvatarFallback content={creatorContent} style={creatorFallbackStyle}>
              {creatorContent}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{creatorLabel}</span>
          <span aria-hidden="true">&middot;</span>
          <span>Updated {getRelativeTime(app.updated_at, now)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="relative">
              <Input
                readOnly
                value={displayUrl}
                aria-label="App URL"
                className="h-9 truncate pr-16 text-xs/relaxed text-muted-foreground"
              />
              <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={copied ? 'Copied URL' : 'Copy URL'}
                      onClick={handleCopy}
                    >
                      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{copied ? 'Copied!' : 'Copy URL'}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Open in new tab"
                      onClick={() => {
                        window.open(appUrl, '_blank', 'noopener,noreferrer');
                      }}
                    >
                      <ExternalLink className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Open in new tab</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Start a chat"
                  onClick={() => onStartChat(app)}
                >
                  <MessageSquare className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Start a chat</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="App settings"
                    disabled={!isAdmin}
                    onClick={() => onOpenSettings(app)}
                  >
                    <Settings className="size-3.5" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{isAdmin ? 'App settings' : 'Admins only'}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <span className="sr-only" aria-live="polite">
          {copyMessage}
        </span>
      </CardContent>
    </Card>
  );
}
