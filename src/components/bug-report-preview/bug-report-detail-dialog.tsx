'use client';

import { Bug, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { getVanityDomain, buildAppLabel } from '@/lib/app-url';

export interface BugReportDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  description: string | null;
  timestamp: number;
  hostname?: string;
  orgSlug?: string;
}

function formatBugReportTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const datePart = date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timePart = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${datePart} at ${timePart}`;
}

export function BugReportDetailDialog({
  open,
  onOpenChange,
  appName,
  description,
  timestamp,
  hostname,
  orgSlug,
}: BugReportDetailDialogProps) {
  const vanityHost = orgSlug
    ? `${buildAppLabel(appName, orgSlug)}.${getVanityDomain(hostname)}`
    : `${appName}.${getVanityDomain(hostname)}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-[520px] p-0 gap-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <Bug className="size-4 text-muted-foreground" />
            Bug Report
          </DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close">
              <X className="size-4" />
            </Button>
          </DialogClose>
        </div>
        <div className="grid gap-4 px-4 py-4">
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">App</span>
            <span className="text-sm font-medium">{vanityHost}</span>
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">Reported</span>
            <span className="text-sm">{formatBugReportTimestamp(timestamp)}</span>
          </div>
          {description && (
            <div className="max-h-48 overflow-y-auto rounded-md bg-muted/30 p-3 pr-4 text-sm italic text-foreground whitespace-pre-wrap">
              "{description}"
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            Screenshot captured &middot; DOM snapshot captured &middot; Console logs captured
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
