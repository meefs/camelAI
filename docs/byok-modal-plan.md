# BYOK API Key Modal Plan

## Problem

Today, clicking "Add my API key" on the Free tier in the paywall ([_onboarding.welcome.tsx:345-347](src/routes/_onboarding.welcome.tsx#L345-L347)) toggles `showByokForm`, which renders [`<ByokProviderForm>`](src/components/onboarding/byok-provider-form.tsx) inline below the paywall grid. This:

1. **Pushes the paywall out of view** — the form drops in below, scrolling the cards off screen, so the user loses the comparison context they were just looking at.
2. **Mixes two flows on one page** — the visual hierarchy now competes between "pick a plan" (cards) and "fill out this form" (the BYOK card).
3. **Feels like a UI bug** — a card materializing inline is an unusual pattern; it looks like the page errored and re-rendered.
4. **Provider picker uses radio cards with helper paragraphs** — visually heavy. The mock simplifies to three labeled pill buttons (provider name only).

The mock turns "Add my API key" into a focused modal: pick provider → paste key → continue. One job, one surface, paywall stays visible behind the dimmed overlay.

---

## Goal

Replace the inline `<ByokProviderForm>` with a `<ByokKeyDialog>` modal that:

1. Opens when the user clicks "Add my API key" on the Free tier card (or any future BYOK CTA).
2. Shows **four** provider pill buttons (OpenRouter, Anthropic, OpenAI, AWS Bedrock), defaulting to OpenRouter.
3. Renders a single `<Input>` for the API key with a contextual placeholder + "Get a key ↗" link in the field's top-right corner.
4. **Conditionally renders an AWS region `<Select>`** when Bedrock is selected (Bedrock requires region in addition to the bearer token — see [api/orgs.$id.llm-provider.ts:130-139](src/routes/api/orgs.$id.llm-provider.ts#L130-L139)).
5. **Surfaces a lightweight "what models you'll get" note** under the input that updates per provider, so the user understands the consequence of their choice before pasting a key.
6. Submits via the existing `POST /api/orgs/:id/llm-provider` flow (no API change).
7. Closes on success and continues onboarding identically to today's flow.
8. Reuses the canonical provider URLs already defined in [_app.settings.organization.ai-provider.tsx:106-165](src/routes/_app.settings.organization.ai-provider.tsx#L106-L165) — don't duplicate them.

---

## ASCII Design

```
┌──────────────────────────────────────────────────────────────────┐
│                                                              [X] │
│  Add your API key                                                │  ← DialogTitle (display font)
│  Your provider bills you directly. We never see your             │  ← DialogDescription
│  key after setup.                                                │
│                                                                  │
│  Provider                                                        │  ← Label
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │OpenRouter│ │Anthropic │ │  OpenAI  │ │ Bedrock  │            │  ← 4 ToggleGroup pills
│  └══════════┘ └──────────┘ └──────────┘ └──────────┘            │     (selected = ring + bg-accent)
│                                                                  │
│  OpenRouter API key                       Get a key ↗            │  ← Label + right-aligned link
│  ┌────────────────────────────────────────────────────────┐     │
│  │ sk-or-...                                               │     │  ← Input type=password
│  └────────────────────────────────────────────────────────┘     │
│  ⓘ Any model — Claude, GPT, Gemini, and more via OpenRouter.    │  ← Model coverage note (per-provider)
│                                                                  │
│  ────────────────────────────────────────────────────────       │  ← Separator
│                                                                  │
│                                              [    Continue    ]  │  ← Footer button (right-aligned)
└──────────────────────────────────────────────────────────────────┘
```

When **Bedrock** is selected, an additional `<Select>` row appears between the API key input and the model coverage note:

```
│  Bedrock API key                          Get a key ↗            │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ ABSK...                                                 │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
│  AWS Region                                                      │  ← Label
│  ┌────────────────────────────────────────────────────────┐     │
│  │ US East (N. Virginia) (us-east-1)              ▾        │     │  ← Select
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
│  ⓘ Claude models only, served from your AWS account.            │  ← Model coverage note
```

The provider pill highlights with `data-[state=on]:bg-accent` (already in the ToggleGroup primitive). Pills are equal-width via `grid grid-cols-3 gap-2` so the row doesn't shift when the selection changes.

---

## Component Structure

### New file: `src/components/onboarding/byok-key-dialog.tsx`

```tsx
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ExternalLink } from "lucide-react";
import { BYOK_PROVIDERS, type OnboardingByokProvider } from "@/lib/byok-providers";

interface ByokKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedProvider: OnboardingByokProvider;
  onProviderChange: (provider: OnboardingByokProvider) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  awsRegion: string;                              // Bedrock only; ignored for other providers
  onAwsRegionChange: (region: string) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  errorMessage?: string | null;
}
```

Internally it composes shadcn `Dialog` + `ToggleGroup` + `Input` + `Button`.

### New file: `src/lib/byok-providers.ts`

Single source of truth for provider metadata. Hoist out of the existing `BYOK_PROVIDER_OPTIONS` in [byok-provider-form.tsx:19-38](src/components/onboarding/byok-provider-form.tsx#L19-L38) and merge with the canonical URLs from [_app.settings.organization.ai-provider.tsx:106-165](src/routes/_app.settings.organization.ai-provider.tsx#L106-L165).

```ts
import type { LlmProvider } from "@/types";

export type OnboardingByokProvider = Extract<
  LlmProvider,
  "anthropic" | "openai" | "openrouter" | "bedrock"
>;

export interface ByokProviderMeta {
  value: OnboardingByokProvider;
  label: string;             // pill label, e.g. "OpenRouter" or "Bedrock"
  fieldLabel: string;        // input label, e.g. "OpenRouter API key"
  placeholder: string;       // input placeholder, e.g. "sk-or-..."
  modelCoverage: string;     // lightweight note shown under the input — see "Model coverage copy" below
  getKeyUrl: string;         // link to provider's key creation page
  requiresRegion: boolean;   // true for Bedrock — renders the AWS region select
}

export const BYOK_PROVIDERS: Record<OnboardingByokProvider, ByokProviderMeta> = {
  openrouter: {
    value: "openrouter",
    label: "OpenRouter",
    fieldLabel: "OpenRouter API key",
    placeholder: "sk-or-...",
    modelCoverage: "Any model — Claude, GPT, Gemini, and more via OpenRouter.",
    getKeyUrl: "https://openrouter.ai/settings/keys",
    requiresRegion: false,
  },
  anthropic: {
    value: "anthropic",
    label: "Anthropic",
    fieldLabel: "Anthropic API key",
    placeholder: "sk-ant-...",
    modelCoverage: "Claude models only.",
    getKeyUrl: "https://console.anthropic.com/settings/keys",
    requiresRegion: false,
  },
  openai: {
    value: "openai",
    label: "OpenAI",
    fieldLabel: "OpenAI API key",
    placeholder: "sk-...",
    modelCoverage: "GPT and Codex models only.",
    getKeyUrl: "https://platform.openai.com/api-keys",
    requiresRegion: false,
  },
  bedrock: {
    value: "bedrock",
    label: "Bedrock",
    fieldLabel: "Bedrock API key",
    placeholder: "Enter your AWS Bedrock API key",
    modelCoverage: "Claude models only, served from your AWS account.",
    getKeyUrl: "https://console.aws.amazon.com/bedrock/",
    requiresRegion: true,
  },
};

export const BYOK_PROVIDER_ORDER: OnboardingByokProvider[] = [
  "openrouter",
  "anthropic",
  "openai",
  "bedrock",
];
```

### Model coverage copy — why it matters

> "I think it should be a pretty lightweight message to them."

The user picking a provider key is also implicitly picking which models they get access to. If they paste an Anthropic key and then later want to ask GPT something, they'll be confused why GPT isn't available. Surfacing the coverage *before* they paste the key prevents that surprise.

The copy is intentionally one short sentence per provider — no bullets, no acronyms (no "LLMs"), no marketing language. Just: "what models will I have if I pick this?" Format:

| Provider | Note shown under input |
|---|---|
| OpenRouter | "Any model — Claude, GPT, Gemini, and more via OpenRouter." |
| Anthropic | "Claude models only." |
| OpenAI | "GPT and Codex models only." |
| Bedrock | "Claude models only, served from your AWS account." |

Visual treatment: a small `Info` icon (`size-3.5 text-muted-foreground`) inline-flex'd before the text, both at `text-xs text-muted-foreground`. This sits where the previous "helper" line did — same row, same styling, just communicating something more useful.

### AWS regions (Bedrock only)

The settings page already exports a `VALID_AWS_REGIONS` list and renders an `AWS_REGIONS` array of `{value, label}` for the `<Select>`. Reuse those — do not re-define. Hoist them into `src/lib/byok-providers.ts` as well so both the dialog and the settings page consume one list:

```ts
export const AWS_REGIONS = [
  { value: "us-east-1", label: "US East (N. Virginia)" },
  // ... copy the existing list from _app.settings.organization.ai-provider.tsx verbatim
];
```

Default the dialog's region state to `"us-east-1"` (matches the settings page default at [_app.settings.organization.ai-provider.tsx:277](src/routes/_app.settings.organization.ai-provider.tsx#L277)).

### Provider URLs (verified)

These four URLs are already in production use in the settings page and are correct as of this writing. **Do not look them up again or change them** — reuse exactly.

| Provider | URL |
|---|---|
| OpenRouter | `https://openrouter.ai/settings/keys` |
| Anthropic | `https://console.anthropic.com/settings/keys` |
| OpenAI | `https://platform.openai.com/api-keys` |
| Bedrock | `https://console.aws.amazon.com/bedrock/` |

If a provider URL ever changes, update [src/lib/byok-providers.ts](src/lib/byok-providers.ts) once and both the dialog and the settings page will reflect it. Please ensure this opens in a new tab.

---

## shadcn Components Used

| Element | Component | Source |
|---|---|---|
| Modal shell | `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` | [src/components/ui/dialog.tsx](src/components/ui/dialog.tsx) |
| Provider pills | `ToggleGroup`, `ToggleGroupItem` (variant `outline`, size `lg`) | [src/components/ui/toggle-group.tsx](src/components/ui/toggle-group.tsx) |
| Field label | `Label` | [src/components/ui/label.tsx](src/components/ui/label.tsx) |
| Key input | `Input` (type `password`) | [src/components/ui/input.tsx](src/components/ui/input.tsx) |
| AWS region picker (Bedrock only) | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` | [src/components/ui/select.tsx](src/components/ui/select.tsx) |
| Footer separator | `Separator` | [src/components/ui/separator.tsx](src/components/ui/separator.tsx) |
| Continue button | `Button` (default variant, default size — to match the paywall card CTAs) | [src/components/ui/button.tsx](src/components/ui/button.tsx) |
| Coverage / external-link icons | `Info`, `ExternalLink` from `lucide-react` | (already used in repo) |

No new shadcn primitives need to be installed.

---

## Visual Details

### Dialog sizing

`DialogContent` defaults to `max-w-sm`. Override to `sm:max-w-lg` so the three provider pills fit comfortably on one row without wrapping at the smallest desktop widths.

```tsx
<DialogContent className="sm:max-w-lg">
```

### Title typography

Apply the display font on the title — same treatment as the paywall heading and the mock's "Add your API key":

```tsx
<DialogTitle className="font-[family-name:var(--font-display)] text-xl font-normal">
  Add your API key
</DialogTitle>
```

`DialogTitle` defaults to `text-sm font-medium` ([dialog.tsx:125](src/components/ui/dialog.tsx#L125)) — too small for a focused modal. Bump to `text-xl font-normal` with the display font.

### Description copy

```tsx
<DialogDescription className="text-sm">
  Your provider bills you directly. We never see your key after setup.
</DialogDescription>
```

Override `text-xs/relaxed` default ([dialog.tsx:138](src/components/ui/dialog.tsx#L138)) to `text-sm` for legibility — this is a security-adjacent statement, the user should be able to read it without squinting.

### Provider pill row

```tsx
<div className="space-y-2">
  <Label className="text-sm">Provider</Label>
  <ToggleGroup
    type="single"
    value={selectedProvider}
    onValueChange={(value) => {
      if (value) onProviderChange(value as OnboardingByokProvider);
    }}
    variant="outline"
    size="lg"
    className="grid grid-cols-4 gap-2"
  >
    {BYOK_PROVIDER_ORDER.map((key) => (
      <ToggleGroupItem
        key={key}
        value={key}
        className="h-11 text-sm font-medium"
      >
        {BYOK_PROVIDERS[key].label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
</div>
```

Notes:
- `grid-cols-4` so all four providers fit on one row at the dialog's `sm:max-w-lg` width. Pill labels are kept short (`Bedrock`, not `AWS Bedrock`) to fit comfortably.
- `type="single"` ensures exactly one is selected (Radix ToggleGroup default is `multiple`).
- The `if (value)` guard handles the case where the user clicks the already-selected pill — Radix would otherwise emit `""` and clear the selection. We always want a provider selected.
- `h-11` overrides the toggle-group `lg` size (`h-8`) — the mock has chunkier pills. Add `data-[state=on]:ring-2 data-[state=on]:ring-primary` if the default `bg-accent` highlight isn't strong enough against the dialog background; check in the browser before adding.

### Key input + "Get a key" link

```tsx
<div className="space-y-2">
  <div className="flex items-center justify-between">
    <Label htmlFor="byok-api-key" className="text-sm">
      {provider.fieldLabel}
    </Label>
    <a
      href={provider.getKeyUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
    >
      Get a key
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  </div>
  <Input
    id="byok-api-key"
    type="password"
    autoComplete="off"
    autoFocus
    value={apiKey}
    placeholder={provider.placeholder}
    onChange={(event) => onApiKeyChange(event.target.value)}
    className="h-11 font-mono text-sm"
  />
  {provider.requiresRegion ? (
    <div className="space-y-2 pt-2">
      <Label htmlFor="byok-aws-region" className="text-sm">AWS Region</Label>
      <Select value={awsRegion} onValueChange={onAwsRegionChange}>
        <SelectTrigger id="byok-aws-region" className="h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AWS_REGIONS.map((region) => (
            <SelectItem key={region.value} value={region.value}>
              {region.label} ({region.value})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  ) : null}
  <p className="inline-flex items-start gap-1.5 text-xs text-muted-foreground">
    <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    <span>{provider.modelCoverage}</span>
  </p>
</div>
```

Notes:
- `font-mono` on the input matches the mock — API keys read better in mono and it signals "this is a token, not prose."
- `h-11` overrides the Input default `h-7` ([input.tsx:11](src/components/ui/input.tsx#L11)) so the field matches the pill height and feels appropriately weighty for a paste target.
- `autoFocus` lands the cursor in the input on open. Most users open the dialog already holding their key in clipboard.
- The label/link share a row via `flex items-center justify-between`. The link uses `text-primary` (the brand blue) so it visually anchors to the right edge.
- The region select **only renders when `provider.requiresRegion` is true** — i.e. Bedrock. For the other three providers, the input flows directly to the model coverage note. This avoids hiding/showing extra rows for providers that don't need them.
- The model coverage note sits at the bottom of the field stack (below the region select when present, below the input otherwise) so it's the last thing the user reads before the Continue button — exactly when they're deciding whether to proceed.

### Footer

```tsx
<DialogFooter className="border-t border-border pt-4">
  <Button
    type="button"
    onClick={onSubmit}
    disabled={isSubmitting || apiKey.trim().length === 0}
  >
    {isSubmitting ? "Saving…" : "Continue"}
  </Button>
</DialogFooter>
```

The mock shows a horizontal divider above the footer — render via `border-t border-border pt-4` on `DialogFooter` (the primitive doesn't include a divider by default). `DialogFooter` already does `sm:justify-end` so the button sits at the right.

### Error state

When the provider request fails, render the error inside the dialog above the footer (not as a toast — the user is mid-form):

```tsx
{errorMessage ? (
  <Alert variant="destructive">
    <AlertDescription>{errorMessage}</AlertDescription>
  </Alert>
) : null}
```

---

## Welcome Route Integration

In [_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx):

### State changes

- Replace `const [showByokForm, setShowByokForm] = useState(false)` with `const [byokDialogOpen, setByokDialogOpen] = useState(false)`.
- Add `const [awsRegion, setAwsRegion] = useState("us-east-1")` for the Bedrock region picker.
- The existing `selectedProvider` state's type widens from `OnboardingByokProvider` (3 providers) to the new 4-provider union (just consume the updated type from `@/lib/byok-providers`).

### CTA wiring

[_onboarding.welcome.tsx:345-347](src/routes/_onboarding.welcome.tsx#L345-L347) — change:

```tsx
if (cta.kind === "byok") {
  setShowByokForm(true);
  return;
}
```

to:

```tsx
if (cta.kind === "byok") {
  setByokDialogOpen(true);
  return;
}
```

### Render

[_onboarding.welcome.tsx:370-387](src/routes/_onboarding.welcome.tsx#L370-L387) — replace the inline `<ByokProviderForm>` block with:

```tsx
<ByokKeyDialog
  open={byokDialogOpen}
  onOpenChange={(open) => {
    setByokDialogOpen(open);
    if (!open) setError(null);
  }}
  selectedProvider={selectedProvider}
  onProviderChange={(provider) => {
    setSelectedProvider(provider);
    setError(null);
  }}
  apiKey={providerApiKey}
  onApiKeyChange={(key) => {
    setProviderApiKey(key);
    setError(null);
  }}
  awsRegion={awsRegion}
  onAwsRegionChange={(region) => {
    setAwsRegion(region);
    setError(null);
  }}
  onSubmit={saveProviderAndContinue}
  isSubmitting={isSavingProvider || isCompleting}
  errorMessage={error ?? providerError ?? null}
/>
```

The dialog is rendered unconditionally inside the `isBillingChoiceRequired` branch — Radix Dialog handles the open/closed state via the `open` prop and portals out of the DOM tree when closed, so it doesn't impact paywall layout.

### Auto-close on success

[_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx) currently navigates to chat in the existing `useEffect` that watches `providerFetcher.data?.success`. Add `setByokDialogOpen(false)` inside that effect so the dialog closes before navigation begins. (The dialog will also unmount when the route changes, but explicitly closing it makes the close animation play correctly.)

### Error surfacing

The current welcome.tsx renders `error`, `checkoutError`, and `providerError` as separate `<Alert>` blocks above the paywall ([_onboarding.welcome.tsx:317-333](src/routes/_onboarding.welcome.tsx#L317-L333)). With the modal, `providerError` should render *inside* the dialog instead of above the paywall. Keep the page-level alerts for `checkoutError` (Stripe failures) and the BYOK validation error (`error`) only when the dialog is closed.

The cleanest split:
- Errors that originated from the dialog form (`providerError`, BYOK-side `error`) → `errorMessage` prop on the dialog.
- Errors from the trial checkout fetcher (`checkoutError`) → keep as page-level alert.

---

## Delete

Once the dialog is wired in:

- **Delete** [src/components/onboarding/byok-provider-form.tsx](src/components/onboarding/byok-provider-form.tsx) — fully replaced by `<ByokKeyDialog>`. No other consumers (verified via the welcome route being the only import).
- **Remove the `ByokProviderForm` and `OnboardingByokProvider` imports** in [_onboarding.welcome.tsx:16-19](src/routes/_onboarding.welcome.tsx#L16-L19); replace with imports from `@/lib/byok-providers` and the new dialog.

---

## Files Changed

### New
| File | Purpose |
|---|---|
| `src/components/onboarding/byok-key-dialog.tsx` | The modal: dialog shell, provider pills, key input, footer |
| `src/lib/byok-providers.ts` | Shared metadata: label, placeholder, helper, getKeyUrl, type |

### Modified
| File | Change |
|---|---|
| `src/routes/_onboarding.welcome.tsx` | Swap `showByokForm` state for `byokDialogOpen`; replace `<ByokProviderForm>` with `<ByokKeyDialog>`; route `providerError` into the dialog instead of page-level alert; close dialog in the success effect |
| `src/routes/_app.settings.organization.ai-provider.tsx` | Add `// FIXME(byok): consume BYOK_PROVIDERS from @/lib/byok-providers` comment at the top of `PROVIDER_GUIDES` to flag duplication for a follow-up |

### Deleted
| File | Why |
|---|---|
| `src/components/onboarding/byok-provider-form.tsx` | Fully replaced by the dialog; only consumer was the welcome route |

No backend or API changes. The dialog submits to the same `POST /api/orgs/:id/llm-provider` endpoint via the existing `providerFetcher`.

---

## Behavior Details

### Default selection
On open, default to OpenRouter (matches today's default in [byok-provider-form.tsx:21](src/components/onboarding/byok-provider-form.tsx#L21)). Reason: OpenRouter is "one key for Claude + Codex" — strictly more capable than picking either single-provider option, so it's the safest default for users who don't yet know what they want.

### Closing without saving
- Clicking the X, pressing Escape, or clicking the overlay closes the dialog (Radix default).
- Closing **does not clear** `providerApiKey` or `selectedProvider` state — re-opening restores what they typed. (Implemented for free since state lives in welcome.tsx, not the dialog.)
- Closing **clears `error`** so the next open is clean (handled in `onOpenChange` above).

### Submit while empty
The Continue button is disabled when `apiKey.trim().length === 0`. No need for a "please enter a key" toast — the disabled state communicates it.

### Enter-to-submit
Wrap the dialog body in a `<form onSubmit={...}>` so pressing Enter inside the input triggers Continue. Prevents the default form action and calls `onSubmit()`. This is the expected behavior for a single-input form and is currently missing from the inline form.

### Esc behavior during submit
While `isSubmitting`, ignore the Escape key (Radix `onEscapeKeyDown` with `event.preventDefault()`). The user shouldn't be able to abort halfway through the provider POST and end up in an inconsistent state.

---

## Implementation Order

1. **Create `src/lib/byok-providers.ts`** — pure data, no rendering. Easy to review.
2. **Create `src/components/onboarding/byok-key-dialog.tsx`** — render the modal with mock state on a scratch route to eyeball before wiring it up. Test with all three providers and verify each "Get a key" link opens the right page in a new tab.
3. **Wire into `_onboarding.welcome.tsx`** — swap state, swap render, route the error, close on success.
4. **Delete `byok-provider-form.tsx`** and clean up its imports.
5. **Add the FIXME** in the settings AI-provider page so the duplicate provider URL list is flagged.
6. **`bun run typecheck`** — verify nothing else imported `BYOK_PROVIDER_OPTIONS` or `OnboardingByokProvider` from the deleted file.
7. **Manual test** — start dev server, sign in fresh, click "Add my API key" on the Free card. Verify:
   - Modal opens centered, paywall visible behind dimmed overlay.
   - Provider pills toggle correctly; OpenRouter selected by default.
   - "Get a key" link opens the right URL in a new tab for each provider.
   - Pasting a key + Continue submits, modal closes, navigates to chat.
   - Closing and reopening preserves the typed key.
   - Submitting an invalid key shows the error inside the dialog (not as a page-level alert).
   - Pressing Enter in the input submits.

---

## Not in Scope

- **Migrating the settings AI-provider page** to use `<ByokKeyDialog>` or `BYOK_PROVIDERS` — left as a follow-up FIXME. That page has more provider options (includes Bedrock) and a multi-step setup guide that doesn't fit the modal's "one input, one button" shape.
- **Adding a Bedrock option to the modal** — Bedrock requires AWS access keys + region, not a single API key. Out of scope; if a user wants Bedrock during onboarding they can add a single-key provider here and switch in settings later.
- **Validating the key format client-side** beyond non-empty — server validation already runs in `POST /api/orgs/:id/llm-provider` and surfaces real errors (rate-limit, invalid key, missing payment method).
- **Remembering the last-used provider across sessions** — onboarding only happens once per user; not worth the storage round-trip.
- **Testing key with a `models` API call before saving** — the existing endpoint already does this validation; no need to duplicate.
