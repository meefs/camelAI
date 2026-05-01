"use client"

import * as React from "react"
import { XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  normalizeInviteEmail,
  parseInviteEmails,
  MAX_INVITE_EMAILS,
} from "@/lib/invite-emails"
import { inviteReasonCopy } from "@/lib/invite-reason-copy"

export type EmailChipState =
  | "valid"
  | "already_member"
  | "already_invited"

export interface EmailChip {
  email: string
  state: EmailChipState
}

export interface EmailChipInputHandle {
  commitPending: () => EmailChip[]
}

interface EmailChipInputProps {
  name: string
  inputId: string
  labelId: string
  defaultValue?: string[]
  knownMemberEmails?: string[]
  knownInvitedEmails?: string[]
  maxEmails?: number
  ariaDescribedBy?: string
  onChipsChange?: (chips: EmailChip[]) => void
  disabled?: boolean
}

function normalizeEmailList(values: string[] | undefined) {
  return new Set((values ?? []).map((value) => value.toLowerCase().trim()).filter(Boolean))
}

export const EmailChipInput = React.forwardRef<
  EmailChipInputHandle,
  EmailChipInputProps
>(function EmailChipInput(
  {
    name,
    inputId,
    labelId,
    defaultValue,
    knownMemberEmails,
    knownInvitedEmails,
    maxEmails = MAX_INVITE_EMAILS,
    ariaDescribedBy,
    onChipsChange,
    disabled = false,
  },
  ref,
) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [pending, setPending] = React.useState("")
  const initialChips = React.useMemo(
    () =>
      (defaultValue ?? [])
      .map((email) => normalizeInviteEmail(email))
      .filter((email): email is string => Boolean(email))
      .slice(0, maxEmails)
      .map((email) => ({ email, state: "valid" as const })),
    [defaultValue, maxEmails],
  )
  const [chips, setChips] = React.useState<EmailChip[]>(initialChips)
  const chipsRef = React.useRef<EmailChip[]>(initialChips)
  const [invalidTokens, setInvalidTokens] = React.useState<string[]>([])
  const [duplicateEmail, setDuplicateEmail] = React.useState<string | null>(null)
  const [selectedEmail, setSelectedEmail] = React.useState<string | null>(null)
  const [announcement, setAnnouncement] = React.useState("")

  const memberEmailSet = React.useMemo(
    () => normalizeEmailList(knownMemberEmails),
    [knownMemberEmails],
  )
  const invitedEmailSet = React.useMemo(
    () => normalizeEmailList(knownInvitedEmails),
    [knownInvitedEmails],
  )
  const classifyEmail = React.useCallback(
    (email: string): EmailChipState => {
      if (memberEmailSet.has(email)) return "already_member"
      if (invitedEmailSet.has(email)) return "already_invited"
      return "valid"
    },
    [invitedEmailSet, memberEmailSet],
  )

  React.useEffect(() => {
    setChips((current) => {
      let changed = false
      const next = current.map((chip) => {
        const nextState = classifyEmail(chip.email)
        if (chip.state === nextState) return chip
        changed = true
        return { ...chip, state: nextState }
      })
      if (changed) chipsRef.current = next
      return changed ? next : current
    })
  }, [classifyEmail])

  React.useEffect(() => {
    onChipsChange?.(chips)
  }, [chips, onChipsChange])

  React.useEffect(() => {
    if (!duplicateEmail) return
    const timeout = window.setTimeout(() => setDuplicateEmail(null), 600)
    return () => window.clearTimeout(timeout)
  }, [duplicateEmail])

  const focusInput = React.useCallback(() => {
    inputRef.current?.focus()
  }, [])

  const removeChip = React.useCallback((email: string) => {
    const next = chipsRef.current.filter((chip) => chip.email !== email)
    chipsRef.current = next
    setChips(next)
    setSelectedEmail(null)
  }, [])

  const addEmails = React.useCallback(
    (emails: string[]) => {
      if (emails.length === 0) {
        return { chips: chipsRef.current, addedCount: 0, duplicateEmails: [] }
      }
      const current = chipsRef.current
      const existing = new Set(current.map((chip) => chip.email))
      const nextChips: EmailChip[] = []
      const duplicateEmails: string[] = []

      for (const email of emails) {
        if (existing.has(email)) {
          setDuplicateEmail(email)
          duplicateEmails.push(email)
          continue
        }
        if (current.length + nextChips.length >= maxEmails) break
        existing.add(email)
        nextChips.push({ email, state: classifyEmail(email) })
      }

      if (nextChips.length > 0) {
        const next = [...current, ...nextChips]
        chipsRef.current = next
        setChips(next)
        return {
          chips: next,
          addedCount: nextChips.length,
          duplicateEmails,
        }
      }

      return { chips: current, addedCount: 0, duplicateEmails }
    },
    [classifyEmail, maxEmails],
  )

  const commitValue = React.useCallback(
    (value: string, options: { keepRejectedText?: boolean } = {}) => {
      const parsed = parseInviteEmails(value)
      const {
        chips: nextChips,
        addedCount,
        duplicateEmails,
      } = addEmails(parsed.emails)
      setInvalidTokens(parsed.rejectedTokens)
      setSelectedEmail(null)

      if (parsed.rejectedTokens.length > 0) {
        setAnnouncement(`${parsed.rejectedTokens[0]} is not a valid email address`)
      } else if (duplicateEmails.length > 0) {
        setAnnouncement(`${duplicateEmails[0]}: ${inviteReasonCopy("duplicate")}`)
      } else if (addedCount === 1) {
        setAnnouncement("1 email added")
      } else if (addedCount > 1) {
        setAnnouncement(`${addedCount} emails added`)
      }

      if (parsed.emails.some((email) => memberEmailSet.has(email))) {
        const email = parsed.emails.find((value) => memberEmailSet.has(value))
        if (email) setAnnouncement(`${email}: ${inviteReasonCopy("already_member")}`)
      } else if (parsed.emails.some((email) => invitedEmailSet.has(email))) {
        const email = parsed.emails.find((value) => invitedEmailSet.has(value))
        if (email) setAnnouncement(`${email}: ${inviteReasonCopy("already_invited")}`)
      }

      setPending(
        options.keepRejectedText && parsed.rejectedTokens.length > 0
          ? parsed.rejectedTokens.join(" ")
          : "",
      )
      return nextChips
    },
    [addEmails, invitedEmailSet, memberEmailSet],
  )

  const commitPending = React.useCallback(() => {
    if (!pending.trim()) return chipsRef.current
    return commitValue(pending, { keepRejectedText: true })
  }, [commitValue, pending])

  React.useImperativeHandle(ref, () => ({ commitPending }), [commitPending])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") return

    if (event.key === "Enter") {
      if (pending.trim()) {
        event.preventDefault()
        commitPending()
      }
      return
    }

    if (event.key === "," || event.key === ";") {
      event.preventDefault()
      commitPending()
      return
    }

    if (event.key === "Tab") {
      commitPending()
      return
    }

    if (event.key === " ") {
      if (normalizeInviteEmail(pending)) {
        event.preventDefault()
        commitPending()
      }
      return
    }

    if (event.key === "Backspace" && !pending && chips.length > 0) {
      const last = chips[chips.length - 1]
      if (selectedEmail === last.email) {
        event.preventDefault()
        removeChip(last.email)
      } else {
        event.preventDefault()
        setSelectedEmail(last.email)
      }
      return
    }

    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !pending) {
      const buttons = Array.from(
        event.currentTarget
          .closest('[data-slot="email-chip-input"]')
          ?.querySelectorAll<HTMLButtonElement>('[data-slot="email-chip-remove"]') ?? [],
      )
      if (buttons.length > 0) {
        event.preventDefault()
        const target = event.key === "ArrowLeft" ? buttons[buttons.length - 1] : buttons[0]
        target.focus()
      }
    }
  }

  const hasInvalidPending = invalidTokens.length > 0 && pending.trim().length > 0

  return (
    <div
      role="group"
      data-slot="email-chip-input"
      aria-labelledby={labelId}
      aria-invalid={hasInvalidPending || undefined}
      className={cn(
        "border-input bg-input/20 dark:bg-input/30",
        "flex max-h-[40vh] min-h-9 flex-wrap items-center gap-1.5 overflow-y-auto rounded-md border p-1.5",
        "focus-within:border-ring focus-within:ring-ring/30 focus-within:ring-[2px] transition-colors",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
      )}
      onClick={focusInput}
    >
      {chips.map((chip) => {
        const state = duplicateEmail === chip.email ? "duplicate" : chip.state
        const chipBadge = (
          <Badge
            variant="secondary"
            data-state={state}
            data-selected={selectedEmail === chip.email ? "true" : undefined}
            className={cn(
              "invite-email-chip",
              `invite-email-chip--${state}`,
              "h-auto max-w-full gap-1 rounded-md py-0.5 pl-2 pr-1 text-sm",
              state === "duplicate" && "ring-destructive ring-2",
              chip.state !== "valid" && "opacity-70",
            )}
          >
            <span className="max-w-[180px] truncate">{chip.email}</span>
            {!disabled ? (
              <button
                type="button"
                data-slot="email-chip-remove"
                aria-label={`Remove ${chip.email}`}
                onClick={(event) => {
                  event.stopPropagation()
                  removeChip(chip.email)
                }}
                className="rounded-sm p-1.5 hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </Badge>
        )

        if (chip.email.length <= 24) {
          return <React.Fragment key={chip.email}>{chipBadge}</React.Fragment>
        }

        return (
          <Tooltip key={chip.email}>
            <TooltipTrigger asChild>
              {chipBadge}
            </TooltipTrigger>
            <TooltipContent>{chip.email}</TooltipContent>
          </Tooltip>
        )
      })}
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        inputMode="email"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        placeholder={chips.length === 0 ? "Type or paste emails..." : ""}
        aria-describedby={ariaDescribedBy}
        aria-invalid={hasInvalidPending || undefined}
        className="min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        value={pending}
        onChange={(event) => {
          setPending(event.target.value)
          if (invalidTokens.length > 0) setInvalidTokens([])
          setSelectedEmail(null)
        }}
        onKeyDown={handleKeyDown}
        onPaste={(event) => {
          event.preventDefault()
          commitValue(event.clipboardData.getData("text/plain"))
        }}
        onBlur={commitPending}
        disabled={disabled}
      />
      {chips
        .filter((chip) => chip.state === "valid")
        .map((chip) => (
          <input key={`hidden-${chip.email}`} type="hidden" name={name} value={chip.email} />
        ))}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
})
