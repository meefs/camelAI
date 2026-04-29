# Paywall Component — Round 2 Feedback

The visual polish landed well: alignment, font hierarchy, the display font on the heading, the redesigned info panel, and the removal of the Stripe-not-configured leak are all solid. Two issues to address in this pass — one copy, one structural.

---

## 1. Restore the LLM-credit copy

In [src/components/billing/plan-picker-content.ts:31](src/components/billing/plan-picker-content.ts#L31) and [:43](src/components/billing/plan-picker-content.ts#L43) the bullets read:

```
$10 hosted credits / mo
$30 hosted credits / mo
```

These were originally `$10 LLM credits/mo included` / `$30 LLM credits/mo included` in the previous mock and that copy was clearer. "Hosted credits" doesn't tell the user what the credits are *for* — without context it reads like hosting credits (storage, deploys, etc.), which is not what they buy.

The agent's likely motivation was disambiguation against BYOK ("hosted" vs "own key"), and avoidance of the acronym "LLM." Both are reasonable instincts but the resulting copy is less informative.

**Change to:**

| Before | After |
|---|---|
| `$10 hosted credits / mo` | `$10 of model credits / mo` |
| `$30 hosted credits / mo` | `$30 of model credits / mo` |
| `$10 hosted credits / seat / mo` (team, [plan-picker-content.ts:56](src/components/billing/plan-picker-content.ts#L56)) | `$10 of model credits / seat / mo` |

"Model credits" reads as "credits for using the AI models" without requiring the user to know what LLM stands for. If you'd rather keep the original `LLM credits/mo included` exactly, that's also fine — both are clearer than "hosted credits."

While there: also align the surrounding language. The footer panel already says "Top up credits to use any model through us at cost" — "model credits" in the bullets matches that phrasing and reinforces the same mental model.

---

## 1b. CTA copy must disclose "free"

In [src/components/billing/plan-picker-content.ts:28](src/components/billing/plan-picker-content.ts#L28), [:40](src/components/billing/plan-picker-content.ts#L40), and [:53](src/components/billing/plan-picker-content.ts#L53), the paid plan CTAs all read `Start trial`. That doesn't disclose that the trial is free — the user clicks not knowing whether they're about to be charged.

**Change all three to:** `Start 7-day free trial`

| Location | Before | After |
|---|---|---|
| [plan-picker-content.ts:28](src/components/billing/plan-picker-content.ts#L28) (Starter) | `Start trial` | `Start 7-day free trial` |
| [plan-picker-content.ts:40](src/components/billing/plan-picker-content.ts#L40) (Pro) | `Start trial` | `Start 7-day free trial` |
| [plan-picker-content.ts:53](src/components/billing/plan-picker-content.ts#L53) (Team) | `Start trial` | `Start 7-day free trial` |

If the longer label causes wrapping in the smaller `outline`-variant buttons (Starter and Team in their default state), fall back to `Start free trial` — but try the full string first since the buttons are now `size="lg"` and the cards are wide enough to fit it. The "All paid plans include a 7-day free trial. Cancel anytime." footnote at [plan-picker.tsx:190](src/components/billing/plan-picker.tsx#L190) can stay as-is — it's a useful reinforcement, not a duplicate.

The pending state label at [plan-picker-card.tsx:55](src/components/billing/plan-picker-card.tsx#L55) (`"Opening Stripe…"`) is fine and doesn't need to change.

---

## 2. Resolve the double-header in onboarding

The current welcome screen stacks four header-weight blocks before the user sees a CTA:

```
┌─────────────────────────────────────────┐
│         Welcome to camelAI              │  ← h1, text-3xl semibold
│                                          │
│  camelAI is your AI software engineer.   │  ← intro paragraph
│  Claude has a permanent computer here…   │
│                                          │
│  Choose how you want to cover model      │  ← bridge paragraph
│  usage.                                  │
│                                          │
│         Choose your plan                 │  ← h2, text-3xl serif
│   Pick the plan that fits how you build. │  ← subhead
│                                          │
│         [Individual | Team]              │  ← tabs
│                                          │
│  ┌──────┐  ┌──────┐  ┌──────┐           │  ← cards finally start
└─────────────────────────────────────────┘
```

Two title blocks competing, two paragraphs of explanation, then tabs, then cards. The user has to scroll past ~400px of header before reaching anything actionable. The "Welcome to camelAI" + product description block is leftover from when this screen was a generic landing page; in the paywall context it's redundant — the cards themselves communicate what camelAI is by describing the plans and CTAs.

### Recommended structure

Collapse to a single header block. The plan grid is the page — let it own the screen.

```
┌─────────────────────────────────────────┐
│  ▣ camelAI                               │  ← logo (already in OnboardingLayout)
│                                          │
│         Choose your plan                 │  ← single h1, display font
│  Pick how you want to pay for model use. │  ← single subhead, slightly elaborated
│                                          │
│         [Individual | Team]              │
│                                          │
│  ┌──────┐  ┌──────┐  ┌──────┐           │  ← cards on screen above the fold
│  │ Free │  │Starter│  │ Pro  │          │
│  └──────┘  └──────┘  └──────┘           │
└─────────────────────────────────────────┘
```

### Specific changes

- [src/routes/_onboarding.welcome.tsx:245-279](src/routes/_onboarding.welcome.tsx#L245-L279): when `isBillingChoiceRequired` is true, **don't render** the "Welcome to camelAI" + intro paragraph + bridge paragraph block. The `<PlanPicker>` heading becomes the page heading.
- Inside the `isBillingChoiceRequired` branch, pass `heading={null}` to `<PlanPicker>` is **wrong** — we want the PlanPicker heading to *be* the page heading. Instead, override `heading` to a slightly more contextual version that incorporates what the paragraph used to say:

  ```tsx
  <PlanPicker
    heading={{
      title: "Choose your plan",
      subtitle: "Start a free trial with model credits, or use your own API key.",
    }}
    ...
  />
  ```

  The new subtitle absorbs the "Choose how you want to cover model usage" bridge line and tells the user about both branches (trial vs BYOK) without burying the cards under an explainer. It also previews what the BYOK card will do, which the current copy doesn't.

- The "Welcome to camelAI" + product description block stays for the **other two paths** — email-verification (password signup) and team-welcome — because those screens don't have the plan grid to anchor them. Wrap that block in `{!isBillingChoiceRequired && !isTeamWelcome ? (...) : null}` (and keep the team variant as it is today).

- [src/routes/_onboarding.welcome.tsx:244](src/routes/_onboarding.welcome.tsx#L244): the wrapper `<div className="space-y-4">` works fine for both branches. No layout change needed there.

### Why this works

The Welcome screen has three jobs depending on path:

| Path | Job | Header treatment |
|---|---|---|
| Billing choice (OAuth + non-team) | "Pick a plan and pay" | Cards are the page; one heading sits above them |
| Email verification (password) | "Wait — verify first" | Friendly product intro + verification CTA, since cards are absent |
| Team invite | "Welcome to {orgName}" | Friendly team-context intro |

Today all three render the friendly product intro even when it competes with the cards. Splitting on `isBillingChoiceRequired` gives each path the header weight that fits its job.

### Footer panel

Once the cards move above the fold, the "Use Claude, Codex, OpenRouter, or your own API key" panel ([plan-picker.tsx:172](src/components/billing/plan-picker.tsx#L172)) becomes the only block below the cards. That's the right place for it — a contextual reminder *after* the user has scanned the plans, not a competing intro before them.

---

## What to do

1. Update the three credit bullet strings in [plan-picker-content.ts](src/components/billing/plan-picker-content.ts) (~3 line edits).
2. Update the three trial CTA labels in [plan-picker-content.ts](src/components/billing/plan-picker-content.ts) from `Start trial` to `Start 7-day free trial` (~3 line edits).
3. Branch the welcome.tsx header rendering on `isBillingChoiceRequired`. When true, hide the "Welcome to camelAI" block and pass a richer `heading` to `<PlanPicker>` that absorbs the bridge copy.
4. Re-screenshot at 1280px wide and verify the cards are visible without scrolling and that the longer CTA label fits the outline-variant buttons.

No structural changes to `<PlanPicker>` itself — all fixes are at the consumer (welcome.tsx) and content (plan-picker-content.ts) layers.
