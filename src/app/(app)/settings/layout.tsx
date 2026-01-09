import type { ReactNode } from "react"
import { Suspense } from "react"

import { SettingsNav } from "@/components/settings/settings-nav"
import {
  SettingsContentSkeleton,
  SettingsNavSkeleton,
} from "@/components/settings/settings-loading"
import { SettingsRefreshWrapper } from "@/components/settings/settings-refresh-wrapper"
import { requireSession } from "@/lib/server-guards"

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode
}) {
  await requireSession()

  return (
    <div className="flex h-full flex-col md:flex-row overflow-hidden">
      <Suspense fallback={<SettingsNavSkeleton />}>
        <SettingsNav />
      </Suspense>
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <SettingsRefreshWrapper>
          <Suspense fallback={<SettingsContentSkeleton />}>
            {children}
          </Suspense>
        </SettingsRefreshWrapper>
      </main>
    </div>
  )
}
