'use client';

import { useState } from 'react';
import { Bug } from 'lucide-react';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { BugReportDetailDialog } from './bug-report-detail-dialog';
import { getVanityDomain, buildAppLabel } from '@/lib/app-url';

export interface BugReportCardProps {
  appName: string;
  description: string | null;
  timestamp: number;
  hostname?: string;
  orgSlug?: string;
}

export function BugReportCard({
  appName,
  description,
  timestamp,
  hostname,
  orgSlug,
}: BugReportCardProps) {
  const [open, setOpen] = useState(false);
  const vanityHost = orgSlug
    ? `${buildAppLabel(appName, orgSlug)}.${getVanityDomain(hostname)}`
    : `${appName}.${getVanityDomain(hostname)}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-left max-w-[280px] rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label="Open bug report details"
        aria-haspopup="dialog"
      >
        <Card size="sm" className="transition-colors hover:bg-accent/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Bug className="size-4 text-muted-foreground shrink-0" />
              Bug Report
            </CardTitle>
          </CardHeader>
          {description && (
            <CardContent className="text-sm text-muted-foreground line-clamp-3">
              "{description}"
            </CardContent>
          )}
          <CardFooter className="text-xs text-muted-foreground">{vanityHost}</CardFooter>
        </Card>
      </button>
      <BugReportDetailDialog
        open={open}
        onOpenChange={setOpen}
        appName={appName}
        description={description}
        timestamp={timestamp}
        hostname={hostname}
        orgSlug={orgSlug}
      />
    </>
  );
}
