# Bulk Team Invitations

## Status

May 1, 2026 - Draft v1

## Problem

`/settings/organization/team` only accepts one invite email at a time. The modal currently posts a single `email` field to the route action in [src/routes/_app.settings.organization.team.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_app.settings.organization.team.tsx), and the billing notice is calculated as if exactly one invite will be sent.

That is too limited for team onboarding, and it is also a billing risk if we simply let the client submit a comma-separated string. Team billing counts active members plus active invitations. A bulk invite can cross the Team minimum or current covered seat count by more than one seat, so the UI and server both need to calculate the same billable delta before Stripe is updated.

## Goals

1. Let an admin paste or type multiple email addresses in the `Invite member` modal.
2. Turn only correctly formatted email addresses into email chips.
3. Keep invalid text out of chips and out of submitted invites.
4. Disclose the number of additional Team seats and recurring dollar amount before submission.
5. Recalculate billable seats on the server at submit time and never charge for more seats than the user saw disclosed.
6. Update the Stripe subscription quantity once to the final target seat count, with the correct proration/invoice behavior.
7. Keep single-email invite behavior compatible where practical.

## Non-Goals

- Do not design the chip visuals in this pass.
- Do not change role/workspace-access semantics for invitations.
- Do not add per-invite roles in the same modal. One selected role applies to all emails.
- Do not count invalid or duplicate input as billable.

## Design

The dialog shell, role select, and footer stay as-is. The `<Input type="email">` is replaced by a new `EmailChipInput` component, and the single billing notice is replaced by a state-driven `Alert`. Final visual styling (chip color, padding, motion) is intentionally left to a follow-up styling pass — this section specifies wiring, structure, and behavior only.

### shadcn composition

Reused primitives from [src/components/ui/](/Users/illiana/Projects/chiridion-app/src/components/ui):

- `Dialog` / `Sheet` — modal shell, unchanged. Continues to switch on `useIsMobile()`.
- `Label`, `Select`, `Button`, `Alert` / `AlertTitle` / `AlertDescription` — unchanged usage.
- `Badge` (variant `secondary` by default) — base for each email chip. The chip span carries a `data-state` attribute (`valid` | `already_member` | `already_invited`) and stable class hooks `invite-email-chip` and `invite-email-chip--<state>` so a styling pass can theme without restructuring.
- `Input` styling tokens — the chip-input wrapper reuses the same `border-input`, `focus-within:ring-ring/30`, and `aria-invalid` patterns as [input-group.tsx](/Users/illiana/Projects/chiridion-app/src/components/ui/input-group.tsx) so the field reads as native to our form vocabulary.
- `Tooltip` — long emails truncated in the chip, full address on hover/focus.
- `sonner` `toast` — bulk result summaries (see Result feedback below).
- Lucide `XIcon` — chip remove button.

New file: [src/components/settings/email-chip-input.tsx](/Users/illiana/Projects/chiridion-app/src/components/settings/email-chip-input.tsx). It is invite-specific (depends on `parseInviteEmails`/`inviteEmailSchema`), so it lives under `components/settings`, not `components/ui`. If we later need a generic chip input, it can be promoted.

### ASCII mock — desktop dialog, typing state

```
+--------------------------------------------------------------+
|  Invite members                                          x   |
|  Add people to your organization and assign a role.          |
|                                                              |
|  Emails                                                      |
|  +--------------------------------------------------------+  |
|  | [ ana@acme.com x ] [ ben@acme.com x ]                  |  |
|  | [ cam@acme.com x ]  carl@acme|                         |  |
|  +--------------------------------------------------------+  |
|  Press Enter, Tab, comma, or space to add. Paste a list to   |
|  add many at once.                                           |
|                                                              |
|  Role                                                        |
|  [ Member                                              v ]   |
|  Can access assigned workspaces - chat, apps, computer, ...  |
|                                                              |
|  +--------------------------------------------------------+  |
|  | i  Adding 3 seats to your Team plan                    |  |
|  |    +$30.00 / month. Prorated on today's invoice.       |  |
|  |    Seats go from 5 -> 8.                               |  |
|  +--------------------------------------------------------+  |
|                                                              |
|                          [ Cancel ]  [ Send 3 invites ]      |
+--------------------------------------------------------------+
```

