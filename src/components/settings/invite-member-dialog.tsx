"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { useFetcher } from "react-router"
import { useForm, getFormProps, type SubmissionResult } from "@conform-to/react"
import { parseWithZod } from "@conform-to/zod/v4"
import { toast } from "sonner"
import { AlertCircleIcon, InfoIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  EmailChipInput,
  type EmailChip,
  type EmailChipInputHandle,
} from "@/components/settings/email-chip-input"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  formatUsdFromCents,
} from "@/lib/billing"
import {
  normalizeSeatCount,
  type BillableTeamInviteSeatChange,
  type TeamInviteBillingContext,
} from "@/lib/billing-plans"
import { formatInviteIssue } from "@/lib/invite-reason-copy"
import { inviteMemberFormSchema } from "@/lib/schemas"

interface InviteMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamInviteBillingContext?: TeamInviteBillingContext | null
  knownMemberEmails?: string[]
  knownInvitedEmails?: string[]
}

export function InviteMemberDialog({
  open,
  onOpenChange,
  teamInviteBillingContext = null,
  knownMemberEmails = [],
  knownInvitedEmails = [],
}: InviteMemberDialogProps) {
  const isMobile = useIsMobile()
  const fetcher = useFetcher<{
    result?: SubmissionResult<string[]>;
    success?: boolean;
    error?: string;
    message?: string;
    warning?: string;
    invited?: Array<{ email: string; invitation_id: string }>;
    skipped?: Array<{ email: string; reason: string }>;
    failed?: Array<{ email: string; reason: string }>;
    billing?: BillableTeamInviteSeatChange;
  }>()
  const saving = fetcher.state !== "idle"

  const [selectedRole, setSelectedRole] = useState<string>("member")
  const [chips, setChips] = useState<EmailChip[]>([])
  const [staleBilling, setStaleBilling] = useState<BillableTeamInviteSeatChange | null>(null)
  const emailInputRef = useRef<EmailChipInputHandle>(null)
  const disclosedNextSeatCountRef = useRef<HTMLInputElement>(null)
  const disclosedAddedSeatCountRef = useRef<HTMLInputElement>(null)

  const roleDescriptions: Record<string, string> = {
    admin: "Full access to everything. Can manage team members, workspaces, and all settings.",
    member: "Can access assigned workspaces — chat, apps, and connections. Cannot manage the team or org settings.",
  }

  const [form, fields] = useForm({
    lastResult: fetcher.data?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: inviteMemberFormSchema })
    },
    defaultValue: {
      emails: [],
      role: "member",
    },
    shouldValidate: "onBlur",
    shouldRevalidate: "onInput",
  })

  const getBillingForInviteCount = useCallback(
    (inviteCount: number) => {
      if (!teamInviteBillingContext || inviteCount === 0) return null
      const nextSeatCount = normalizeSeatCount(
        "team",
        teamInviteBillingContext.occupiedSeatCount + inviteCount,
      )
      const addedSeatCount = Math.max(
        0,
        nextSeatCount - teamInviteBillingContext.coveredSeatCount,
      )
      return {
        coveredSeatCount: teamInviteBillingContext.coveredSeatCount,
        occupiedSeatCount: teamInviteBillingContext.occupiedSeatCount,
        requestedInviteCount: inviteCount,
        nextSeatCount,
        addedSeatCount,
        addedMonthlyAmountCents:
          addedSeatCount * teamInviteBillingContext.unitMonthlyAmountCents,
      } satisfies BillableTeamInviteSeatChange
    },
    [teamInviteBillingContext],
  )
  const requestedInviteCount = chips.filter((chip) => chip.state === "valid").length
  const liveBilling = useMemo(
    () => getBillingForInviteCount(requestedInviteCount),
    [getBillingForInviteCount, requestedInviteCount],
  )
  const visibleBilling = staleBilling ?? liveBilling
  const billingPaused =
    Boolean(
      teamInviteBillingContext &&
        !teamInviteBillingContext.syncable &&
        liveBilling &&
        liveBilling.addedSeatCount > 0,
    )
  const submitDisabled =
    saving ||
    requestedInviteCount === 0 ||
    billingPaused ||
    teamInviteBillingContext === undefined
  const submitLabel =
    requestedInviteCount === 0
      ? "Send invites"
      : requestedInviteCount === 1
        ? "Send invite"
        : `Send ${requestedInviteCount} invites`

  // Handle response
  useLayoutEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        const invitedCount = fetcher.data.invited?.length ?? 0
        const skipped = fetcher.data.skipped ?? []
        const failed = fetcher.data.failed ?? []

        if (failed.length > 0) {
          toast.warning(
            `Created ${invitedCount} ${invitedCount === 1 ? "invitation" : "invitations"}, but ${failed.length} ${failed.length === 1 ? "email could" : "emails could"} not be delivered. You can copy invite links from the team table.`,
            {
              description: failed.map((item) => formatInviteIssue(item.email, item.reason)).join("\n"),
            },
          )
        } else if (invitedCount > 0 && skipped.length > 0) {
          toast.success(`Sent ${invitedCount} ${invitedCount === 1 ? "invite" : "invites"} - ${skipped.length} skipped`, {
            description: skipped.map((item) => formatInviteIssue(item.email, item.reason)).join("\n"),
          })
        } else if (invitedCount > 0) {
          toast.success(`Sent ${invitedCount} ${invitedCount === 1 ? "invite" : "invites"}`)
        } else if (skipped.length > 0) {
          toast.warning(`No invites sent - all ${skipped.length} emails are already members or invited`, {
            description: skipped.map((item) => formatInviteIssue(item.email, item.reason)).join("\n"),
          })
        } else if (fetcher.data.warning) {
          toast.warning(fetcher.data.warning)
        } else {
          toast.success("Invites sent")
        }
        setStaleBilling(null)
        onOpenChange(false)
      } else if (fetcher.data.error) {
        if (fetcher.data.error === "stale_billing_context" && fetcher.data.billing) {
          setStaleBilling(fetcher.data.billing)
          return
        }
        toast.error(fetcher.data.message ?? fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data, onOpenChange])

  useEffect(() => {
    if (fetcher.state === "idle") return
    setStaleBilling(null)
  }, [fetcher.state])

  useEffect(() => {
    if (!staleBilling) return
    if (staleBilling.requestedInviteCount === requestedInviteCount) return
    setStaleBilling(null)
  }, [requestedInviteCount, staleBilling])

  const handleSubmit = () => {
    let committedChips = chips
    flushSync(() => {
      committedChips = emailInputRef.current?.commitPending() ?? chips
    })
    const committedInviteCount = committedChips.filter((chip) => chip.state === "valid").length
    const committedBilling =
      staleBilling?.requestedInviteCount === committedInviteCount
        ? staleBilling
        : getBillingForInviteCount(committedInviteCount)
    if (disclosedNextSeatCountRef.current) {
      disclosedNextSeatCountRef.current.value = String(committedBilling?.nextSeatCount ?? 0)
    }
    if (disclosedAddedSeatCountRef.current) {
      disclosedAddedSeatCountRef.current.value = String(committedBilling?.addedSeatCount ?? 0)
    }
  }

  const billingAlert = (() => {
    if (teamInviteBillingContext === undefined) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Skeleton className="h-16 w-full" />
          </TooltipTrigger>
          <TooltipContent>Loading billing details...</TooltipContent>
        </Tooltip>
      )
    }
    if (!visibleBilling || requestedInviteCount === 0) return null

    if (staleBilling) {
      return (
        <Alert variant="destructive">
          <AlertCircleIcon className="size-4" />
          <AlertTitle>Billing changed since you opened this</AlertTitle>
          <AlertDescription>
            Another admin made a change in the meantime. Sending these invitations would now add{" "}
            {staleBilling.addedSeatCount} {staleBilling.addedSeatCount === 1 ? "seat" : "seats"} for{" "}
            {formatUsdFromCents(staleBilling.addedMonthlyAmountCents)} more per month. Review the updated total, then resend.
          </AlertDescription>
        </Alert>
      )
    }

    if (billingPaused) {
      return (
        <Alert variant="destructive">
          <AlertCircleIcon className="size-4" />
          <AlertTitle>Billing update is paused</AlertTitle>
          <AlertDescription>
            Your subscription needs attention before we can add seats. Resolve billing first.
          </AlertDescription>
          <AlertAction>
            <Button asChild variant="outline" size="sm">
              <a href="/settings/organization/billing">Open billing</a>
            </Button>
          </AlertAction>
        </Alert>
      )
    }

    if (visibleBilling.addedSeatCount === 0) {
      return (
        <Alert>
          <InfoIcon className="size-4" />
          <AlertTitle>No billing change</AlertTitle>
          <AlertDescription>
            {visibleBilling.coveredSeatCount <= (teamInviteBillingContext?.minimumSeats ?? 0)
              ? `Your Team plan already covers these invitations under the ${teamInviteBillingContext?.minimumSeats ?? 0}-seat minimum.`
              : `Your Team plan already covers these invitations within the ${visibleBilling.coveredSeatCount} seats you've already paid for.`}{" "}
            You'll only be charged when invitations exceed the seats you've already paid for.
          </AlertDescription>
        </Alert>
      )
    }

    return (
      <Alert>
        <InfoIcon className="size-4" />
        <AlertTitle>
          Adding {visibleBilling.addedSeatCount} {visibleBilling.addedSeatCount === 1 ? "seat" : "seats"} to your Team plan
        </AlertTitle>
        <AlertDescription>
          Your Team subscription will go from {visibleBilling.coveredSeatCount} to{" "}
          {visibleBilling.nextSeatCount} seats. We'll bill a prorated amount for the rest of your current billing period today, and your future monthly invoices will increase by{" "}
          {formatUsdFromCents(visibleBilling.addedMonthlyAmountCents)}.
        </AlertDescription>
      </Alert>
    )
  })()

  const formContent = (
    <fetcher.Form method="post" {...getFormProps(form)} className="space-y-4" onSubmit={handleSubmit}>
      <input type="hidden" name="intent" value="createInvitation" />
      <input
        ref={disclosedNextSeatCountRef}
        type="hidden"
        name="disclosed_next_seat_count"
        value={visibleBilling?.nextSeatCount ?? 0}
      />
      <input
        ref={disclosedAddedSeatCountRef}
        type="hidden"
        name="disclosed_added_seat_count"
        value={visibleBilling?.addedSeatCount ?? 0}
      />

      <div className="space-y-2">
        <Label id="invite-emails-label" htmlFor="invite-emails">Emails</Label>
        <EmailChipInput
          ref={emailInputRef}
          name="emails"
          inputId="invite-emails"
          labelId="invite-emails-label"
          knownMemberEmails={knownMemberEmails}
          knownInvitedEmails={knownInvitedEmails}
          ariaDescribedBy="email-chip-help"
          disabled={saving}
          onChipsChange={setChips}
        />
        <p id="email-chip-help" className="text-xs text-muted-foreground">
          Press Enter, Tab, comma, or space to add. Paste a list to add many at once.
        </p>
        {fields.emails.errors && fields.emails.errors.length > 0 && (
          <p className="text-sm text-destructive">{fields.emails.errors[0]}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={fields.role.id}>Role</Label>
        <Select
          name={fields.role.name}
          defaultValue={fields.role.initialValue}
          onValueChange={setSelectedRole}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="member">Member</SelectItem>
            {/* TODO: Viewer role (deferred) */}
          </SelectContent>
        </Select>
        {roleDescriptions[selectedRole] ? (
          <p className="text-xs text-muted-foreground">{roleDescriptions[selectedRole]}</p>
        ) : null}
        {fields.role.errors && fields.role.errors.length > 0 && (
          <p className="text-sm text-destructive">{fields.role.errors[0]}</p>
        )}
      </div>

      {billingAlert}

      <div className="hidden md:flex items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled}>
          {saving ? "Sending invites..." : submitLabel}
        </Button>
      </div>
    </fetcher.Form>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>Invite member</SheetTitle>
            <SheetDescription>
              Add someone to your organization and assign a role.
            </SheetDescription>
          </SheetHeader>
          <div className="py-6">{formContent}</div>
          <SheetFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form={form.id} disabled={submitDisabled}>
              {saving ? "Sending invites..." : submitLabel}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            Add someone to your organization and assign a role.
          </DialogDescription>
        </DialogHeader>
        {formContent}
        <DialogFooter className="md:hidden">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={form.id} disabled={submitDisabled}>
            {saving ? "Sending invites..." : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
