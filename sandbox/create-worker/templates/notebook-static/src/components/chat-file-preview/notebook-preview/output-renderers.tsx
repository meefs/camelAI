import { useRef } from 'react';
import { cn } from '@/lib/utils';
import type { NotebookOutput } from './types';
import { getOutputRender } from './utils';
import { NotebookHtmlOutput } from './html-output';
import { PlotlyChart } from './plotly-chart';
import { VegaLiteChart } from './vega-lite-chart';
import { NotebookTable } from './notebook-table';
import { OutputActionBar } from './output-action-bar';

interface OutputRendererProps {
  output: NotebookOutput;
  mode: 'report' | 'notebook';
  layout: 'panel' | 'dialog';
  title: string;
}

interface ChartOutputWithActionsProps {
  kind: 'vegalite' | 'plotly';
  spec: Record<string, unknown>;
  title: string;
}

function ChartOutputWithActions({
  kind,
  spec,
  title,
}: ChartOutputWithActionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="w-full min-w-0">
      <div ref={containerRef}>
        {kind === 'vegalite' ? (
          <VegaLiteChart spec={spec} title={title} />
        ) : (
          <PlotlyChart payload={spec} title={title} />
        )}
      </div>
      <OutputActionBar
        kind={kind}
        containerRef={containerRef}
        spec={spec}
        title={title}
      />
    </div>
  );
}

export function OutputRenderer({
  output,
  mode,
  layout,
  title,
}: OutputRendererProps) {
  if (output.output_type === 'error') {
    const errorText = [output.ename, output.evalue].filter(Boolean).join(': ');
    const traceback = Array.isArray(output.traceback) ? output.traceback.join('\n') : '';
    return (
      <pre className="overflow-auto rounded-lg border border-red-200 bg-red-50 p-3 font-mono text-xs whitespace-pre-wrap text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        {errorText}
        {traceback ? `\n${traceback}` : ''}
      </pre>
    );
  }

  const render = getOutputRender(output);

  if (render.kind === 'vegalite') {
    return (
      <ChartOutputWithActions kind="vegalite" spec={render.spec} title={title} />
    );
  }

  if (render.kind === 'plotly') {
    return (
      <ChartOutputWithActions kind="plotly" spec={render.payload} title={title} />
    );
  }

  if (render.kind === 'table') {
    return (
      <div className="w-full min-w-0">
        <NotebookTable table={render.table} mode={mode} />
      </div>
    );
  }

  if (render.kind === 'html') {
    return (
      <div className="w-full min-w-0">
        <NotebookHtmlOutput html={render.html} layout={layout} title={title} />
      </div>
    );
  }

  if (render.kind === 'image') {
    return (
      <img
        src={render.src}
        alt={title}
        className="w-auto max-w-full rounded"
      />
    );
  }

  if (render.kind === 'text') {
    if (mode === 'report') {
      return (
        <pre
          className={cn(
            'rounded-xl bg-muted/50 p-5',
            'font-mono text-sm leading-[1.65] text-foreground/80',
            'whitespace-pre-wrap',
            'shadow-[inset_0_2px_4px_rgba(0,0,0,0.06)]'
          )}
        >
          {render.text}
        </pre>
      );
    }

    return (
      <pre className="overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap text-foreground/90">
        {render.text}
      </pre>
    );
  }

  return (
    <div className="text-xs italic text-muted-foreground">
      Output type is not supported in preview.
    </div>
  );
}
