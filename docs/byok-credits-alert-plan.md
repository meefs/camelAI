# BYOK "Needs Credits" Alert Plan

## Problem

Today the BYOK key entry surfaces in two places:

1. **Paywall modal** — `<ByokKeyDialog>` opened from the Free card on `/_onboarding.welcome` ([byok-key-dialog.tsx](../src/components/onboarding/byok-key-dialog.tsx)).
2. **Settings → AI Provider** — `<ByokKeyForm>` rendered both for first-time setup and inside the "Replace key" section ([_app.settings.organization.ai-provider.tsx:315-333, 337-351](../src/routes/_app.settings.organization.ai-provider.tsx#L315-L351)).

Both surfaces happily accept a freshly-generated key from Anthropic, OpenAI, OpenRouter, or AWS Bedrock. But all four providers issue keys *before* the user adds a payment method. The user pastes a key, hits Continue, and then later sees a 401 / 402 / "insufficient quota" / "credit balance too low" error on their first chat turn — and has no way of knowing the cause is on their provider account, not camelAI.

We want to pre-empt this with a single explanatory alert in both surfaces, so users go fund their provider account *before* they discover the issue mid-chat.

---

## Goal

Add an informational alert with the agreed copy to both BYOK entry surfaces. Because both surfaces already render the shared `<ByokKeyForm>`, the alert lives **inside the form** so it shows up automatically in:

- The paywall `<ByokKeyDialog>` modal.
- The settings page first-time setup form.
- The settings page "Replace key" form.

No conditional rendering by provider — the four providers we support in the dialog (OpenRouter, Anthropic, OpenAI, Bedrock) all match the four named in the copy, so the message applies universally.

---

## Copy (verbatim — do not paraphrase)

> **Title:** Your API key needs credits to work
>
> **Body:** Anthropic, OpenAI, OpenRouter, and AWS let you generate a key without adding a payment method, but the key won't process messages until you load credits with the provider. If camelAI returns errors after saving your key, this is almost always why.

The mock screenshot shows no leading bullet on the body text — it's a single paragraph. The `*` in the original spec was a markdown artifact, not a bullet to render.

---

## ASCII Design

The alert sits **above the provider pills**, as the first element inside the form. That way it sets expectations before the user picks a provider or pastes anything — it's the first thing read after the dialog title / page header.

### In the paywall dialog (`<ByokKeyDialog>`)

```
┌──────────────────────────────────────────────────────────────────┐
│                                                              [X] │
│  Add your API key                                                │  ← DialogTitle
│  Your provider bills you directly.                               │  ← DialogDescription (kept)
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ ⓘ  Your API key needs credits to work                      │ │  ← NEW Alert
│  │    Anthropic, OpenAI, OpenRouter, and AWS let you          │ │     (variant=default,
│  │    generate a key without adding a payment method, but     │ │      Info icon, full width)
│  │    the key won't process messages until you load credits   │ │
│  │    with the provider. If camelAI returns errors after      │ │
│  │    saving your key, this is almost always why.             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Provider                                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │OpenRouter│ │Anthropic │ │  OpenAI  │ │ Bedrock  │            │
│  └══════════┘ └──────────┘ └──────────┘ └──────────┘            │
│                                                                  │
│  OpenRouter API key                       Get a key ↗            │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ sk-or-...                                               │     │
│  └────────────────────────────────────────────────────────┘     │
│  ⓘ Any model — Claude, GPT, Gemini, and more via OpenRouter.    │
│                                                                  │
│  ──────────────────────────────────────────────────────────     │
│                                              [    Continue    ]  │
└──────────────────────────────────────────────────────────────────┘
```

### In Settings → AI Provider (first-time setup, no config)

```
AI Provider                                                          ← SettingsHeader
Bring your own API key to use camelAI with your LLM provider.
──────────────────────────────────────────────────────────────────

┌────────────────────────────────────────────────────────────────┐
│ ⓘ  Your API key needs credits to work                          │  ← NEW Alert
│    Anthropic, OpenAI, OpenRouter, and AWS let you generate     │     (max-w-2xl to match form,
│    a key without adding a payment method, but the key won't    │      sits above provider pills)
│    process messages until you load credits with the provider.  │
│    If camelAI returns errors after saving your key, this is    │
│    almost always why.                                          │
└────────────────────────────────────────────────────────────────┘

Provider
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│OpenRouter│ │Anthropic │ │  OpenAI  │ │ Bedrock  │
└──────────┘ └──────────┘ └──────────┘ └══════════┘
… (rest of form)
```

### In Settings → AI Provider (existing config, "Replace key" section)

```
Active key                                                          (unchanged)
  Anthropic   sk-ant-…abcd       [Test]  [Remove]
  Added Apr 28, 2026
──────────────────────────────────────────────────────────────────
Switch to camelAI billing                                           (unchanged)
  Switch back to camelAI hosted credits…   [Use camelAI billing]
──────────────────────────────────────────────────────────────────
Replace key

┌────────────────────────────────────────────────────────────────┐
│ ⓘ  Your API key needs credits to work                          │  ← NEW Alert
│    Anthropic, OpenAI, OpenRouter, and AWS let you generate     │     (appears here too because
│    a key without adding a payment method, but the key won't    │      ByokKeyForm renders it)
│    process messages until you load credits with the provider.  │
│    If camelAI returns errors after saving your key, this is    │
│    almost always why.                                          │
└────────────────────────────────────────────────────────────────┘

Provider
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
… (rest of form)
```

This is intentional — replacing a working key with a fresh one hits the same provider-funding gotcha, so the alert is still relevant for that flow.

---

## Where to Add It

**Single insertion point:** [src/components/byok/byok-key-form.tsx](../src/components/byok/byok-key-form.tsx), at the top of the `<form>` body, before the Provider `<ToggleGroup>` block at line 73.

Because both `<ByokKeyDialog>` and the settings page render `<ByokKeyForm>`, one change covers both surfaces. No prop is needed — the alert is unconditional.

### Code

The form already imports `Alert`, `AlertDescription` (line 2) and `Info` (line 1). Add `AlertTitle` to the existing alert import:

```tsx
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
```

Then insert this block as the first child of the `<form>` (immediately inside the `<form …>` tag at line 66, before the existing `<div className="space-y-2"><Label>Provider</Label>…` block at line 73):

```tsx
<Alert>
  <Info className="size-4" aria-hidden="true" />
  <AlertTitle>Your API key needs credits to work</AlertTitle>
  <AlertDescription>
    Anthropic, OpenAI, OpenRouter, and AWS let you generate a key
    without adding a payment method, but the key won't process
    messages until you load credits with the provider. If camelAI
    returns errors after saving your key, this is almost always why.
  </AlertDescription>
</Alert>
```

The `Alert` component already lays out icon + title + description in a 2-column grid via `has-[>svg]:grid-cols-[auto_1fr]` ([alert.tsx:6](../src/components/ui/alert.tsx#L6)) and auto-sizes SVGs to `size-3.5` if no size class is set. Passing `size-4` matches the size used elsewhere in the codebase (e.g. [invite-member-dialog.tsx:248-256, 279-289](../src/components/settings/invite-member-dialog.tsx#L248-L289)) for informational alerts.

The form's existing wrapper class is `space-y-4` ([byok-key-form.tsx:67](../src/components/byok/byok-key-form.tsx#L67)) so the alert gets a 16px gap above the Provider section automatically — no extra spacing classes needed.

---

## shadcn Components Used

| Element | Component | Source |
|---|---|---|
| Container | `Alert` (variant `default`) | [src/components/ui/alert.tsx](../src/components/ui/alert.tsx) |
| Heading | `AlertTitle` | same |
| Body | `AlertDescription` | same |
| Icon | `Info` from `lucide-react` | already used in form at line 147 |

No new primitives need to be installed. No registry items to add.

### Why `variant="default"` (and not destructive)

This is informational, not an error. Looking at the codebase, the established pattern for "here's something useful to know" alerts is `<Alert>` + `<InfoIcon>` (default variant), used in [invite-member-dialog.tsx:279-289 and :292-304](../src/components/settings/invite-member-dialog.tsx#L279-L304). `variant="destructive"` is reserved for actual error states (e.g. the `errorMessage` block at [byok-key-form.tsx:152-156](../src/components/byok/byok-key-form.tsx#L152-L156)). Matching that convention keeps visual semantics consistent.

The `default` variant renders as `bg-card text-card-foreground` ([alert.tsx:9](../src/components/ui/alert.tsx#L9)), which against the dialog's solid card background gives the subtle outlined look in the mock.

---

## Visual Details

### Sizing & spacing
- The `Alert` component has its own padding (`px-2 py-1.5`) and rounded border ([alert.tsx:6](../src/components/ui/alert.tsx#L6)).
- Width: stretches to the form width by default. In the dialog this is the full dialog content width (`sm:max-w-lg` minus padding). In settings it's `max-w-2xl` because `<ByokKeyForm className="max-w-2xl">` is passed by the consumer ([_app.settings.organization.ai-provider.tsx:316, :338](../src/routes/_app.settings.organization.ai-provider.tsx#L316-L338)) — no extra work to inherit that width.
- No additional `className` overrides needed.

### Typography
- `AlertTitle` is `font-medium` ([alert.tsx:38](../src/components/ui/alert.tsx#L38)) — matches the screenshot's bolded headline.
- `AlertDescription` is `text-muted-foreground text-xs/relaxed` ([alert.tsx:54](../src/components/ui/alert.tsx#L54)) — matches the screenshot's lighter body copy.
- No font-family or size overrides — defaults are correct.

### Icon placement
The `Info` icon sits to the left of the title in row 1, with the description in row 2 column 2 — the Alert primitive's grid handles this automatically (`*:[svg]:row-span-2 has-[>svg]:grid-cols-[auto_1fr]`, [alert.tsx:6](../src/components/ui/alert.tsx#L6)). Pass `size-4` so it visually balances against the title; the primitive's default `size-3.5` is also acceptable but slightly small next to a `font-medium` title.

### No icon-less variant needed
The mock shows no icon in the header itself — but adding one helps signal "informational note, not an error." Both invite-member-dialog informational alerts include `<InfoIcon className="size-4" />`. Match that. If the user prefers no icon after seeing it in the browser, simply remove the `<Info … />` line; the `Alert` grid degrades cleanly to a single column.

---

## Files Changed

### Modified
| File | Change |
|---|---|
| [src/components/byok/byok-key-form.tsx](../src/components/byok/byok-key-form.tsx) | Add `AlertTitle` to the existing `@/components/ui/alert` import; insert the `<Alert>` block as the first child of the `<form>` body (above the Provider `<ToggleGroup>`). |

### New
None.

### Deleted
None.

No backend changes. No API changes. No prop additions. No new component files.

---

## Implementation Order

1. **Edit [src/components/byok/byok-key-form.tsx](../src/components/byok/byok-key-form.tsx):**
   - Line 2: Add `AlertTitle` to the named imports from `@/components/ui/alert`.
   - Line 73 (before the existing `<div className="space-y-2"><Label>Provider</Label>…`): insert the `<Alert>` block from the "Code" section above.
2. **Run `bun run typecheck`** to confirm no import or type errors.
3. **Run `bun run dev`** and manually verify in the browser:
   - Sign in fresh, click "Add my API key" on the Free card → alert appears at the top of the dialog above the Provider pills.
   - Visit `/_app/settings/organization/ai-provider` with no configured key → alert appears at the top of the form.
   - Visit `/_app/settings/organization/ai-provider` with a configured key → alert appears under "Replace key" section above the form's Provider pills (Active key / Switch sections unaffected).
   - Toggle through each provider (OpenRouter, Anthropic, OpenAI, Bedrock) → alert text does not change (it's static).
   - Resize down to a mobile width → alert wraps cleanly, doesn't break the dialog or form layout.
4. **Run the most relevant Vitest test(s).** No existing test asserts on form copy, so this should be a no-op, but `bun run test:run --filter byok` is cheap.

No new tests are required — the change is presentational copy with no logic. If a snapshot test exists for the form, update it.

---

## Not in Scope

- **Per-provider funding deep-links.** The "Get a key ↗" link already points at each provider's key page; adding a separate "Add credits ↗" link per provider is a reasonable follow-up but not part of this change. Mention it as a candidate for a v2 if users keep hitting the same wall.
- **Detecting funding errors after submit.** The provider POST endpoint already surfaces server errors via `errorMessage`; mapping specific 402/quota errors to a richer "looks like your provider is out of credits" message is a separate, larger change touching `POST /api/orgs/:id/llm-provider`.
- **Removing or rewriting the dialog's `DialogDescription` ("Your provider bills you directly.").** The alert subsumes part of that line, but keeping the description as a short security/billing reassurance ("we don't see your key, your provider bills you") is still useful. Leave it. If the implementer feels strongly about the redundancy, a one-line edit to `<DialogDescription>` is fine, but is not required by this plan.
- **Showing the alert on the Active key section** of the settings page (when a key is already saved and working). The user only encounters the funding gotcha while *adding* a key, so the alert is contextual to the form. Don't duplicate it above the Active key block.
- **Localisation / i18n.** The codebase isn't internationalised; ship in English only, matching the rest of the app.
