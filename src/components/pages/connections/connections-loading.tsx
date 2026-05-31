import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';

export function ConnectionsLoadingSkeleton() {
  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <PageHeader breadcrumbs={[{ label: 'Connections' }]} />

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <Skeleton className="h-8 w-40" />
                <Skeleton className="mt-2 h-4 w-72" />
              </div>
              <Skeleton className="h-7 w-32" />
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-2">
              <Skeleton className="h-9 min-w-[220px] flex-1" />
              <Skeleton className="h-9 w-full sm:w-[170px]" />
            </div>

            <div className="mt-8 space-y-8">
              {['Channels', 'Connections'].map((label, groupIndex) => (
                <section key={label}>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-3 w-4" />
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    {Array.from({ length: groupIndex === 0 ? 2 : 4 }).map((_, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                      >
                        <Skeleton className="size-8 rounded-md" />
                        <Skeleton className="h-4 flex-1" />
                        <Skeleton className="size-7 rounded-md" />
                        <Skeleton className="size-7 rounded-md" />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
