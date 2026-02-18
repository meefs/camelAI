export function PlotlyPlaceholder() {
  return (
    <div className="flex h-[320px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/20">
      <div className="flex flex-col items-center gap-2 text-muted-foreground/40">
        <div className="flex h-12 items-end gap-1">
          <div className="h-4 w-2.5 rounded-sm bg-muted-foreground/15" />
          <div className="h-7 w-2.5 rounded-sm bg-muted-foreground/15" />
          <div className="h-5 w-2.5 rounded-sm bg-muted-foreground/15" />
          <div className="h-9 w-2.5 rounded-sm bg-muted-foreground/15" />
          <div className="h-6 w-2.5 rounded-sm bg-muted-foreground/15" />
          <div className="h-10 w-2.5 rounded-sm bg-muted-foreground/15" />
          <div className="h-8 w-2.5 rounded-sm bg-muted-foreground/15" />
        </div>
        <span className="font-mono text-xs">Chart</span>
      </div>
    </div>
  );
}