`carl@acme` is *not* a chip — it remains live text at the cursor and only commits once it parses as a valid email. The wrapper grows vertically as chips wrap.

### ASCII mock — empty state

```
+--------------------------------------------------------------+
|  Emails                                                      |
|  +--------------------------------------------------------+  |
|  | Type or paste emails...                                |  |
|  +--------------------------------------------------------+  |
|  ...                                                         |
|                          [ Cancel ]  [ Send invites ] (off)  |
+--------------------------------------------------------------+
```

Submit is disabled when there are zero billable chips. The billing `Alert` is hidden when `requestedInviteCount === 0`.

### ASCII mock — already-member / duplicate annotations

```
|  Emails                                                      |
|  +--------------------------------------------------------+  |
|  | [ ana@acme.com x ] [ ben@acme.com  -already member-  x]|  |
|  | [ cam@acme.com x ]                                     |  |
|  +--------------------------------------------------------+  |
|  ben@acme.com is already a member - it won't be invited or   |
|  counted toward billing.                                     |
```

Already-member and already-invited emails stay as chips so the admin can see they were recognized, but they are de-emphasized via `data-state` and excluded from `requestedInviteCount`. If the same email is committed twice, the second attempt briefly flashes the existing chip's destructive ring (`data-state="duplicate"` for ~600ms) and the input clears — only one chip remains in DOM.

### Billing alert states

The `Alert` body is selected by a small state machine driven by loader-supplied `teamInviteBillingContext` plus the live billable chip count. Submit is gated on these states (see table below).

State A — Free of charge (covered by current plan):

```
| i  No billing change                                         |
|    Your plan already covers these seats.                     |
```

State B — Adds billable seats (default for non-free additions):

```
| i  Adding 3 seats to your Team plan                          |
|    +$30.00 / month. Prorated on today's invoice.             |
|    Seats go from 5 -> 8.                                     |
```

State C — Org is Team but Stripe is not syncable (`past_due`, `paused`, etc.):

```
| !  Billing update is paused                                  |
|    Your subscription needs attention before we can add seats.|
|    Resolve billing first.                       [ Open billing ]
```

State D — Server stale-disclosure rejection (post-submit):

```
| !  Billing changed while you were typing                     |
|    Updated total: +$40.00 / month for 4 new seats.           |
|    Review and resend, or cancel.                             |
```

State E — Non-Team org (no subscription seats to manage): alert is hidden.

| State | Submit | Trigger                                                                                |
| ----- | ------ | -------------------------------------------------------------------------------------- |
| A     | on     | `addedSeatCount === 0` and `requestedInviteCount > 0`                                  |
| B     | on     | `addedSeatCount > 0` and `syncable`                                                    |
| C     | off    | Team plan, `!syncable`                                                                 |
| D     | on     | Server returned stale-disclosure error; alert renders with fresh values                |
| E     | on     | `org.billing_status` is not Team-paid (Free/Starter/Pro/enterprise where N/A)          |

The phrasing "Prorated on today's invoice" must match the Stripe `proration_behavior` chosen in `Stripe And Invoice Behavior`. If we ship `create_prorations` instead of `always_invoice`, swap to "Will appear on your next invoice." Alert copy and Stripe params are wired together by a single helper to prevent drift.

### EmailChipInput component contract

```tsx
interface EmailChipInputProps {
  name: string;                       // hidden inputs render with this name (e.g. "emails")
  inputId: string;                    // for <Label htmlFor>
  defaultValue?: string[];
  knownMemberEmails?: string[];       // from loader, lowercased
  knownInvitedEmails?: string[];      // from loader, lowercased
  maxEmails?: number;                 // default 100
  ariaDescribedBy?: string;
  onChipsChange?: (chips: EmailChip[]) => void;
  disabled?: boolean;
}

interface EmailChip {
  email: string;                                      // normalized, lowercase
  state: "valid" | "already_member" | "already_invited";
}
```

