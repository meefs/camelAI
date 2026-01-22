import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { AppCardSkeleton } from './AppCardSkeleton';

export function AppsLoadingSkeleton() {
  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Apps' }]} />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <Skeleton className="h-8 w-24" />
              <Skeleton className="mt-2 h-4 w-80" />
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <AppCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
