import { Skeleton } from "@/components/ui/skeleton"

export function SettingsNavSkeleton() {
  return (
    <nav className="md:w-56 shrink-0">
      <div className="md:hidden px-4 py-3">
        <div className="flex gap-2 overflow-x-auto">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={`settings-nav-pill-${index}`} className="h-8 w-24" />
          ))}
        </div>
      </div>
      <div className="hidden md:block p-4">
        <div className="space-y-6">
          {Array.from({ length: 3 }).map((_, groupIndex) => (
            <div key={`settings-nav-group-${groupIndex}`} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((__, itemIndex) => (
                  <Skeleton
                    key={`settings-nav-item-${groupIndex}-${itemIndex}`}
                    className="h-8 w-full"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </nav>
  )
}

export function SettingsContentSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="space-y-5 max-w-2xl">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={`settings-field-${index}`} className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
      <div className="space-y-4">
        <Skeleton className="h-px w-full" />
        <div className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
    </div>
  )
}
