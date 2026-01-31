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

export interface BugReportCardProps {
  appName: string;
  description: string | null;
  reportPath: string;
  timestamp: number;
}

export function BugReportCard({
  appName,
  description,
  reportPath,
  timestamp,
}: BugReportCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-report-path={reportPath}
        className="text-left max-w-[280px] rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label="Open bug report details"
        aria-haspopup="dialog"
      >
        <Card size="sm" className="transition-colors hover:bg-accent/50">
          <CardHeader className="flex items-center gap-2">
            <Bug className="size-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Bug Report</CardTitle>
          </CardHeader>
          {description && (
            <CardContent className="text-sm text-muted-foreground line-clamp-3">
              "{description}"
            </CardContent>
          )}
          <CardFooter className="text-xs text-muted-foreground">{appName}</CardFooter>
        </Card>
      </button>
      <BugReportDetailDialog
        open={open}
        onOpenChange={setOpen}
        appName={appName}
        description={description}
        timestamp={timestamp}
      />
    </>
  );
}
