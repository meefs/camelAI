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
}

export function SwitchWorkspaceDialog({
  open,
  onOpenChange,
  workspace,
  onConfirm,
  loading = false,
}: SwitchWorkspaceDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            This chat belongs to a different workspace. Switch to{' '}
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
            </span>{' '}
            to continue this conversation.
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
