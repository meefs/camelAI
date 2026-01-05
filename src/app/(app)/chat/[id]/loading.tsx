import { Skeleton } from '@/components/ui/skeleton';

export default function ChatLoading() {
  return (
    <div className="flex flex-1 flex-col">
      {/* Messages area */}
      <div className="flex-1 overflow-hidden">
        <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
          {/* Simulated message skeletons */}
          <div className="flex gap-3">
            <Skeleton className="size-8 rounded-full shrink-0" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-16 w-full max-w-md" />
            </div>
          </div>
          <div className="flex gap-3 justify-end">
            <div className="space-y-2 flex-1 flex flex-col items-end">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-12 w-full max-w-sm" />
            </div>
          </div>
          <div className="flex gap-3">
            <Skeleton className="size-8 rounded-full shrink-0" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-24 w-full max-w-lg" />
            </div>
          </div>
        </div>
      </div>

      {/* Input area skeleton */}
      <div className="border-t p-4">
        <div className="mx-auto max-w-3xl">
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
