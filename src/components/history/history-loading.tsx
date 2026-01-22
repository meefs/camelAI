import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/page-header';

export function HistoryLoadingSkeleton() {
  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Chat History' }]} />

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="max-w-4xl mx-auto w-full flex-1 min-h-0 flex flex-col px-4 md:px-6">
          <div className="sticky top-12 z-20 bg-background py-4 space-y-3 sm:-ml-6 sm:w-[calc(100%+1.5rem)] sm:pl-6">
            <Skeleton className="h-10 w-full" />
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-20" />
            </div>
          </div>

          <div className="flex-1 sm:-ml-6 sm:w-[calc(100%+1.5rem)]">
            <div className="py-2 sm:pl-6 space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={`history-skeleton-${index}`}
                  className="relative flex items-center gap-3 rounded-lg pl-12 pr-3 py-3 sm:pl-3"
                >
                  <div className="absolute left-4 sm:left-[-1rem] top-1/2 -translate-x-1/2 -translate-y-1/2">
                    <Skeleton className="h-5 w-5 rounded" />
                  </div>
                  <div className="flex-1 min-w-0 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
