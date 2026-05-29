import { PageHeader } from "@/components/page-header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

export function AutomationsLoadingSkeleton() {
  return (
    <>
      <PageHeader breadcrumbs={[{ label: "Automations" }]} />
      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Skeleton className="h-7 w-40" />
                <Skeleton className="mt-2 h-4 w-80 max-w-full" />
              </div>
              <Skeleton className="h-7 w-32" />
            </div>
            <Skeleton className="mt-6 h-9 w-full" />
            <div className="mt-6">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index}>
                  <div className="flex items-center gap-3 px-3 py-3">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="ml-auto h-4 w-32" />
                  </div>
                  {index < 4 ? <Separator /> : null}
                </div>
              ))}
            </div>
          </div>
        </ScrollArea>
      </div>
    </>
  );
}
