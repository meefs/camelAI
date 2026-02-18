'use client';

import { cn } from '@/lib/utils';

interface NotebookHtmlOutputProps {
  html: string;
  layout: 'panel' | 'dialog';
  title: string;
}

export function NotebookHtmlOutput({
  html,
  layout,
  title,
}: NotebookHtmlOutputProps) {
  return (
    <div className="relative">
      <iframe
        title={title}
        srcDoc={html}
        sandbox="allow-scripts allow-downloads"
        referrerPolicy="no-referrer"
        className={cn(
          'w-full overflow-hidden rounded border bg-background',
          layout === 'panel' ? 'aspect-[4/3] min-h-[280px] max-h-[600px]' : 'min-h-[280px]'
        )}
      />
    </div>
  );
}
