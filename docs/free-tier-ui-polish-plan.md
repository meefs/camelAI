# Free-Tier UI Polish — Implementation Spec (iteration 2)

Four UI changes to the shipped free-tier onboarding surfaces
(`docs/free-tier-onboarding-paywall-plan.md` was iteration 1):

1. Sidebar "Upgrade" button → use the standard sidebar menu button (match
   "Get Help").
2. "You're on Camel Free" inline card → a polished one-time welcome **modal**
   with an animated X-wave art band.
3. "Unlock premium models" modal → restructured with a highlighted
   Recommended card and low-profile alternative rows, grouped by
   "pay through camelAI" vs "use what you already pay for".
4. Plan picker (paywall/upgrade dialog) → constant height across the
   Individual/Team tab toggle.

No backend, routing, or behavior-logic changes beyond what is written here.
All dialogs keep their existing open/close wiring, callbacks, and analytics.

## UI discipline — read first

Every visual decision in this spec is final and complete. Implement exactly
what is written; if something seems missing, it is intentionally absent.

- Use the existing shadcn primitives with their **standard variants only**:
  `Button` (`default` / `outline` / `ghost` / `link`, standard sizes),
  `Dialog*`, `Card`, `Badge`, `Separator`, `SidebarMenu*`, `Tabs*`.
- Do NOT add: custom colors, gradients, box shadows, border-radius overrides,
  font-size/weight combinations not written here, animations/transitions
  (the wave canvas is the one exception, and it is ported code), emoji, or
  extra icons.
- Do NOT restyle a standard component with one-off classes when a variant
  exists. The only allowed arbitrary values are the ones written in this
  spec (e.g. `h-36`, `min-h-*` are NOT used anywhere here).
- Typography: the display font is used exactly twice in this spec, via the
  existing pattern `font-[family-name:var(--font-display)]` (already used in
  `plan-picker.tsx` and `plan-picker-card.tsx`). Nowhere else.

## WI-1: Sidebar Upgrade button matches Get Help

`src/components/sidebar/app-sidebar.tsx` (~lines 306–329). Today the Upgrade
control is a custom `Button variant="outline" size="sm"` with hand-rolled
collapsed-mode classes. Replace it with the exact same primitive as Get Help:
a `SidebarMenuItem` + `SidebarMenuButton` in the SAME `SidebarMenu` as
Get Help, placed ABOVE the Get Help item. Keep the existing
`billingAccessMode === "camel_free" && isOrgAdmin` condition and the
`openPlanUpgrade` handler. Delete the old Button and its classes.

```tsx
<SidebarMenu>
  {billingAccessMode === "camel_free" && isOrgAdmin ? (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip="Upgrade" onClick={openPlanUpgrade}>
        <Sparkles />
        <span>Upgrade</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  ) : null}
  <SidebarMenuItem>
    <SidebarMenuButton tooltip="Get Help" onClick={() => setHelpOpen(true)}>
      <CircleHelp />
      <span>Get Help</span>
    </SidebarMenuButton>
  </SidebarMenuItem>
</SidebarMenu>
```

Collapsed icon-rail behavior (icon + tooltip) now comes from the primitive —
no custom classes.

```
├──────────────────────────┤
│  ✦  Upgrade              │   ← SidebarMenuButton (free-mode admins only)
│  ?  Get Help             │   ← unchanged
│  ◯  nav user             │
└──────────────────────────┘
```

## WI-2: Camel Free welcome modal

Replaces the inline `CamelFreeWelcomeCard`. This is a new user's very first
interaction after signup — the bar is "premium and calm", achieved with the
existing design system plus one ported art component. No gradients.

### 2a. Port the wave ribbon

Copy `/Users/illiana/Projects/camelai-salessite/app/components/wave-ribbon.tsx`
into `src/components/wave-ribbon.tsx` with two adaptations, otherwise keep the
code identical (it is an animated canvas of small × marks along a wandering
band, monochrome at 0.12 alpha, filling its parent):

