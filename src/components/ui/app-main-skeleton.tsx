import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading placeholder for the app's main content area (chat welcome screen).
 *
 * This is rendered as the Suspense fallback while deferred Durable Object RPC
 * and queries resolve on initial load — the workspace migration gate in
 * `_app.tsx` and the model picker / billing / chat-group bundle in the chat
 * welcome loader. Because those are streamed instead of awaited, the app shell
 * (sidebar + this skeleton) flushes to the browser as soon as auth resolves,
 * so a slow cold Durable Object no longer shows a blank screen.
 *
 * Layout mirrors the centered greeting + composer of the real welcome screen
 * so the swap to live content is visually minimal.
 */
export function AppMainSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-busy="true"
      aria-label="Loading"
    >
      {/* Matches the welcome screen's mobile header row height. */}
      <div className="flex h-11 shrink-0 items-center border-b bg-muted/20 px-2 md:hidden">
        <Skeleton className="size-7" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-4">
        <div className="flex w-full max-w-2xl flex-col items-center gap-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        {/* Composer placeholder. */}
        <div className="w-full max-w-2xl">
          <Skeleton className="h-32 w-full rounded-xl" />
          <div className="mt-3 flex items-center gap-2">
            <Skeleton className="h-8 w-28 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
        </div>
        {/* Recent threads placeholder. */}
        <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
