# Free-Tier UI Polish — Review Feedback & Fixes (iteration 3)

Review of commit `370ebb711` (implementing `docs/free-tier-ui-polish-plan.md`)
plus the uncommitted working-tree changes. Three fixes to implement, all in
the unlock-premium flow. Everything else landed correctly.

## Review verdict

- **Sidebar Upgrade button** — correct. `SidebarMenuButton` matching Get Help,
  same menu, condition preserved. Done.
- **Plan-picker tab height** — correct. `forceMount` + stacked grid cell as
  specified. Done.
- **Welcome dialog** — the working-tree changes to
  `src/components/camel-free-welcome-dialog.tsx` and
  `src/components/wave-ribbon.tsx` (speed/scale props, italic display text,
  centered copy, camelCode wording) are **user-approved design. Do not modify,
  restyle, or revert these two files** beyond what F-3 below requires
  (behavioral wiring only, no visual changes).
- **Unlock modal** — structure matches the spec; the fixes below refine its
  density and hierarchy per user review.

UI discipline still applies: standard shadcn variants only, no gradients, no
shadows, no custom colors beyond the exact classes written here, no extra
icons.

## F-1: Recommended card — tighter padding, larger title

`src/components/billing/unlock-premium-modal.tsx`.

1. The shadcn `Card` base class includes `py-6`, which stacks with
   `CardContent`'s `p-4` and leaves dead space above and below the card
   content. Zero out the card's own padding and let CardContent own it:

   ```tsx
   <Card className="py-0 ring-2 ring-primary" data-testid="unlock-method-subscribe">
     <CardContent className="flex items-start gap-3 p-4">
   ```

2. "Subscribe" is currently `<p className="font-medium">` (16px) and reads
   smaller than the hero card deserves. Match the paywall plan-card title
   (`CardTitle` in `plan-picker-card.tsx` is `text-lg font-semibold`):

   ```tsx
   <p className="text-lg font-semibold">Subscribe</p>
   ```

   Keep "from $10/mo" as `text-xs text-muted-foreground` beside it.

## F-2: Section tags, breathing room, separator placement

Same file. The two muted uppercase section labels become tag chips, the
sections get more vertical separation, and the separator moves.

1. **Tags.** Replace both section-label `<p>` elements with:

   ```tsx
   <span className="inline-block rounded-none bg-primary/10 px-2 py-1 text-xs font-medium uppercase tracking-wide text-primary">
     Pay through camelAI
   </span>
   ```

   (and `Use what you already pay for` for the second). Square corners are
   intentional — `rounded-none`, so it cannot read as a button. `bg-primary/10
   text-primary` is the primary-CTA hue at low opacity. No border, no icon.

2. **Chunking.** Restructure the modal body into two explicit section blocks
   so the groups breathe:

   ```tsx
   <div className="space-y-6" data-org-id={orgId}>
     <div className="space-y-3">   {/* Pay through camelAI */}
       {tag}
       {recommended card}
       {buy credits row}
     </div>
     <div className="space-y-3">   {/* Use what you already pay for */}
       {tag}
       {openai row}
       <Separator />
       {api key row}
     </div>
   </div>
   ```

3. **Separator.** Delete the current `<Separator />` between the two sections
   (the tags now do that job). Add a `<Separator />` between the
   "Sign in with OpenAI" row and the "Use your own API key" row, as shown
   above.

Target layout:

```
┌────────────────────────────────────────────────────────────┐
│  Unlock premium models                                 ✕   │
│  Camel Free is always included. Premium models like        │
│  {trigger label} need one of these:                        │
│                                                            │
│  ▓PAY THROUGH CAMELAI▓                                     │  ← square tag chip
│   ┌[Recommended]───────────────────────────────────────┐   │
│   │ Subscribe  from $10/mo                  [See plans]│   │  ← text-lg semibold,
│   │ Monthly model credits matching your plan price,    │   │    p-4 only (py-0 Card)
│   │ plus more apps, automations, and storage.          │   │
│   └────────────────────────────────────────────────────┘   │
│  Buy credits                                    [Top up]   │
│  Prepaid, pay as you go. No subscription.                  │
│                                                            │  ← space-y-6 gap
│  ▓USE WHAT YOU ALREADY PAY FOR▓                            │  ← square tag chip
│  Sign in with OpenAI                           [Sign in]   │
│  Use your ChatGPT plan's allowance — no extra cost.        │
│  ────────────────────────────────────────────────────      │  ← Separator (moved)
│  Use your own API key                          [Add key]   │
│  Anthropic, OpenAI, OpenRouter, Bedrock, or a custom       │
│  endpoint.                                                 │
└────────────────────────────────────────────────────────────┘
```

