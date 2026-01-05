import { Skeleton } from '@/components/ui/skeleton';

export default function ComputerLoading() {
  return (
    <div className="flex flex-1 flex-col h-full">
      {/* Toolbar skeleton */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-32" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-8" />
        <Skeleton className="h-8 w-8" />
      </div>

      {/* Main content area */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar skeleton */}
        <div className="w-64 border-r p-4 space-y-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-6 w-5/6" />
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-6 w-full" />
        </div>

        {/* Editor skeleton */}
        <div className="flex-1 p-4">
          <div className="space-y-2">
            {Array.from({ length: 20 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-4"
                style={{ width: `${Math.random() * 60 + 20}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
