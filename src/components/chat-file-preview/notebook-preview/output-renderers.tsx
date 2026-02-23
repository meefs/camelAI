import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { NotebookOutput, ParsedTable } from './types';
import { getOutputRender } from './utils';
import { NotebookHtmlOutput } from './html-output';
import { PlotlyChart } from './plotly-chart';
import { VegaLiteChart } from './vega-lite-chart';
import { NotebookTable } from './notebook-table';
import { OutputActionBar } from './output-action-bar';
import { FullScreenDialog } from './full-screen-dialog';
import { TableViewer } from './table-viewer';

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
  const chartTitle = title || 'Chart';
  const inlineContainerRef = useRef<HTMLDivElement>(null);
  const fullScreenContainerRef = useRef<HTMLDivElement>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);

  const renderChart = (fullScreen: boolean) => {
    if (kind === 'vegalite') {
      return <VegaLiteChart spec={spec} title={chartTitle} fillContainer={fullScreen} />;
    }
    return (
      <PlotlyChart
        payload={spec}
        title={chartTitle}
        showModeBar={fullScreen}
        fillContainer={fullScreen}
      />
    );
  };

  return (
    <div className="w-full min-w-0">
      <div ref={inlineContainerRef}>
        {renderChart(false)}
      </div>
      <OutputActionBar
        kind={kind}
        containerRef={inlineContainerRef}
        spec={spec}
        title={chartTitle}
        onExpand={() => setIsFullScreen(true)}
      />
      {isFullScreen ? (
        <FullScreenDialog
          open={isFullScreen}
          onOpenChange={setIsFullScreen}
          title={chartTitle}
          actions={(
            <OutputActionBar
              kind={kind}
              containerRef={fullScreenContainerRef}
              spec={spec}
              title={chartTitle}
              className="mt-0"
            />
          )}
        >
          <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-6">
            <div ref={fullScreenContainerRef} className="h-full w-full max-w-[1800px]">
              {renderChart(true)}
            </div>
          </div>
        </FullScreenDialog>
      ) : null}
    </div>
  );
}

interface TableOutputWithActionsProps {
  table: ParsedTable;
  mode: 'report' | 'notebook';
  title: string;
}

function TableOutputWithActions({ table, mode, title }: TableOutputWithActionsProps) {
  const tableTitle = title || 'Table';
  const [isFullScreen, setIsFullScreen] = useState(false);

  return (
    <div className="w-full min-w-0">
      <NotebookTable
        table={table}
        mode={mode}
        onExpand={() => setIsFullScreen(true)}
      />
      {isFullScreen ? (
        <FullScreenDialog
          open={isFullScreen}
          onOpenChange={setIsFullScreen}
          title={tableTitle}
        >
          <TableViewer table={table} title={tableTitle} />
        </FullScreenDialog>
      ) : null}
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
      <TableOutputWithActions table={render.table} mode={mode} title={title} />
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
