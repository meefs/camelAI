import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { SettingsHeader } from "@/components/settings/settings-header"
import { requireAuthContextLite } from "@/lib/server-guards"

export default async function OrgBillingPage() {
  const authContext = await requireAuthContextLite()
  const billingStatus = authContext.currentOrg.billing_status

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Billing"
        description="View your organization's billing status and manage payments."
      />
      <Separator />
      <div className="space-y-4 max-w-2xl">
        <div>
          <h3 className="text-base font-medium mb-2">Current plan</h3>
          <div className="flex items-center gap-3">
            <Badge variant={billingStatus === "paying" ? "default" : "secondary"}>
              {billingStatus === "paying" ? "Pro" : "Free"}
            </Badge>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Billing management is coming soon. Contact support for plan changes.
        </p>
      </div>
    </div>
  )
}
