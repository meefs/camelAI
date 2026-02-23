'use client';

import type { ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';

interface FullScreenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function FullScreenDialog({
  open,
  onOpenChange,
  title,
  actions,
  children,
}: FullScreenDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="fixed inset-4 left-4 top-4 z-50 flex h-[calc(100dvh-2rem)] w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5">
          <DialogTitle className="min-w-0 truncate text-sm">{title}</DialogTitle>
          <div className="ml-auto flex items-center gap-1.5">
            {actions}
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close fullscreen view">
                <XIcon />
              </Button>
            </DialogClose>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
