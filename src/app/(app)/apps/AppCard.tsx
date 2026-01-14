'use client';

import { useEffect, useState } from 'react';
import type { AppCreator, WorkerScriptWithCreator } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
  isAdmin,
  hostname,
  now,
  onOpenSettings,
  onStartChat,
  onViewSource,
}: AppCardProps) {
  const [copied, setCopied] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
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
  // FIXME: Derive from source_path once deployment metadata is available.
  const sourceLabel = 'index.html';

  useEffect(() => {
    if (!copyMessage) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
      setCopyMessage('');
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [copyMessage]);

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
    <Card className="p-0">
      <div className="aspect-video w-full bg-muted/80 flex items-center justify-center">
        <Globe className="size-8 text-muted-foreground/50" />
      </div>
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate text-base font-semibold">
              {app.script_name}
            </CardTitle>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => onViewSource(app)}
                >
                  <FileCode className="size-3" />
                  <span>{sourceLabel}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>View source file</TooltipContent>
            </Tooltip>
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
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Avatar size="2xs">
            <AvatarFallback content={creatorContent} style={creatorFallbackStyle}>
              {creatorContent}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{creatorLabel}</span>
          <span aria-hidden="true">&middot;</span>
          <span>Updated {getRelativeTime(app.updated_at, now)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {displayUrl}
          </span>
          <div className="flex items-center gap-1">
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
