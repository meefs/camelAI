import {
  SettingsContentSkeleton,
  SettingsNavSkeleton,
} from "@/components/settings/settings-loading"

export default function SettingsLoading() {
  return (
    <div className="flex h-full flex-col md:flex-row overflow-hidden">
      <SettingsNavSkeleton />
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <SettingsContentSkeleton />
      </main>
    </div>
  )
}
