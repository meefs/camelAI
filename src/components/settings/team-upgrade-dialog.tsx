"use client"

import { useEffect } from "react"
import { Link, useFetcher } from "react-router"
import { toast } from "sonner"

import { PlanPickerCard } from "@/components/billing/plan-picker-card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useIsMobile } from "@/hooks/use-mobile"
import { BILLING_PLAN_LIMITS } from "@/lib/billing-plans"

export interface TeamUpgradeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** User's current plan — used to render the explainer line ("Your Pro plan includes 1 seat..."). */
  currentPlan: "free" | "starter" | "pro"
  /** Whether the org still has a 7-day trial available. Drives CTA label. */
  trialAvailable: boolean
  /** Whether Stripe billing is configured in this environment. Disables the CTA when false. */
  stripeConfigured: boolean
  /** True when the org has a legacy Stripe subscription. Switches CTA copy to "Switch to Team". */
  legacyMigrationEligible: boolean
}

export function TeamUpgradeDialog({
  open,
  onOpenChange,
  currentPlan,
  trialAvailable,
  stripeConfigured,
  legacyMigrationEligible,
}: TeamUpgradeDialogProps) {
  const isMobile = useIsMobile()
  const fetcher = useFetcher<{
    checkoutUrl?: string
    billingPortalUrl?: string
    planChanged?: boolean
    error?: string
  }>()
  const pending = fetcher.state !== "idle"

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    const nextUrl = fetcher.data.checkoutUrl ?? fetcher.data.billingPortalUrl
    if (nextUrl) {
      window.location.assign(nextUrl)
      return
    }
    if (fetcher.data.planChanged) {
      window.location.assign("/settings/organization/team")
      return
    }
    if (fetcher.data.error) {
      toast.error(fetcher.data.error)
    }
  }, [fetcher.data, fetcher.state])

  const planLabel = BILLING_PLAN_LIMITS[currentPlan].label
  const description = `Your ${planLabel} plan includes 1 seat. Upgrade to Team to invite teammates and collaborate in shared workspaces.`

  const handleUpgrade = () => {
    if (legacyMigrationEligible) {
      fetcher.submit(
        { plan: "team" },
        { method: "post", action: "/api/billing/legacy-migration" },
      )
      return
    }
    fetcher.submit(
      { intent: "changePlan", plan: "team" },
      { method: "post", action: "/settings/organization/billing" },
    )
  }

  const planCard = (
    <PlanPickerCard
      plan="team"
      state={{ kind: "highlighted" }}
      pending={pending}
      disabled={!stripeConfigured}
      trialAvailable={trialAvailable}
      legacyMode={legacyMigrationEligible}
      onSelect={handleUpgrade}
    />
  )

  const stripeWarning = !stripeConfigured ? (
    <p className="text-xs text-muted-foreground">
      Hosted billing isn't configured in this environment. Contact{" "}
      <a
        className="underline underline-offset-2 hover:text-foreground"
        href="mailto:support@camelai.com"
      >
        support@camelai.com
      </a>
      .
    </p>
  ) : null

  const comparePlansButton = stripeConfigured ? (
    <Button variant="outline" asChild>
      <Link to="/settings/organization/billing?view=plans">Compare plans</Link>
    </Button>
  ) : (
    <Button variant="outline" disabled>
      Compare plans
    </Button>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>Upgrade to Team to invite teammates</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="space-y-3 px-6 pt-2">
            <div className="pt-3">{planCard}</div>
            {stripeWarning}
          </div>
          <SheetFooter>
            {comparePlansButton}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upgrade to Team to invite teammates</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 pt-3">
          {planCard}
          {stripeWarning}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {comparePlansButton}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