Render structure (Tailwind classes are placeholders — Claude's styling pass can refine):

```tsx
<div
  role="group"
  data-slot="email-chip-input"
  aria-labelledby={labelId}
  aria-invalid={hasInvalidPending || undefined}
  className={cn(
    "border-input bg-input/20 dark:bg-input/30",
    "flex flex-wrap items-center gap-1.5 rounded-md border p-1.5 min-h-9",
    "focus-within:border-ring focus-within:ring-ring/30 focus-within:ring-[2px] transition-colors",
    "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
  )}
  onClick={focusInput}
>
  {chips.map((chip) => (
    <Badge
      key={chip.email}
      variant="secondary"
      data-state={chip.state}
      className={cn(
        "invite-email-chip",
        `invite-email-chip--${chip.state}`,
        "h-auto py-0.5 pl-2 pr-1 gap-1 text-sm",
      )}
    >
      <span className="truncate max-w-[180px]">{chip.email}</span>
      <button
        type="button"
        aria-label={`Remove ${chip.email}`}
        onClick={(e) => { e.stopPropagation(); removeChip(chip.email); }}
        className="rounded-sm p-0.5 hover:bg-foreground/10"
      >
        <XIcon className="size-3" />
      </button>
    </Badge>
  ))}
  <input
    ref={inputRef}
    id={inputId}
    type="text"            // NOT "email" - we accept a stream of comma-separated tokens
    inputMode="email"
    autoCapitalize="off"
    autoCorrect="off"
    spellCheck={false}
    autoComplete="off"
    placeholder={chips.length === 0 ? "Type or paste emails..." : ""}
    aria-describedby={ariaDescribedBy}
    aria-invalid={hasInvalidPending || undefined}
    className="flex-1 min-w-[120px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
    value={pending}
    onChange={onChange}
    onKeyDown={onKeyDown}
    onPaste={onPaste}
    onBlur={commitPending}
    disabled={disabled}
  />
  {/* Submitted to the form action via formData.getAll(name) */}
  {chips
    .filter((c) => c.state === "valid")
    .map((c) => (
      <input key={`hidden-${c.email}`} type="hidden" name={name} value={c.email} />
    ))}
</div>
```

Critical wiring details:

- `data-slot`, `data-state`, and class hooks (`invite-email-chip`, `invite-email-chip--*`) must remain stable — server-side validation, tests, and the styling pass all depend on them.
- Hidden inputs are rendered only for chips with `state === "valid"`. Already-member and already-invited chips are visual-only and never submitted, matching the seat calculation rules.
- The pending raw input is **never** submitted; if the user has un-committed text on submit, run `commitPending()` synchronously inside the form's `onSubmit` before submission so a trailing valid email isn't lost.

### Keyboard model

| Key                    | Action                                                                            |
| ---------------------- | --------------------------------------------------------------------------------- |
| Enter                  | Commit pending input. Prevent form submit when input is non-empty.                |
| `,` `;`                | Commit pending input.                                                             |
| Space                  | Commit pending input (only if pending parses as a valid email; otherwise insert). |
| Tab                    | Commit pending input, then move focus normally.                                   |
| Backspace (empty input)| First press selects last chip (`data-selected="true"`); second press removes it.  |
| ArrowLeft / ArrowRight | When input is empty, move focus through chip remove buttons.                     |
| Click chip `x`         | Remove that chip.                                                                 |
| Paste                  | Always commits all tokenized addresses; never lands as raw text.                  |
| Escape                 | Do not swallow — let `Dialog`/`Sheet` close as today.                             |

### Accessibility

- Container is `role="group"` with `aria-labelledby` pointing at the `<Label>`'s id; the inner `<input>` keeps the `id` so `<Label htmlFor>` still focuses it.
- Chips are spans (out of tab order); the remove control is a `<button>` with `aria-label="Remove <email>"`.
- A visually hidden live region (`aria-live="polite"`) inside the dialog announces:
  - "1 email added" / "3 emails added" after each commit batch.
  - "<token> is not a valid email address" when a commit rejects a token.
  - "<email> is already a member" when classification finds an existing member/invitation.
- The helper text ("Press Enter, Tab, comma, or space to add...") sits in `<p id="email-chip-help">` and is referenced from the input via `aria-describedby`.
- The billing `Alert` re-renders on each chip change; that natively announces via `Alert`'s role, but debounce announcements at ~400ms so rapid typing doesn't spam screen readers.
- Maintain WCAG focus-visible rings on chips' remove buttons, the input, and the alert action button.

### Submit button copy

Driven by valid chip count:

- 0 chips: `Send invites` (disabled).
- 1 chip: `Send invite`.
- N chips: `Send N invites`.

While `fetcher.state !== "idle"`: `Sending invites...`, both the button and chip input are disabled, and chip remove buttons hide.

### Result feedback

After submit, the route action returns the `BulkInviteResult` defined in `Form Contract`. The modal then:

- All success, none skipped: `toast.success("Sent N invites")`, close modal.
- Mixed: `toast.success("Sent N invites - M skipped")` with a description listing skipped emails grouped by reason; close modal.
- All skipped (already member/invited, no `new`): `toast.warning("No invites sent - all N emails are already members or invited")`, close modal.
- Partial failure (created invitations but some emails couldn't be sent via `Promise.allSettled`): `toast.warning("Sent N invites; M emails couldn't be delivered")`, keep modal open and re-render those chips with `data-state="failed"` so the admin can copy them.
- Stale-disclosure rejection: do not close; switch billing alert to State D using fresh values returned in the error payload.
- Stripe failure (paid expansion blocked): `toast.error("Couldn't update billing - no invites were created")`, keep modal open, alert switches to State C-style copy quoting the Stripe error code if safe to surface.

### Mobile (Sheet) parity

`Sheet` rendering uses the same `EmailChipInput` and `Alert`. Considerations:

- Chip max-width 180px with truncation; long emails reveal in `Tooltip` on long-press.
- Keyboard space: keep `SheetFooter` sticky; the chip input wrapper grows but caps at ~40vh and scrolls internally beyond that.
- `inputMode="email"` keeps `,` `@` `.` visible on the iOS keyboard; do not use `type="email"` on the inner input or iOS will reject commas.
- Fingertip target on chip `x` is 28x28 minimum; if the existing `size-3` icon falls short, wrap with a `p-1.5` hit area.

### Loading skeleton for billing context

If `teamInviteBillingContext` is `undefined` while the loader is in flight (rare, since the page is already loaded — but possible after a programmatic refresh), render a `Skeleton` block matching the alert's height to avoid layout shift, and disable submit with a `Tooltip`: "Loading billing details...".

### Scope notes for the styling pass

These remain explicitly open for a follow-up styling task:

- Chip color tokens for `valid`, `already_member`, `already_invited`, `duplicate`, `failed`.
- Whether to show avatars/initials inside chips (default: text-only in v1).
- Motion (duplicate-flash animation, chip enter/exit transitions).
- Whether the alert uses a colored variant or stays neutral; whether State C uses `destructive` styling.

The hooks above (`data-state`, `data-slot`, class names, `aria-invalid`) are the styling contract — keep them stable when restyling.

## Current Relevant Code

- [src/components/settings/invite-member-dialog.tsx](/Users/illiana/Projects/chiridion-app/src/components/settings/invite-member-dialog.tsx) renders the modal, Conform form, single `<Input type="email">`, and single-invite seat notice.
- [src/routes/_app.settings.organization.team.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_app.settings.organization.team.tsx) handles `intent=createInvitation`, validates `email.includes("@")`, creates one invitation, best-effort syncs Team subscription seats, then sends one invite email.
- [src/lib/schemas.ts](/Users/illiana/Projects/chiridion-app/src/lib/schemas.ts) defines `inviteMemberFormSchema` with one `email`.
- [src/lib/billing-plans.ts](/Users/illiana/Projects/chiridion-app/src/lib/billing-plans.ts) has `getBillableTeamInviteSeatChange(org, occupiedSeatCount)`, which assumes one additional invite.
- [src/lib/billing.server.ts](/Users/illiana/Projects/chiridion-app/src/lib/billing.server.ts) has `getBillableTeamSeatCountForOrg()` and `syncTeamSubscriptionSeatCount()`, which count active members plus non-expired invitations and update the Stripe subscription item quantity.
- [workers/main/src/auth.ts](/Users/illiana/Projects/chiridion-app/workers/main/src/auth.ts) enforces seat capacity inside `OrgDO.createInvitation()`. Today it allows one pending billable Team invite while Stripe sync catches up.

## Email Detection And Validation

Add a small shared helper, likely `src/lib/invite-emails.ts`, that owns all parsing and normalization. Both the modal and the route action should use it so client chips and server validation cannot drift.

Recommended API:

```ts
export interface ParsedInviteEmails {
  emails: string[];
  rejectedTokens: string[];
}

export function parseInviteEmails(raw: string): ParsedInviteEmails;
export function normalizeInviteEmail(value: string): string | null;
```

Implementation details:

- Split on paste/commit delimiters: comma, semicolon, newline, tab, and whitespace.
- Trim each token and strip only harmless wrapping characters such as `<` and `>` when the whole token is wrapped.
- Validate with the same Zod email rule used by `inviteMemberFormSchema`, moved into a shared `inviteEmailSchema`.
- Normalize valid emails to lowercase.
- Deduplicate valid emails case-insensitively while preserving first-seen order.
- Return invalid tokens separately. Invalid tokens remain raw input or validation text; they are never converted to chips and never included in the hidden submitted email list.
- Treat Enter, comma, semicolon, blur, and paste as commit events in the modal. On each commit, parse the pending input and append only newly valid normalized emails.
- Do not run arbitrary substring extraction from prose. For example, `"email me at a@example.com"` should not chip the address unless the user pasted a delimited token that is itself a valid email. This avoids surprising false positives.

Chip state should be encoded as data, not visual design:

```ts
type InviteEmailChipState = "valid" | "duplicate";

interface InviteEmailChipModel {
  email: string;
  state: InviteEmailChipState;
  className: string;
}
```

- Use `state: "valid"` for emails that will be submitted.
- Use `state: "duplicate"` only for transient UI feedback if we decide to show duplicate attempts; duplicate emails should not be submitted twice.
- Map the state to stable class hooks such as `invite-email-chip` and `invite-email-chip--valid`. Claude can define the final appearance.
- Put `aria-invalid` or an invalid-state class on the text input when the pending raw input contains non-empty rejected tokens, but do not chip those tokens.

## Form Contract

Change the form from a single `email` field to a submitted email array.

Recommended shape:

```ts
const inviteMemberFormSchema = z.object({
  emails: z.array(inviteEmailSchema).min(1).max(100),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
});
```

Practical submit options:

- Preferred: render one hidden input per email as `name="emails"` and use `formData.getAll("emails")` in the action.
- Accept a legacy `email` field for one release so older client code or tests do not break.
- Keep `intent=createInvitation` if we want the route action name to stay stable, or introduce `intent=createInvitations` and leave the old single path as a compatibility wrapper.

Server validation requirements:

- Parse and normalize the submitted array again on the server.
- Reject if there are no valid emails after parsing.
- Reject `role="owner"` as today.
- Enforce a reasonable max batch size, for example 100 emails, to limit email delivery and Stripe side effects.
- Return structured results:

```ts
type BulkInviteResult = {
  success: boolean;
  invited: Array<{ email: string; invitation_id: string }>;
  skipped: Array<{ email: string; reason: "already_member" | "already_invited" | "duplicate" }>;
  failed: Array<{ email: string; reason: string }>;
  billing?: BulkInviteBillingResult;
};
```

## Seat Calculation

Replace the one-invite helper with a count-aware helper:

```ts
export interface BillableTeamInviteSeatChange {
  coveredSeatCount: number;
  occupiedSeatCount: number;
  requestedInviteCount: number;
  nextSeatCount: number;
  addedSeatCount: number;
  addedMonthlyAmountCents: number;
}

export function getBillableTeamInviteSeatChangeForCount(
  org: TeamBillingOrgSnapshot,
  occupiedSeatCount: number,
  requestedInviteCount: number,
): BillableTeamInviteSeatChange | null;
```

Logic:

- If the org is not Team or the Stripe subscription is not in a syncable status, return `null`.
- `coveredSeatCount = getOrgSeatCount(org)`.
- `nextSeatCount = normalizeSeatCount("team", occupiedSeatCount + requestedInviteCount)`.
- `addedSeatCount = Math.max(0, nextSeatCount - coveredSeatCount)`.
- `addedMonthlyAmountCents = addedSeatCount * BILLING_PLAN_LIMITS.team.monthlyPriceCents`.
- Return `null` when `addedSeatCount === 0`.

The loader should pass billing context to the modal instead of a precomputed one-seat notice:

```ts
teamInviteBillingContext: {
  occupiedSeatCount: members.length + activeInvitations.length;
  coveredSeatCount: getOrgSeatCount(org);
  unitMonthlyAmountCents: BILLING_PLAN_LIMITS.team.monthlyPriceCents;
  minimumSeats: getMinimumSeats("team");
  syncable: isTeamSeatBillingSyncable(org);
}
```

The modal uses that context plus the current chip count to show a live alert:

- `requestedInviteCount` should count only valid, deduped emails that are not known existing members or known active invitations from loader data.
- `addedSeatCount` is the number of seats newly added to the plan.
- `addedMonthlyAmountCents` is the recurring monthly increase before taxes/discounts and separate from Stripe proration timing.

The server remains the source of truth. On submit, recompute from fresh DO state and the final deduped new-invite list. Include the client-disclosed `nextSeatCount` and `addedSeatCount` as hidden fields. If the fresh server calculation would charge more seats than the client disclosed, reject with a stale-billing-context error and let the loader refresh the alert.

## Existing Members, Existing Invitations, And Dedupe

Before billing and invitation creation, classify submitted emails:

- `duplicate`: repeated in the submitted batch after case-insensitive normalization.
- `already_member`: an active org member already has this email.
- `already_invited`: a non-expired invitation already exists for this email.
- `new`: should create a new invitation and may require a billable reserved seat.

Only `new` emails count toward `requestedInviteCount` for billing. This prevents over-disclosing and overcharging when the admin pastes a list containing people already in the org or already invited.

Add helper methods if needed:

- `OrgDO.getMemberEmails()` or extend `getOrgMembersWithWorkspaceAccess()` results already available to the route.
- `OrgDO.getActiveInvitationEmails()` or filter `getInvitations()` by `expires_at > Date.now()`.

## Bulk Invitation Creation

Do not create invitations by blindly looping the current `createInvitation()` path without adjusting billing first. `OrgDO.createInvitation()` currently allows only one pending billable Team invite while Stripe sync catches up, so a bulk batch crossing the current seat count by more than one seat will fail partway through.

Recommended route flow:

1. Validate and normalize submitted emails.
2. Load fresh org info, member emails, and active invitations from `OrgDO`.
3. Classify the submitted emails into skipped and new.
4. Compute fresh `BillableTeamInviteSeatChange` for the `new` count.
5. If the fresh result is greater than the client-disclosed result, return an error that forces the modal to refresh its billing alert.
6. If the org is Team, syncable, and `addedSeatCount > 0`, call strict `syncTeamSubscriptionSeatCount(env, orgId, { pendingReservedSeatDelta: new.length })` before creating invitations. Do not use the current best-effort path for paid seat expansion because invite creation would otherwise succeed even if Stripe failed.
7. Create all new invitations in one DO method such as `createInvitations(emails, role, invitedBy)`. The method should insert all rows or none, and it should use a pending billing allowance equal to the batch size already approved by the route.
8. Run a final `syncTeamSubscriptionSeatCount(env, orgId)` after creation. It should usually no-op, but it corrects the subscription quantity if any race or skip changed the final active invitation count.
9. Send invitation emails for created invitations with `Promise.allSettled()`.
10. Return invited/skipped/failed counts to the modal and show a toast summary.

If Stripe sync succeeds but DO insertion fails, immediately run final seat sync in a `catch`/`finally` path so Stripe quantity returns to the actual member-plus-invitation count.

## Stripe And Invoice Behavior

The Stripe update must happen once per submitted batch and target the final seat count, not once per email.

Current `syncTeamSubscriptionSeatCount()` already:

- Fetches the subscription.
- Locates the configured Team price item.
- Updates `/subscription_items/{item.id}` with `quantity` and `proration_behavior=create_prorations`.
- Updates subscription metadata with `billing_plan`, `seat_count`, and included-credit cents.
- Updates local `billing_seat_count` only after Stripe calls succeed.

Updates needed:

- Add an option for seat expansion sync to use the invoice behavior we want for adding paid seats. If we want Stripe to issue the proration invoice immediately, set the subscription item update to `proration_behavior=always_invoice`. If we want the amount to appear on the next invoice, keep `create_prorations` and describe the alert accordingly.
- Add tests that lock the chosen behavior. The user-facing copy and Stripe parameter must agree.
- Keep local `billing_seat_count` unchanged if Stripe update fails.
- Use an idempotency key for the subscription item update, based on org id, target seat count, and a batch id generated by the route. This protects against duplicate charges/retries.
- Ensure `invoice.payment_succeeded` for subscription-update invoices does not grant included credits. Existing tests already cover this; keep them green.

For exact money disclosure:

- The modal can calculate the recurring monthly increase from `addedSeatCount * Team monthlyPriceCents`.
- Exact prorated invoice amount can differ because of billing cycle timing, coupons, tax, or customer balance. If exact invoice dollars are required in the modal, add a server endpoint that asks Stripe for an upcoming invoice preview for the target quantity before submit. Do not try to estimate prorations on the client.

## Tests

Add or update:

- `tests/invite-emails.test.ts`
  - comma, semicolon, newline, tab, and whitespace tokenization
  - lowercase normalization
  - duplicate removal
  - invalid tokens are rejected and not returned as emails
  - wrapped `<name@example.com>` is accepted if we implement wrapping support
- `tests/billing-plans.test.ts`
  - `requestedInviteCount=0` returns null
  - Team minimum covers a batch
  - batch crossing from 3 to 6 seats returns `addedSeatCount=3`
  - already covered subscription seats return null
  - unpaid Stripe subscription returns null
  - `addedMonthlyAmountCents` matches Team unit price times added seats
- `tests/invite-member-dialog.test.tsx`
  - valid pasted emails render as chip models / chip elements
  - invalid text does not render as chips
  - duplicate valid emails are submitted once
  - billing alert updates as chip count changes
- route/action test for `_app.settings.organization.team`
  - bulk submit creates multiple invitations
  - already-member and already-invited emails are skipped and do not count as billable
  - stale client billing disclosure rejects when server would charge more seats
  - Stripe failure prevents paid over-seat invitation creation
- `workers/main/tests/team-org-features.test.ts`
  - DO batch creation reserves multiple seats after preflight sync
  - batch insertion is all-or-nothing
- `tests/billing.test.ts`
  - batch sync updates Stripe subscription item to one final quantity
  - chosen `proration_behavior` / invoice behavior is asserted
  - idempotency key is sent on the subscription item update
  - local `billing_seat_count` is not updated when Stripe fails

Recommended commands:

```bash
bun run test:run tests/invite-emails.test.ts tests/billing-plans.test.ts tests/invite-member-dialog.test.tsx tests/billing.test.ts
bun run test:workers -- workers/main/tests/team-org-features.test.ts
bun run typecheck
```

## Rollout Steps

1. Add shared email normalization/parsing helper and tests.
2. Add count-aware billing helper and tests.
3. Change loader data from one-seat notice to billing context and member/invitation email snapshots needed for client-side skipped-count estimates.
4. Add `src/components/settings/email-chip-input.tsx` per the Design section, then replace the modal's single email input with it. Wire hidden `name="emails"` inputs (valid chips only), live billing alert state machine, and submit button copy that reflects chip count.
5. Add route action bulk validation, stale-disclosure guard, classification, strict Stripe preflight sync, batch invitation creation, final sync, and structured result.
6. Add `OrgDO.createInvitations()` or equivalent batch-safe method.
7. Update Stripe sync invoice behavior and idempotency handling, then lock it with tests.
8. Update toasts and copy for invited/skipped/failed summaries.
9. Run focused tests and typecheck.

## Open Questions

- Should adding seats issue an immediate prorated invoice (`always_invoice`) or create prorations for the next invoice (`create_prorations`)? The alert copy must match this.
- Is the batch size cap 100, or should it be lower for email deliverability and support load?
- Should an already-invited email resend the invite email, show as skipped, or offer a separate "resend" action?
- Do we want exact Stripe upcoming-invoice preview amounts in the modal, or is recurring monthly increase enough for this iteration?
