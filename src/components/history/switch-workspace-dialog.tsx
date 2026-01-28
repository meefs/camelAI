'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { Workspace } from '@/types';
import { getContrastTextColor } from '@/lib/avatar';

interface SwitchWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  onConfirm: () => void;
  loading?: boolean;
  /** Custom description. Use {workspace} as placeholder for the workspace name with avatar. */
  description?: string;
}

export function SwitchWorkspaceDialog({
  open,
  onOpenChange,
  workspace,
  onConfirm,
  loading = false,
  description,
}: SwitchWorkspaceDialogProps) {
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

  // Default description for chat history
  const defaultDescription = (
    <>
      This chat belongs to a different workspace. Switch to {workspaceElement} to
      continue this conversation.
    </>
  );

  // Parse custom description and replace {workspace} placeholder
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch workspace?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <p>{renderDescription()}</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={loading}>
            {loading ? 'Switching...' : 'Switch workspace'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
