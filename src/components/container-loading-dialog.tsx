'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Loader2 } from 'lucide-react';
import type { Workspace } from '@/types';
import { getContrastTextColor } from '@/lib/avatar';

interface ContainerLoadingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  title?: string;
  description?: string;
  statusLabel?: string;
}

export function ContainerLoadingDialog({
  open,
  onOpenChange,
  workspace,
  title = 'Starting workspace...',
  description,
  statusLabel = 'Starting container...',
}: ContainerLoadingDialogProps) {
  const workspaceElement = (
    <span className="inline-flex items-center gap-1 font-medium text-foreground">
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
      {workspace.name}
    </span>
  );

  const defaultDescription = (
    <>Starting the {workspaceElement} container. This can take up to 20 seconds.</>
  );

  const renderDescription = () => {
    if (!description) return defaultDescription;
    const parts = description.split('{workspace}');
    if (parts.length === 1) return description;

    return (
      <>
        {parts[0]}
        {workspaceElement}
        {parts[1]}
      </>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{renderDescription()}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
          {workspaceElement}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>{statusLabel}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
