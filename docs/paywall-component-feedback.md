# Paywall Component — Visual Polish Feedback

The structural plan landed correctly: `<PlanPicker>` is properly factored, the Individual / Team toggle works, the Stripe FIXMEs are in the right places, and the BYOK extraction is clean. This pass is purely visual polish — the current render still feels engineering-flavored, not designed. The mock has more whitespace economy and stronger hierarchy despite using fewer tricks.

All file paths and line numbers below refer to the post-implementation tree.

---

## 0. Remove the "Hosted plans aren't configured…" string from the UI

The string `"Hosted plans aren't configured in this environment — use BYOK for now."` at [src/routes/_onboarding.welcome.tsx:351](src/routes/_onboarding.welcome.tsx#L351) is an engineer-facing FIXME leaking into the user-facing paywall. It must not ship in the frontend.

**Changes:**

- [src/routes/_onboarding.welcome.tsx:348-352](src/routes/_onboarding.welcome.tsx#L348-L352): delete the `disabledReason={...}` prop entirely. Pass `disabledReason={null}` (or omit the prop — it defaults to `null`).
- [src/routes/_onboarding.welcome.tsx:39-46](src/routes/_onboarding.welcome.tsx#L39-L46): the loader currently calls `isStripeBillingConfigured(env)` and threads `stripeConfigured` through `WelcomeLoaderData`. Remove that field and the loader call — it's only consumed by the string we're deleting.
- Replace with a `// FIXME(billing):` comment at the top of the `onSelectPlan` handler in [_onboarding.welcome.tsx:353](src/routes/_onboarding.welcome.tsx#L353) noting that Stripe trial CTAs will silently no-op in environments where Stripe is unconfigured, and that the billing engineer wiring Pro/Team should also handle the unconfigured case (likely by surfacing a toast on the action error path, not by gating the CTAs in the UI).
- The existing FIXME at [_onboarding.welcome.tsx:370-371](src/routes/_onboarding.welcome.tsx#L370-L371) for the Pro/Team Stripe wiring already establishes the pattern — match it.

The user should never see infrastructure-state copy. If hosted plans aren't configured, the right behavior is for the action handler to fail loudly server-side (where the billing engineer can decide whether to redirect, toast, or fall back to BYOK), not for the paywall to render an apologetic helper line.

---

## 1. Stop centering everything (alignment)

The current implementation wraps almost everything in `text-center`. The mock only centers the heading + tabs; cards, the alert panel, and the footer note are left-aligned. Centering inside the cards is making the price block look unanchored.

**Changes:**

- [src/routes/_onboarding.welcome.tsx:252](src/routes/_onboarding.welcome.tsx#L252): the wrapper `<div className="space-y-6 text-center">` is forcing every descendant — including the `PlanPicker` cards and the footer alert — to inherit `text-center`. Move `text-center` only onto the `<h1>` + intro paragraphs (the "Welcome to camelAI" block), not the wrapper that contains `<PlanPicker>`.
- [src/components/billing/plan-picker.tsx:166](src/components/billing/plan-picker.tsx#L166): `disabledReason` paragraph is `text-center`. Make it left-aligned, sized like a real helper line, and place it directly above the footer panel — not as a floating centered string under the grid.
- [src/components/billing/plan-picker.tsx:190](src/components/billing/plan-picker.tsx#L190): the "All paid plans include a 7-day free trial. Cancel anytime." footnote is centered. Mock shows it centered too — keep it centered, but it currently reads as orphaned because there's no surrounding rhythm. See section 3.
- [src/components/billing/plan-picker-card.tsx](src/components/billing/plan-picker-card.tsx): card internals are fine because Card defaults left-align, but the price `<div className="flex items-baseline gap-1">` should explicitly be `justify-start` so it doesn't inherit center alignment from the welcome wrapper once that wrapper is also patched.

---

## 2. Bump font sizes (everything is too small)

The component is built on the camelAI Card primitive, which uses `text-xs/relaxed` by default ([src/components/ui/card.tsx:14](src/components/ui/card.tsx#L14)) and a `text-sm font-medium` `CardTitle` ([src/components/ui/card.tsx:37](src/components/ui/card.tsx#L37)). Those defaults are fine for dashboard cards but too dense for a paywall — the current render reads like a settings panel.

**Specific bumps:**

| Element | Current | Change to |
|---|---|---|
| `CardTitle` plan name (Free / Starter / Pro) | `text-base font-semibold` ([plan-picker-card.tsx:88](src/components/billing/plan-picker-card.tsx#L88)) | `text-lg font-semibold` |
| `CardDescription` tagline | inherits `text-xs/relaxed` from card | override to `text-sm` |
| Price amount ($0 / $40 / $150) | `text-2xl font-semibold` ([plan-picker-card.tsx:95](src/components/billing/plan-picker-card.tsx#L95)) | `text-4xl font-semibold` (mock looks ~36–40px) |
| Price suffix `/mo` | `text-xs text-muted-foreground` | `text-sm text-muted-foreground` |
| `+ usage after credits` subtitle | `text-xs text-muted-foreground` | `text-sm text-muted-foreground` and place it directly under the price line, before the tagline (see section 4 — currently the tagline is rendered above the price which inverts the mock) |
| Feature bullets | `text-xs text-muted-foreground` ([plan-picker-card.tsx:128](src/components/billing/plan-picker-card.tsx#L128)) | `text-sm text-foreground/80` (mock bullets are body weight, not muted) |
| CTA button | inherits Button default | pass `size="lg"` so it matches the mock's chunkier CTA |
| Footer info panel body | `text-xs/relaxed` | `text-sm` for the body, `text-base font-medium` for the title |
| Heading (`Choose your plan`) | `text-2xl font-semibold` ([plan-picker.tsx:137](src/components/billing/plan-picker.tsx#L137)) | `text-3xl font-semibold` and apply the display font (see section 6) |
| Heading subtitle | `text-sm text-muted-foreground` | `text-base text-muted-foreground` |

---

## 3. Tighten the empty space

The screenshot shows two problems:

1. The 5xl-wide layout is much wider than the content needs at the current font sizes. The mock fits comfortably inside ~`max-w-4xl`. Recommend dropping [_onboarding.welcome.tsx:250](src/routes/_onboarding.welcome.tsx#L250) from `max-w-5xl` to `max-w-4xl` — once the bullets are full-width text and the buttons are `lg`, cards will fill the grid without looking padded with air.
2. Each card has `md:min-h-[28rem]` at [plan-picker-card.tsx:83](src/components/billing/plan-picker-card.tsx#L83). With 5–6 features that's leaving ~80–120px of dead space at the bottom of every card. **Remove the `min-h`.** Use the flex tricks in section 4 to align CTAs across cards instead — that achieves vertical button alignment without padding cards full of air.
3. [plan-picker.tsx:134](src/components/billing/plan-picker.tsx#L134) wraps everything in `space-y-6`. Drop to `space-y-5` and the welcome wrapper at [_onboarding.welcome.tsx:252](src/routes/_onboarding.welcome.tsx#L252) from `space-y-6` to `space-y-4` so the heading hugs the tabs more tightly.

---

## 4. Horizontally align CTAs across all cards

> "All of the buttons should be horizontally aligned across each paywall option, meaning despite the usage note not being included in the free tier, we need to adjust for that spacing."

The mock has a clear grid: **plan name → price → tagline → CTA → bullet list**, with the CTA row aligned across all cards even though the Free card's price block is shorter (no `+ usage after credits` line) and the Starter/Pro have the extra subtitle. Right now [plan-picker-card.tsx:93](src/components/billing/plan-picker-card.tsx#L93) puts the CTA inside `CardFooter` *between* the price block and the bullet list, which means the CTA position drifts down/up depending on whether the subtitle exists. That's why the screenshot shows the Free CTA higher than Starter/Pro.

**Fix:** restructure the card into a vertical flex with explicit slots, and use a transparent placeholder line in the Free price block to reserve the same height as the `+ usage after credits` text in paid tiers.

```tsx
<Card className="flex h-full flex-col">
  <CardHeader>
    <CardTitle>{label}</CardTitle>          {/* slot 1: plan name */}
  </CardHeader>

  <CardContent className="space-y-1">
    <div className="flex items-baseline gap-1">
      <span className="text-4xl font-semibold">{amount}</span>
      <span className="text-sm text-muted-foreground">{suffix}</span>
    </div>
    {/* slot 2: subtitle line — always rendered, invisible on Free */}
    <p className={cn("text-sm", price.subtitle ? "text-primary" : "invisible select-none")}>
      {price.subtitle ?? "placeholder"}
    </p>
    {/* slot 3: tagline */}
    <p className="text-sm text-muted-foreground">{tagline}</p>
  </CardContent>

  <CardFooter>
    <Button size="lg" className="w-full" ...>{ctaLabel}</Button>   {/* slot 4: CTA aligned */}
  </CardFooter>

  <CardContent className="flex-1">
    <ul className="space-y-2 text-sm">{features...}</ul>           {/* slot 5: bullets fill remaining */}
  </CardContent>
</Card>
```

Key changes:

- **Reserve the subtitle row height on Free** with an `invisible` placeholder. This is what locks the CTA Y-position across cards.
- Move tagline (`For solo builders`, `For power users`) **below** the price + subtitle, not in `CardHeader`. The mock has the tagline as a small line right above the CTA. Currently [plan-picker-card.tsx:91](src/components/billing/plan-picker-card.tsx#L91) puts it inside `CardHeader` above the price, which puts it in the wrong reading order.
- Color the `+ usage after credits` text with `text-primary` (blue in dark mode). The mock uses the accent color for that line — it's the cheapest way to draw the eye to "yes, there's metered usage on top."
- Card body uses `flex flex-col` so the bullet list block can `flex-1` and absorb leftover height instead of leaving a void at the bottom.

This eliminates both the alignment issue and the dead-space issue in one structural change.

---

## 5. The bottom alert needs to be redesigned (not styled)

The current "Use Claude, Codex, or your own API key" panel ([plan-picker.tsx:172–189](src/components/billing/plan-picker.tsx#L172-L189)) renders as a tiny `Card size="sm"` with `text-xs/relaxed`, an `Info` icon shoved into a flex row, and `gap-2` between icon and text. The icon is misaligned because `mt-0.5` isn't enough to baseline-align with a `font-medium` title that's now larger than the body.

**Recommended replacement** — drop the `Info` icon and the Card primitive entirely. The mock just uses a flat panel:

```tsx
<div className="rounded-xl bg-muted/40 px-5 py-4">
  <p className="text-base font-semibold text-foreground">
    Use Claude, Codex, or your own API key
  </p>
  <p className="mt-1 text-sm text-muted-foreground">
    Top up credits to use Claude or Codex through us at cost — no markup.
    Or bring your own API key anytime.
  </p>
</div>
```

- Left-aligned (already addressed in section 1).
- No icon. The icon is adding noise without information; the heading already labels the panel. If you want one, drop it inline at the start of the title, baseline-aligned via `inline-flex items-center gap-2` on the `<p>` — not as a sibling flex item.
- `rounded-xl` (matches the mock's softer corner) instead of the Card's `rounded-lg`.
- `bg-muted/40` is fine; the issue was the Card padding + size="sm" making it look cramped. Dropping the Card primitive removes the `text-xs/relaxed` default that was forcing tiny text.

The "All paid plans include a 7-day free trial. Cancel anytime." line moves to a `mt-4 text-center text-sm text-muted-foreground` paragraph below this panel. Keep it centered — it's a footnote.

---

## 6. Use the display font

[src/styles/globals.css:81](src/styles/globals.css#L81) defines `--font-display: "Source Serif 4", ...`. It's used elsewhere via `font-[family-name:var(--font-display)]` (see [src/components/chat-file-preview/notebook-preview/report-header.tsx:28](src/components/chat-file-preview/notebook-preview/report-header.tsx#L28)) and via `font-serif italic` in [src/components/welcome-screen/welcome-greeting.tsx:49](src/components/welcome-screen/welcome-greeting.tsx#L49). It is not currently used anywhere in the paywall.

**Two recommended applications:**

1. **Heading** — change [plan-picker.tsx:137](src/components/billing/plan-picker.tsx#L137) from `text-2xl font-semibold tracking-tight` to:
   ```tsx
   className="font-[family-name:var(--font-display)] text-3xl font-normal tracking-tight"
   ```
   `font-normal` because Source Serif at heavier weights gets noisy; the display weight should sit at 400. Matches the chat welcome greeting treatment.

2. **Price amounts** — apply the same font to the price `$0 / $40 / $150` numerals. Numerals in Source Serif feel premium and contrast nicely against the sans-serif `/mo` suffix.
   ```tsx
   <span className="font-[family-name:var(--font-display)] text-4xl font-normal">
     {price.amount}
   </span>
   ```
   This is the highest-leverage place to use the display font — it's where the user's eye lands on every card.

Don't apply it to plan names or feature bullets — Source Serif at small sizes loses readability.

---

## 7. Smaller cleanups noticed during review

- [plan-picker-card.tsx:106](src/components/billing/plan-picker-card.tsx#L106) has dead conditional logic: `: plan === "team" ? null : null}`. Simplify to just `: null}`.
- [plan-picker.tsx:174](src/components/billing/plan-picker.tsx#L174) has `py-1` overriding the Card's default padding for what should just be more padding, not less. With the redesigned panel in section 5 this goes away.
- [plan-picker-card.tsx:118](src/components/billing/plan-picker-card.tsx#L118) — when `state.kind === "current"`, the button is disabled but uses `variant="secondary"`. With the larger `size="lg"` Button, double-check the disabled secondary state still has enough contrast against the card background; may need `aria-disabled` styling rather than the default opacity drop.
- [plan-picker-card.tsx:131](src/components/billing/plan-picker-card.tsx#L131) — `Check` icon is `text-primary` which is fine in light mode but the screenshot shows the checks are barely visible against the dark card. Try `text-foreground/70` or keep `text-primary` but bump to `size-4`.

---

## What to do

Tackle in this order:

1. **Section 4 first** (card restructure) — biggest visual win, unblocks alignment and dead-space fixes simultaneously.
2. **Section 2** (font sizes) — second biggest win, takes ~10 line edits.
3. **Section 1** (decentering) — single wrapper fix in welcome.tsx + small fixes inside plan-picker.tsx.
4. **Section 5** (alert redesign) — drop the Card primitive, hand-roll the panel.
5. **Section 6** (display font) — heading + price numerals only.
6. **Section 3** (whitespace) — fall out of the above; verify with a final eyeball pass.
7. **Section 7** — janitorial.

Then re-screenshot and compare against the mock side-by-side. The card structure from section 4 is the load-bearing change — everything else is tuning.
