import { Separator } from '@/components/ui/separator';

interface ReportFooterProps {
  codeCellCount: number;
  languageVersion?: string;
}

export function ReportFooter({
  codeCellCount,
  languageVersion,
}: ReportFooterProps) {
  const rightText = [
    `${codeCellCount} code ${codeCellCount === 1 ? 'cell' : 'cells'}`,
    languageVersion ? `Python ${languageVersion}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <div className="report-footer mt-12">
      <Separator />
      <div className="flex items-center justify-between pt-3">
        <span className="font-mono text-[10px] text-muted-foreground/40">
          Rendered by camelAI
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/40">
          {rightText}
        </span>
      </div>
    </div>
  );
}
