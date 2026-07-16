# Free-Tier UI Polish — Round 2 Feedback (iteration 4)

Follow-up review of the working-tree implementation of
`docs/free-tier-ui-polish-feedback.md`. The dialog state machine
(`src/lib/billing-dialog-state.ts` + Chat wiring) is correct — keep it as is.
Three fixes below; all are small and surgical. No other changes.

## F-1: Restore the state-derived `open` on the welcome dialog before commit

`src/components/Chat.tsx` ~line 4527 has the welcome dialog's `open` prop
hardcoded `true` — a deliberate LOCAL TESTING override (keeps the dialog
visible on every chat while its design is reviewed). It must not ship:
hardcoded, the dialog can never close, so any other billing dialog stacks
on top of it (that stacked state was user-induced, not a bug — the dialog
wiring itself was verified correct).

Before committing, restore:

```tsx
<CamelFreeWelcomeDialog
  open={billingDialog.kind === "welcome"}
  onOpenChange={handleBillingDialogOpenChange}
  onSeePremiumModels={() => openUnlockPremium(null)}
/>
```

and delete the "Temporary styling override" comment.

**Keep the dialog state machine** (`src/lib/billing-dialog-state.ts`, the
Chat.tsx wiring, and `tests/billing-dialog-state.test.ts`). Although the
stacking report that motivated it turned out to be the testing override, the
consolidation is a real improvement: one source of truth instead of six
booleans, at-most-one-dialog-open as a structural invariant across all six
entry points, dismissal recording owned by the transition, and unit coverage.
Do not revert it.

For future design review of the welcome dialog without editing source:
`/dev/billing-paywall?state=free` auto-opens it with the full
welcome → unlock → plans chain wired, and the real first-run flow can be
re-triggered by deleting the `camel-free-welcome-dismissed:{userId}:{orgId}`
localStorage key.

## F-2: "Subscribe" header size

`src/components/billing/unlock-premium-modal.tsx`: the Recommended card title
is currently `text-lg font-semibold`. Make it EXACTLY the same as the
"Buy credits" row title:

```tsx
<p className="text-sm font-medium">Subscribe</p>
```

Update `tests/unlock-premium-modal.test.tsx` if it asserts the old classes.

## F-3: Slightly more space before the second section tag

Same file. The two section blocks sit in a `space-y-6` parent. Add a touch
more separation (~0.2rem; nearest Tailwind step is 0.25rem) between the
"Buy credits" row and the "Use what you already pay for" tag by adding
top padding to the SECOND section block (padding, not margin — `space-y-*`
controls sibling margins and would conflict):

```tsx
<div className="space-y-3 pt-1">   {/* Use what you already pay for */}
```

The first section block is unchanged.
