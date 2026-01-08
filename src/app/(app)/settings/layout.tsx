import type { ReactNode } from "react"

import { SettingsNav } from "@/components/settings/settings-nav"
import { requireSession } from "@/lib/server-guards"

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode
}) {
  await requireSession()

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <SettingsNav />
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  )
}
