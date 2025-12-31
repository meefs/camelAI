import { Skeleton } from '@/components/ui/skeleton';

export function ChatLoading() {
  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 md:px-6 py-3 border-b border-border">
          <Skeleton className="h-6 w-24" />
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto w-full px-4 md:px-6 pt-4 pb-6 space-y-6">
            <div className="space-y-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
            <div className="space-y-3">
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-4/6" />
              <Skeleton className="h-4 w-2/6" />
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-10 w-1/3 rounded-3xl" />
            </div>
            <div className="space-y-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          </div>
        </div>
        <div className="px-4 md:px-6 py-4 border-t border-border">
          <Skeleton className="h-12 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
