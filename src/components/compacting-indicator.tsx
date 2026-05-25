'use client';

export function CompactingIndicator() {
  return (
    <div data-testid="compacting-indicator" className="flex py-1">
      <div className="tool-call flex w-full items-center gap-2 rounded px-2 py-1 -mx-2 text-sm text-muted-foreground">
        <span className="tool-call__dot h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 animate-pulse motion-reduce:animate-none" />
        <span className="tool-call__text min-w-0 flex-1 truncate">
          Compacting conversation
        </span>
      </div>
    </div>
  );
}