1. Dark detection: the sales site uses a `useDarkMode` hook that does not
   exist here. Use `next-themes` (already the app's theme system):
   `const { resolvedTheme } = useTheme(); const isDark = resolvedTheme === "dark";`
2. Reduced motion: if `window.matchMedia("(prefers-reduced-motion: reduce)").matches`,
   render one static frame (call `renderFrame(0)` after resize) and skip the
   `requestAnimationFrame` loop.

### 2b. The dialog

New file `src/components/camel-free-welcome-dialog.tsx`. Delete
`src/components/camel-free-welcome-card.tsx`, the `freeWelcomeCard` prop on
`src/components/welcome-screen/index.tsx` (lines 75, 210, 295), its wiring in
`src/components/Chat.tsx` (~line 4460), and its usage in
`src/routes/dev.billing-paywall.tsx` (replace with the dialog there too).

```
┌──────────────────────────────────────────────────────────┐
│ ˟  ˟ ˟   ˟˟ ˟  ˟ ˟   ˟ ˟˟  ˟  ˟ ˟ ˟˟ ˟   ˟ ˟         ✕  │
│   ˟ ˟ ˟˟      Let's build something      ˟ ˟˟ ˟          │  ← art band: WaveRibbon
│ ˟˟ ˟  ˟ ˟ ˟ ˟   ˟ ˟ ˟ ˟˟   ˟  ˟ ˟ ˟ ˟˟  ˟ ˟ ˟ ˟          │    canvas + display font
├──────────────────────────────────────────────────────────┤
│  You're on Camel Free                                    │  ← DialogTitle
│  Great for experimenting, simple projects, and quick     │  ← DialogDescription
│  tweaks. It's shared with other free users, so replies   │
│  can slow down at busy times. Premium models (Claude,    │
│  GPT) are one click away whenever you want more.         │
│                                                          │
│              [ See premium models ] [ Start building free ] │
│                                                          │
│      You can switch models anytime from the composer.    │  ← text-xs muted, centered
└──────────────────────────────────────────────────────────┘
```

Exact structure:

- `Dialog` → `DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg"`.
  The built-in close (✕) stays; it sits over the art band, which is fine.
- Art band: `<div className="relative h-36 border-b bg-muted/30">` containing
  `<WaveRibbon className="absolute inset-0" />` and a centered overlay:
  `<div className="absolute inset-0 flex items-center justify-center">`
  `<p className="font-[family-name:var(--font-display)] text-3xl font-normal tracking-tight">Let's build something</p>`.
  Nothing else in the band — no icon, no circles, no gradient.
- Body: `<div className="space-y-4 p-6">` containing:
  - `DialogHeader` with `DialogTitle` **"You're on Camel Free"** and
    `DialogDescription`:
    "Great for experimenting, simple projects, and quick tweaks. It's shared
    with other free users, so replies can slow down at busy times. Premium
    models (Claude, GPT) are one click away whenever you want more."
  - `DialogFooter` with `Button variant="outline"` **"See premium models"**
    and `Button` (default variant) **"Start building free"**.
  - `<p className="text-center text-xs text-muted-foreground">You can switch
    models anytime from the composer.</p>`

Behavior:

- Component props: `{ open, onOpenChange, onSeePremiumModels }`.
  "Start building free" → `onOpenChange(false)`. "See premium models" →
  `onOpenChange(false)` then `onSeePremiumModels()` (opens the existing
  Unlock modal via `openUnlockPremium(null)`).
- Control from `Chat.tsx`, next to the other billing dialogs. Auto-open once:
  when the new-chat welcome screen is showing (no active thread),
  `billingAccessMode === "camel_free"`, and localStorage
  `camel-free-welcome-dismissed:{userId}:{orgId}` is unset — the SAME key the
  card used, so anyone who already dismissed the card never sees the modal.
  Set the key on every close path (✕, ESC, overlay, either button), i.e. in
  `onOpenChange(false)`. If localStorage is unavailable, do not auto-open.
- Never auto-open over an existing conversation (`/chat/:id` with messages).
- Include this dialog's open state in the `isAnyBillingDialogOpen` value
  passed to `useFreeTierUpgradePrompt` so the second-turn upgrade prompt can
  never stack on top of it.
- Extract the show-once decision into a small pure helper (same pattern as
  `recordFreeCompletedTurn` in `use-free-tier-upgrade-prompt.ts`) so it is
  unit-testable.

## WI-3: Unlock premium models modal restructure

Rewrite the body of `src/components/billing/unlock-premium-modal.tsx`. Props,
callbacks, and the header stay exactly as they are. The four methods stop
being four identical cards; the layout becomes: one highlighted Recommended
card + three low-profile rows, grouped under two section labels. Remove the
per-method lucide icons entirely (`Sparkles`, `Coins`, `KeyRound`,
`OpenAiIcon`) — rows are text + button.

```
┌────────────────────────────────────────────────────────────┐
│  Unlock premium models                                 ✕   │
│  Camel Free is always included. Premium models like        │
│  {trigger label} need one of these:                        │
│                                                            │
│  PAY THROUGH CAMELAI                                       │  ← section label
│   ┌[Recommended]───────────────────────────────────────┐   │
│   │ Subscribe   from $10/mo                 [See plans]│   │  ← Card, ring-2
│   │ Monthly model credits matching your plan price,    │   │    ring-primary;
│   │ plus more apps, automations, and storage.          │   │    primary button
│   └────────────────────────────────────────────────────┘   │
│                                                            │
│  Buy credits                                    [Top up]   │  ← plain row
│  Prepaid, pay as you go. No subscription.                  │
│                                                            │
│  ──────────────────────────────────────────────────────    │  ← Separator
│                                                            │
│  USE WHAT YOU ALREADY PAY FOR                              │  ← section label
│                                                            │
│  Sign in with OpenAI [Best value for GPT models][Sign in]  │  ← badge only on
│  Use your ChatGPT plan's allowance — no extra cost.        │    GPT trigger
│                                                            │
│  Use your own API key                          [Add key]   │
│  Anthropic, OpenAI, OpenRouter, Bedrock, or a custom       │
│  endpoint.                                                 │
└────────────────────────────────────────────────────────────┘
```

Exact structure, top to bottom (inside the existing `DialogContent
className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"`):

1. Section label: `<p className="text-xs font-medium uppercase tracking-wide
   text-muted-foreground">Pay through camelAI</p>`
2. **Recommended card** — mirror the plan-picker "Most popular" treatment
   exactly (`plan-picker-card.tsx` lines 82–104): a `relative` wrapper with a
   floating `<Badge variant="default" className="absolute top-0 left-4 z-10
   -translate-y-1/2">Recommended</Badge>` and a `<Card className="ring-2
   ring-primary">`. `CardContent className="flex items-start gap-3 p-4"`:
   - text block: `<p className="font-medium">Subscribe</p>` with
     `<span className="text-xs text-muted-foreground">from $10/mo</span>`
     inline beside it; description below in `text-sm text-muted-foreground`:
     "Monthly model credits matching your plan price, plus more apps,
     automations, and storage."
   - CTA: `Button` **default variant** `size="sm"` "See plans" (the only
     primary button in this modal — mirrors the highlighted plan card's
     default-variant CTA).
3. **Buy credits row** (no Card): `<div className="flex items-start
   justify-between gap-3 px-1">` — text block with
   `<p className="text-sm font-medium">Buy credits</p>` and
   `<p className="text-sm text-muted-foreground">Prepaid, pay as you go. No
   subscription.</p>`; right side `Button variant="outline" size="sm"`
   "Top up".
4. `<Separator />`
5. Section label: "Use what you already pay for" (same classes as #1).
6. **Sign in with OpenAI row** (same row pattern as #3): title
   "Sign in with OpenAI"; when `isGptTrigger`, a
   `<Badge variant="secondary">Best value for GPT models</Badge>` sits inline
   after the title. Description: "Use your ChatGPT plan's allowance — no
   extra cost." Button: `outline` `size="sm"` "Sign in".
7. **API key row**: title "Use your own API key"; description "Anthropic,
   OpenAI, OpenRouter, Bedrock, or a custom endpoint." Button: `outline`
   `size="sm"` "Add key".

Behavior changes:

- The layout is STATIC — delete the `orderedMethods` reordering. On a GPT
  trigger the only change is the badge on the OpenAI row (the sections make
  reordering impossible and the recommendation stays Subscribe).
- Non-admin (`!isOrgAdmin`): unchanged behavior — every button is replaced by
  `<span className="shrink-0 pt-1 text-xs text-muted-foreground">Ask an org
  admin</span>`, including on the Recommended card.
- Keep the `data-testid="unlock-method-{id}"` attributes on the card and each
  row. Update `tests/` that assert the old ordering/structure (there are
  unlock-modal assertions in the model-picker/unlock tests — adjust them to
  the static layout + conditional badge).

## WI-4: Plan picker height is stable across Individual/Team tabs

`src/components/billing/plan-picker.tsx` (lines 167–184). The Team tab's
cards are shorter, so the dialog resizes on toggle. Fix by keeping both tab
panels mounted and stacked in one grid cell so the container's height is
always the taller panel's height — no hardcoded heights.

Replace the two `TabsContent` blocks with:

```tsx
<div className="mt-5 grid w-full">
  <TabsContent
    forceMount
    value="individual"
    className="col-start-1 row-start-1 w-full data-[state=inactive]:invisible data-[state=inactive]:pointer-events-none"
  >
    {renderGrid(INDIVIDUAL_PLANS, individualHighlight)}
  </TabsContent>
  <TabsContent
    forceMount
    value="team"
    className="col-start-1 row-start-1 w-full data-[state=inactive]:invisible data-[state=inactive]:pointer-events-none"
  >
    {renderGrid(TEAM_PLANS, teamHighlight)}
  </TabsContent>
</div>
```

Notes: `forceMount` keeps the inactive panel in the DOM (Radix stops applying
`hidden`); `visibility: hidden` removes it from the accessibility tree and
tab order, and the shared `col-start-1 row-start-1` cell makes the row as
tall as the tallest panel. This applies to every `PlanPicker` consumer
(upgrade dialog, paywall takeover, billing settings) — intended. Do not add
`min-h-*` anywhere.

## Tests & verification

- Unit test the welcome-dialog show-once helper (new file next to
  `tests/free-tier-upgrade-prompt.test.ts`): shows for camel_free +
  unset key; never shows after any close; never shows when localStorage
  throws; reuses the `camel-free-welcome-dismissed:` key.
- Update unlock-modal assertions to the new static structure (recommended
  card + rows, badge only on GPT trigger, "Ask an org admin" on all four).
- Update `src/routes/dev.billing-paywall.tsx` and `dev.chat-credit-states.tsx`
  harnesses to preview the welcome dialog and restructured unlock modal.
- `bun run typecheck`, `bun run lint`, `bun run test:run` for the touched
  test files.
- The staging billing E2E suite (`e2e/staging-billing/`) does not reference
  the welcome card or unlock-modal internals — confirm it still passes
  untouched.
