'use client';

export function CompactingIndicator() {
  return (
    <div className="flex py-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse motion-reduce:animate-none shrink-0" />
        <span>Compacting conversation...</span>
      </div>
    </div>
  );
}
