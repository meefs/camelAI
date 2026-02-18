import { Separator } from '@/components/ui/separator';
import type { NotebookHeader } from './types';
import { formatNotebookDate } from './utils';

interface ReportHeaderProps {
  header: NotebookHeader;
}

export function ReportHeader({ header }: ReportHeaderProps) {
  const metadataItems: string[] = [];
  if (header.executionTimestamp) {
    metadataItems.push(formatNotebookDate(header.executionTimestamp));
  }
  metadataItems.push(`${header.cellCount} ${header.cellCount === 1 ? 'cell' : 'cells'}`);
  if (header.visualizationCount > 0) {
    metadataItems.push(
      `${header.visualizationCount} ${header.visualizationCount === 1 ? 'visualization' : 'visualizations'}`
    );
  }

  return (
    <div className="mb-8">
      <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground/50">
        Python Notebook  ·  Analysis
      </p>

      {header.title ? (
        <h1 className="mb-3 font-[family-name:var(--font-display)] text-3xl font-normal leading-tight tracking-tight text-foreground">
          {header.title}
        </h1>
      ) : null}

      {header.subtitle ? (
        <p className="mb-5 max-w-[540px] text-base leading-relaxed text-muted-foreground">
          {header.subtitle}
        </p>
      ) : null}

      <p className="font-mono text-xs text-muted-foreground/60">
        {metadataItems.join('  ·  ')}
      </p>

      <Separator className="mt-6" />
    </div>
  );
}
