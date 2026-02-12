'use client';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { PlotlyPlaceholder } from './plotly-placeholder';

interface NotebookHtmlOutputProps {
  html: string;
  layout: 'panel' | 'dialog';
  title: string;
}

export function NotebookHtmlOutput({
  html,
  layout: _layout,
  title,
}: NotebookHtmlOutputProps) {
  const [loaded, setLoaded] = useState(false);
  const isPlotlyDocument = useMemo(
    () => html.includes('plotly-root') || html.includes('application/vnd.plotly.v1+json'),
    [html]
  );

  useEffect(() => {
    setLoaded(false);
  }, [html]);

  return (
    <div className="relative">
      {isPlotlyDocument && !loaded ? (
        <div className="absolute inset-0">
          <PlotlyPlaceholder />
        </div>
      ) : null}
      <iframe
        title={title}
        srcDoc={html}
        sandbox="allow-scripts allow-downloads"
        referrerPolicy="no-referrer"
        className={cn(
          'aspect-[4/3] min-h-[280px] max-h-[600px] w-full rounded border bg-background transition-opacity',
          isPlotlyDocument && !loaded ? 'opacity-0' : 'opacity-100'
        )}
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
