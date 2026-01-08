import { Globe } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { SettingsHeader } from "@/components/settings/settings-header"

export default function OrgDomainsPage() {
  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Domains"
        description="Configure custom domains for your projects."
      />
      <Separator />
      <Card className="p-8 text-center">
        <Globe className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h3 className="mb-2 font-medium">Custom domains coming soon</h3>
        <p className="text-sm text-muted-foreground">
          You'll be able to host your projects on your own domain.
        </p>
      </Card>
    </div>
  )
}
