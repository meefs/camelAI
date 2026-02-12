import type { NotebookCell } from './types';
import { formatExecutionTime, toText } from './utils';
import { OutputRenderer } from './output-renderers';
import { PythonSyntaxHighlighter } from './syntax-highlighter';

interface NotebookCodeCellProps {
  cell: NotebookCell;
  cellIndex: number;
  layout: 'panel' | 'dialog';
}

export function NotebookCodeCell({
  cell,
  cellIndex,
  layout,
}: NotebookCodeCellProps) {
  const source = toText(cell.source) || '# Empty cell';
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  const execCount = typeof cell.execution_count === 'number'
    ? `[${cell.execution_count}]`
    : '[ ]';

  const execTime = formatExecutionTime(
    cell.metadata?.execution?.['iopub.execute_input'],
    cell.metadata?.execution?.['shell.execute_reply']
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex">
        <div className="flex w-16 shrink-0 flex-col items-center justify-between border-r border-border bg-muted/30 px-2 py-3 text-muted-foreground">
          <span className="font-mono text-[11px]">{execCount}</span>
          {execTime ? (
            <span className="font-mono text-[10px] text-muted-foreground/60">{execTime}</span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1 overflow-auto bg-zinc-950 p-3 dark:bg-zinc-900">
          <PythonSyntaxHighlighter code={source} />
        </div>
      </div>

      <div className="min-w-0 space-y-2 border-t border-border bg-muted/10 p-3">
        {outputs.length === 0 ? (
          <div className="font-mono text-xs text-muted-foreground">(no output)</div>
        ) : (
          outputs.map((output, outputIndex) => (
            <OutputRenderer
              key={`output-${cellIndex}-${outputIndex}`}
              output={output}
              mode="notebook"
              layout={layout}
              title={`Notebook output ${outputIndex + 1}`}
            />
          ))
        )}
      </div>
    </div>
  );
}
