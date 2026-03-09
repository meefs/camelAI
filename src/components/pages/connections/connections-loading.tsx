import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export function ConnectionsLoadingSkeleton() {
  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Connections' }]} />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <Skeleton className="h-8 w-40" />
              <Skeleton className="mt-2 h-4 w-72" />
            </div>
            <Skeleton className="h-10 w-36" />
          </div>

          <div className="mt-6">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-9 min-w-[220px] flex-1" />
                <Skeleton className="h-9 w-[170px]" />
              </div>
              <Skeleton className="h-9 w-[300px]" />
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardHeader className="flex flex-row items-start gap-3">
                    <Skeleton className="size-10 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-5 w-32" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                    <Skeleton className="h-6 w-16" />
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex justify-between">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                    <div className="flex justify-between">
                      <Skeleton className="h-8 w-20" />
                      <Skeleton className="h-8 w-24" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
