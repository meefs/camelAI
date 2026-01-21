import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';

export function ChatLoadingSkeleton() {
  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Chat' }]} />

      <div className="flex-1 flex min-h-0">
        <div className="flex flex-col min-h-0 flex-1">
          {/* Message area */}
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="max-w-3xl mx-auto w-full px-4 md:px-6 pt-2 pb-6 flex flex-col gap-6">
              {/* User message skeleton */}
              <div className="flex flex-col items-end gap-1 mt-6">
                <Skeleton className="h-16 w-3/4 rounded-3xl" />
              </div>

              {/* Assistant message skeleton */}
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-2/3" />
              </div>

              {/* Another user message */}
              <div className="flex flex-col items-end gap-1 mt-6">
                <Skeleton className="h-12 w-1/2 rounded-3xl" />
              </div>

              {/* Another assistant response */}
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </div>
          </div>

          {/* Composer skeleton */}
          <div className="sticky bottom-0 z-20 shrink-0 bg-background pt-2 pb-4 px-4">
            <div className="max-w-3xl mx-auto w-full">
              <Skeleton className="h-[52px] w-full rounded-xl" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