Keep all `data-testid` attributes, the GPT-trigger badge behavior on the
OpenAI row, and the `AdminAction` non-admin fallback exactly as they are.

## F-3: Welcome → unlock modal stacking bug

**Symptom (user report):** from the welcome dialog, clicking
"See premium models" opens the unlock modal stacked on top of the
still-visible welcome dialog and the backdrop goes fully black (two
`bg-black/80` overlays). Happens only on this navigation path.

**Diagnosis.** The dialog-to-dialog hand-off itself is clean — verified in the
`/dev/billing-paywall?state=free` harness (after the click: one overlay, only
the unlock modal mounted). What the harness does NOT have is `Chat.tsx`'s
auto-open effect (~line 859), which is the only code path that can open the
welcome dialog while another dialog is up: it unconditionally calls
`setCamelFreeWelcomeOpen(shouldShowCamelFreeWelcome(...))` on every dependency
change. If it re-fires after the hand-off — dep identity change from a loader
revalidation, or the dismissal write having failed (private-mode storage) so
`shouldShowCamelFreeWelcome` still returns true — the welcome dialog reopens
UNDER the open unlock modal. Stacked overlays, black backdrop.

**Fix: make dialog exclusivity structural.** In `Chat.tsx`, replace the six
independent booleans (`camelFreeWelcomeOpen`, `unlockOpen`, `planUpgradeOpen`,
`topUpOpen`, `byokDialogOpen`, `openAiSignInOpen`) + `unlockTriggerModel` +
`closeBillingDialogs` with a single state so at most one dialog can ever be
open:

```tsx
type BillingDialogState =
  | { kind: "none" }
  | { kind: "welcome" }
  | { kind: "unlock"; triggerModel: LlmModel | null }
  | { kind: "plans" }
  | { kind: "topup" }
  | { kind: "byok" }
  | { kind: "openai" };

const [billingDialog, setBillingDialog] = useState<BillingDialogState>({ kind: "none" });
```

- Each dialog's `open` prop derives from `billingDialog.kind`; each
  `onOpenChange(false)` transitions to `{ kind: "none" }`.
- Write one transition helper and route every open/close through it. It owns
  the welcome-dismissal side effect: whenever the PREVIOUS state was
  `welcome`, call `recordCamelFreeWelcomeDismissal(...)` — this covers ✕,
  ESC, overlay click, "Start building free", AND "See premium models"
  (which transitions `welcome` → `unlock` atomically in one `setState`).
- Auto-open effect: only ever transitions `none` → `welcome`, guarded by a
  `hasAutoOpenedWelcomeRef` that flips true on first open (never auto-open
  twice in a mount, regardless of storage state), and bails when
  `billingDialog.kind !== "none"`. Remove the unconditional
  `setCamelFreeWelcomeOpen(false)` override — closing is user-driven only.
- `isAnyBillingDialogOpen` becomes `billingDialog.kind !== "none"` (the
  `useFreeTierUpgradePrompt` wiring keeps working).
- `openUnlockPremium`, `openPlanUpgrade`, `openBillingTopUp`, `openByokDialog`,
  `openOpenAiSignIn` become thin wrappers over the transition helper
  (`openBillingTopUp` keeps its `creditPacksFetcher.load` side effect).
- Sidebar (`app-sidebar.tsx`) has its own independent `PlanUpgradeDialog`
  instance and is fine as-is — the welcome dialog never renders there.

With this in place there is no state in which two of these dialogs are open,
so a persistent double overlay is impossible from any trigger. The ~100ms
exit/enter crossfade of single dialogs is normal and stays. If the black-stack
still reproduces after this change, the remaining suspect is the Radix exit
animation being interrupted — in that case (and only then), delay the
`welcome → unlock` transition by 150ms (`duration-100` + margin) so the
welcome dialog finishes exiting before the unlock modal mounts.

## Tests

- Update `tests/unlock-premium-modal.test.tsx` for the new structure: tag
  chips present, Subscribe title classes, separator now between the OpenAI
  and API-key rows, testids unchanged.
- Add coverage for the dialog state machine (pure transition helper):
  `welcome → unlock` records dismissal and leaves only unlock open; auto-open
  never fires when a dialog is active; auto-open fires at most once per mount
  even when storage writes fail.
- `bun run typecheck`, `bun run lint`, and the touched test files via
  `bun run test:run`.
