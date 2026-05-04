# BYOK Provider Info Card Plan (v2)

> Supersedes [byok-credits-alert-plan.md](./byok-credits-alert-plan.md). The previous plan added a single static credits alert above the form. The user iterated on the design: the alert is now per-provider, sits below the provider toggle (not above it), and is paired with provider-specific onboarding steps and a moved "Get a key ↗" link. **The implementer must remove the v1 alert** as part of this change — see "Undoing v1" below.

## Problem

The v1 credits alert was a static, provider-agnostic banner. It worked, but two pieces of feedback came back:

1. **It's intimidating without context.** Pasting an API key is most users' first ever interaction with a model provider. We don't tell them what they're choosing or what steps they need to follow on the provider's site. The "credits" warning hits them out of context.
2. **The credits warning lives in the wrong spot.** Above the provider toggle, it's read before the user knows which provider they're picking — so the warning can't speak to that provider specifically. (E.g. "load credits in the OpenRouter dashboard" is more useful than "load credits with the provider".)

The new design moves provider education *into the picker*: when you toggle to OpenRouter, you see what OpenRouter is, what to do on their site, where to get a key, and what their specific funding gotcha is. Toggle to Anthropic and the card swaps to Anthropic's content.

---

## Goal

Replace the static `<Alert>` above the form with a **per-provider info card** that lives between the provider toggle and the API key input. The card has three sections:

1. **Description** — one sentence explaining what the provider is / what models you get.
2. **Numbered onboarding steps** — 3 short, actionable items so the user knows how to set up an account on the provider's site. (Bedrock is different — see below.)
3. **"Your API key needs credits to work" warning** — provider-specific copy below a separator.

The "Get a key ↗" link moves *into the card* (between the steps and the warning), removing the inline link currently sitting next to the API key label. The `provider.modelCoverage` line under the input also disappears — its content is subsumed by the description at the top of the card.

Bedrock gets a different shape: no numbered steps (the user doesn't have a clean "do these 3 things" path on AWS), replaced by an enterprise-flavored paragraph; and a different second-section warning since AWS bills directly rather than via prepaid credits.

---

## Mock (provided by user)

The user-supplied screenshot shows OpenRouter selected:

```
Provider
[ OpenRouter ]  [ Anthropic ]  [ OpenAI ]  [ Bedrock ]
   ^selected

┌────────────────────────────────────────────────────────────────────────┐
│  OpenRouter gives you access to Claude, GPT, Gemini, Grok, and many   │
│  open-source models through a single key.                              │
│                                                                        │
│   1.  Create an OpenRouter account                                     │
│   2.  Load credits onto your account                                   │
│   3.  Generate an API key                                              │
│                                                                        │
│  Get a key →                                                           │
│  ──────────────────────────────────────────────────────────────────── │
│  Your API key needs credits to work                                    │
│  OpenRouter lets you generate a key without adding a payment method,   │
│  but it won't process messages until you add a card and purchase       │
│  credits.                                                              │
└────────────────────────────────────────────────────────────────────────┘

OpenRouter API key
┌────────────────────────────────────────────────────────────────────────┐
│ sk-or-v1...                                                            │
└────────────────────────────────────────────────────────────────────────┘

                                                            [ Replace key ]
```

---

## ASCII Designs (per provider)

### OpenRouter

```
┌────────────────────────────────────────────────────────────────────────┐
│  OpenRouter gives you access to Claude, GPT, Gemini, Grok, and many   │
│  open-source models through a single key.                              │
│                                                                        │
│   1.  Create an OpenRouter account                                     │
│   2.  Load credits onto your account                                   │
│   3.  Generate an API key                                              │
│                                                                        │
│  Get a key →                                                           │
│  ──────────────────────────────────────────────────────────────────── │
│  Your API key needs credits to work                                    │
│  OpenRouter lets you generate a key without adding a payment method,   │
│  but it won't process messages until you add a card and purchase       │
│  credits.                                                              │
└────────────────────────────────────────────────────────────────────────┘
```

### Anthropic

```
┌────────────────────────────────────────────────────────────────────────┐
│  Anthropic gives you direct access to the Claude family — Sonnet,     │
│  Opus, and Haiku.                                                      │
│                                                                        │
│   1.  Create an Anthropic Console account                              │
│   2.  Add a payment method and load credits                            │
│   3.  Generate an API key                                              │
│                                                                        │
│  Get a key →                                                           │
│  ──────────────────────────────────────────────────────────────────── │
│  Your API key needs credits to work                                    │
│  Anthropic lets you generate a key without adding a payment method,    │
│  but it won't process messages until you load credits in the Console.  │
└────────────────────────────────────────────────────────────────────────┘
```

### OpenAI

```
┌────────────────────────────────────────────────────────────────────────┐
│  OpenAI gives you direct access to GPT and Codex models from the      │
│  makers of ChatGPT.                                                    │
│                                                                        │
│   1.  Create an OpenAI Platform account                                │
│   2.  Add a payment method and load credits                            │
│   3.  Generate an API key                                              │
│                                                                        │
│  Get a key →                                                           │
│  ──────────────────────────────────────────────────────────────────── │
│  Your API key needs credits to work                                    │
│  OpenAI lets you generate a key without adding a payment method, but   │
│  it won't process messages until you load credits on the Platform.     │
└────────────────────────────────────────────────────────────────────────┘
```

### Bedrock (different shape)

```
┌────────────────────────────────────────────────────────────────────────┐
│  Bedrock runs Claude models inside your own AWS account, billed       │
│  through your existing AWS bill.                                       │
│                                                                        │
│  Best suited for teams already using AWS. Setting up Bedrock           │
│  involves an AWS account, IAM permissions, and granting Claude         │
│  model access in the region you'll use.                                │
│                                                                        │
│  Open the AWS Bedrock console →                                        │
│  ──────────────────────────────────────────────────────────────────── │
│  Bedrock requires model access                                         │
│  AWS will bill usage on your account automatically, but your key       │
│  won't return responses until you request Claude model access in       │
│  the Bedrock console for the region you select below.                  │
└────────────────────────────────────────────────────────────────────────┘
```

Note: For Bedrock the numbered steps are replaced with a single paragraph (`enterpriseNote`) and the warning section's title/body are different. Same outer shape (rounded card with separator), so visually consistent with the other three.

---

## Bedrock Research Notes

The user wasn't sure about Bedrock's setup steps and suggested we either skip them or mention "enterprise." Here's what's actually true, so the implementer can adjust copy if needed:

- **Not enterprise-only.** Anyone can sign up for AWS and use Bedrock — but it's substantially more involved than the other three.
- **AWS account requires a payment method at signup.** Unlike OpenAI/Anthropic/OpenRouter, you can't generate a Bedrock key without payment on file. So the v1 "credits" framing genuinely doesn't apply.
- **The real Bedrock gotcha is model access.** Claude models on Bedrock require a per-region access request via the Bedrock console (Settings → "Model access"). Keys are valid before access is granted but return `AccessDeniedException` until it is. This is the issue worth surfacing.
- **Bedrock long-term API keys** were added by AWS in 2024; that's what we accept here. Older IAM access-key flows still work but aren't what most users will paste.
- **Region matters.** Different models are available in different regions; the form already has a region picker for this reason.

The recommendation: keep the second section, but reframe it from "needs credits" to "needs model access" — that's the actual Bedrock blocker. Title and body shown in the ASCII above.

If the user prefers to drop the second section entirely for Bedrock (just description + enterprise paragraph + Get a key link, no separator, no warning), the implementation guidance below covers both shapes.

---

## Data Changes — `src/lib/byok-providers.ts`

Extend `ByokProviderMeta` with the new content fields. Remove `modelCoverage` (its content is subsumed by `description`). Keep `getKeyUrl` (the "Get a key" link still uses it, just from a new location).

```ts
export interface ByokProviderMeta {
  value: OnboardingByokProvider;
  label: string;
  fieldLabel: string;
  placeholder: string;
  getKeyUrl: string;
  getKeyLinkLabel: string;       // NEW — usually "Get a key"; Bedrock = "Open the AWS Bedrock console"
  requiresRegion: boolean;

  // NEW — provider info card content
  description: string;           // 1-2 sentences, "what is X / what models you get"
  steps?: string[];              // numbered onboarding steps; absent for Bedrock
  enterpriseNote?: string;       // Bedrock-only paragraph that replaces steps
  warning: {
    title: string;
    body: string;
  };
}
```

Exactly one of `steps` or `enterpriseNote` is present per provider — use a runtime invariant in the rendering component (`provider.steps ?? renderEnterpriseNote(provider.enterpriseNote)`).

### Full populated record

```ts
export const BYOK_PROVIDERS: Record<OnboardingByokProvider, ByokProviderMeta> = {
  openrouter: {
    value: "openrouter",
    label: "OpenRouter",
    fieldLabel: "OpenRouter API key",
    placeholder: "sk-or-v1...",
    getKeyUrl: "https://openrouter.ai/settings/keys",
    getKeyLinkLabel: "Get a key",
    requiresRegion: false,
    description:
      "OpenRouter gives you access to Claude, GPT, Gemini, Grok, and many open-source models through a single key.",
    steps: [
      "Create an OpenRouter account",
      "Load credits onto your account",
      "Generate an API key",
    ],
    warning: {
      title: "Your API key needs credits to work",
      body: "OpenRouter lets you generate a key without adding a payment method, but it won't process messages until you add a card and purchase credits.",
    },
  },

  anthropic: {
    value: "anthropic",
    label: "Anthropic",
    fieldLabel: "Anthropic API key",
    placeholder: "sk-ant-...",
    getKeyUrl: "https://console.anthropic.com/settings/keys",
    getKeyLinkLabel: "Get a key",
    requiresRegion: false,
    description:
      "Anthropic gives you direct access to the Claude family — Sonnet, Opus, and Haiku.",
    steps: [
      "Create an Anthropic Console account",
      "Add a payment method and load credits",
      "Generate an API key",
    ],
    warning: {
      title: "Your API key needs credits to work",
      body: "Anthropic lets you generate a key without adding a payment method, but it won't process messages until you load credits in the Console.",
    },
  },

  openai: {
    value: "openai",
    label: "OpenAI",
    fieldLabel: "OpenAI API key",
    placeholder: "sk-...",
    getKeyUrl: "https://platform.openai.com/api-keys",
    getKeyLinkLabel: "Get a key",
    requiresRegion: false,
    description:
      "OpenAI gives you direct access to GPT and Codex models from the makers of ChatGPT.",
    steps: [
      "Create an OpenAI Platform account",
      "Add a payment method and load credits",
      "Generate an API key",
    ],
    warning: {
      title: "Your API key needs credits to work",
      body: "OpenAI lets you generate a key without adding a payment method, but it won't process messages until you load credits on the Platform.",
    },
  },

  bedrock: {
    value: "bedrock",
    label: "Bedrock",
    fieldLabel: "Bedrock API key",
    placeholder: "Enter your AWS Bedrock API key",
    getKeyUrl: "https://console.aws.amazon.com/bedrock/",
    getKeyLinkLabel: "Open the AWS Bedrock console",
    requiresRegion: true,
    description:
      "Bedrock runs Claude models inside your own AWS account, billed through your existing AWS bill.",
    enterpriseNote:
      "Best suited for teams already using AWS. Setting up Bedrock involves an AWS account, IAM permissions, and granting Claude model access in the region you'll use.",
    warning: {
      title: "Bedrock requires model access",
      body: "AWS will bill usage on your account automatically, but your key won't return responses until you request Claude model access in the Bedrock console for the region you select below.",
    },
  },
};
```

Anything still consuming `provider.modelCoverage` will fail typecheck after the field is removed — only [byok-key-form.tsx:159](../src/components/byok/byok-key-form.tsx#L159) reads it, and that line is being deleted as part of this change. `bun run typecheck` confirms.

---

## New Component — `src/components/byok/byok-provider-info-card.tsx`

Split the card out of the form so the form stays focused on inputs and the card is testable in isolation.

```tsx
import { ArrowRight } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { ByokProviderMeta } from "@/lib/byok-providers";

interface ByokProviderInfoCardProps {
  provider: ByokProviderMeta;
}

export function ByokProviderInfoCard({ provider }: ByokProviderInfoCardProps) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4 text-sm">
      <p className="text-foreground">{provider.description}</p>

      {provider.steps ? (
        <ol className="ml-5 list-decimal space-y-1.5 marker:text-muted-foreground marker:font-medium">
          {provider.steps.map((step) => (
            <li key={step} className="pl-2 text-foreground">
              {step}
            </li>
          ))}
        </ol>
      ) : provider.enterpriseNote ? (
        <p className="text-muted-foreground">{provider.enterpriseNote}</p>
      ) : null}

      <a
        href={provider.getKeyUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        {provider.getKeyLinkLabel}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </a>

      <Separator />

      <div className="space-y-1">
        <p className="font-medium text-foreground">{provider.warning.title}</p>
        <p className="text-muted-foreground">{provider.warning.body}</p>
      </div>
    </div>
  );
}
```

Notes:
- Container: `rounded-lg border bg-muted/30 p-4`. The mock shows a faintly-lighter container against the dialog/page background — `bg-muted/30` (30% muted) achieves that without competing with the surrounding card. Test against both surfaces (paywall dialog has solid card bg; settings page has plain background) and adjust to `bg-card` or `bg-muted/50` if `bg-muted/30` reads too flat.
- The existing form uses `ExternalLink` from lucide for "Get a key" with the icon to the right. The mock uses a right arrow (`→`). Use `ArrowRight` instead — matches the mock and signals "navigate within an info flow," not "leave to external" (even though it does open a new tab).
- `target="_blank" rel="noreferrer"` — same as the inline link being deleted ([byok-key-form.tsx:106-107](../src/components/byok/byok-key-form.tsx#L106-L107)).
- `<ol>` with `list-decimal marker:text-muted-foreground` gives the dimmed numbers visible in the mock. `marker:font-medium` makes the numbers slightly heavier than body text — matches the mock. `pl-2` on each `<li>` gives breathing room between number and text.
- Bedrock's `enterpriseNote` renders as a single `<p className="text-muted-foreground">` paragraph (slightly dimmer than the description, to signal "side note" rather than a primary instruction).
- The runtime invariant (steps XOR enterpriseNote) is enforced by `provider.steps ? … : provider.enterpriseNote ? … : null`. Both being missing renders nothing — fail-soft. Both being present is impossible by data definition; if a provider gets both later, steps win.

### Why a styled `<div>` and not `<Card>`

The shadcn `<Card>` primitive carries `bg-card text-card-foreground rounded-xl border shadow`. In the paywall, the dialog content already has a card background — nesting another `<Card>` looks like an inset card-on-card with too much shadow. The settings page surrounds the form with plain `<div>` sections, so a styled `<div>` blends. If we ever extract this for a standalone "compare providers" page, swapping in `<Card>` is a one-line change.

---

## Form Changes — `src/components/byok/byok-key-form.tsx`

### Imports

```ts
// REMOVE
import { ExternalLink, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
//   (Keep `Alert, AlertDescription` — still used for the errorMessage block.)
//   (Remove ExternalLink, Info, AlertTitle — no longer used here.)

// REPLACE with
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ByokProviderInfoCard } from "@/components/byok/byok-provider-info-card";
```

### JSX

Three edits inside the `<form>`:

1. **Remove the v1 alert block** at [byok-key-form.tsx:73-82](../src/components/byok/byok-key-form.tsx#L73-L82).
2. **Insert `<ByokProviderInfoCard provider={provider} />`** between the provider toggle and the API key input — i.e. as a new sibling between the closing `</div>` of the Provider toggle block (after line 108) and the opening `<div className="space-y-2">` of the API key block (before line 110).
3. **Remove the inline "Get a key" link** at [byok-key-form.tsx:111-124](../src/components/byok/byok-key-form.tsx#L111-L124) — the wrapping `<div className="flex items-center justify-between gap-3">` collapses to a single `<Label>` for the input.
4. **Remove the model coverage line** at [byok-key-form.tsx:157-160](../src/components/byok/byok-key-form.tsx#L157-L160) — its content is now in the info card's description.

### Resulting structure

```
<form>
  <div>Provider toggle</div>
  <ByokProviderInfoCard provider={provider} />     ← NEW
  <div>
    <Label>{provider.fieldLabel}</Label>           ← simplified (no inline link)
    <Input … />
    {provider.requiresRegion ? <SelectRegion /> : null}
                                                   ← model coverage line REMOVED
  </div>
  {errorMessage ? <Alert variant="destructive">…</Alert> : null}
  {footer ?? <DefaultFooter />}
</form>
```

The `space-y-4` on the form keeps the outer rhythm consistent.

---

## Undoing v1

The previous implementation added the static `<Alert>` block at lines 73-82 of `byok-key-form.tsx` (visible in the current file). That block is removed by step 1 above. The corresponding `AlertTitle` import added in v1 is also removed.

The implementer should not amend the v1 commit — make the v2 change as a new commit so history reads "added alert → replaced alert with info card" cleanly.

---

## shadcn Components Used

| Element | Component | Source |
|---|---|---|
| Card container | `<div>` styled with Tailwind (no shadcn primitive) | n/a |
| Step list | Native `<ol>` with `list-decimal` | n/a |
| In-card divider | `Separator` | [src/components/ui/separator.tsx](../src/components/ui/separator.tsx) |
| Get-a-key link | Native `<a>` with `text-primary` styling | n/a |
| Arrow icon | `ArrowRight` from `lucide-react` | already in repo |
| Error block (unchanged) | `Alert`, `AlertDescription` (variant `destructive`) | [src/components/ui/alert.tsx](../src/components/ui/alert.tsx) |

No new shadcn primitives need to be installed.

---

## Files Changed

### New
| File | Purpose |
|---|---|
| `src/components/byok/byok-provider-info-card.tsx` | The per-provider info card (description + steps OR enterprise note + Get-a-key link + separator + warning). |

### Modified
| File | Change |
|---|---|
| `src/lib/byok-providers.ts` | Remove `modelCoverage` from `ByokProviderMeta`; add `description`, `steps?`, `enterpriseNote?`, `warning`, `getKeyLinkLabel`. Populate all four providers per the data block above. |
| `src/components/byok/byok-key-form.tsx` | Remove v1 `<Alert>` block + `Info`/`AlertTitle`/`ExternalLink` imports; add `<ByokProviderInfoCard>`; drop inline "Get a key" link from the API key label row; drop model-coverage `<p>` below the input. |

### Deleted
None.

No backend or API changes. No prop additions to `ByokKeyForm`. No changes to `<ByokKeyDialog>`, `_onboarding.welcome.tsx`, or `_app.settings.organization.ai-provider.tsx` — those consumers re-render automatically via the form.

---

## Implementation Order

1. **Update `src/lib/byok-providers.ts`** with the new interface + populated record.
2. **Create `src/components/byok/byok-provider-info-card.tsx`** with the component above.
3. **Edit `src/components/byok/byok-key-form.tsx`**: remove v1 alert + its imports, add the info card, remove the inline "Get a key" link, remove the model-coverage line.
4. **`bun run typecheck`** — confirms `modelCoverage` removal didn't break a forgotten consumer.
5. **`bun run dev`** — manually verify on both surfaces:
   - Paywall: open `/welcome`, click "Add my API key" on the Free card. Toggle through OpenRouter, Anthropic, OpenAI, Bedrock — confirm description, steps (or enterprise note for Bedrock), Get-a-key link, separator, and warning all swap correctly.
   - Settings: visit `/_app/settings/organization/ai-provider`. Same toggle test in both the no-config form and the "Replace key" form when a key exists.
   - Verify "Get a key" link opens the correct provider URL in a new tab for each.
   - Verify Bedrock's region picker still appears below the API key input.
   - Resize to mobile width — card padding, ordered list, and link wrap cleanly.
6. **`bun run lint`** — catch any unused-import drift.

No new tests required — the change is presentational. If a snapshot test exists for the form, regenerate it.

---

## Open Questions for Reviewer

1. **Bedrock second section.** Plan keeps a Bedrock-specific warning ("Bedrock requires model access") to preserve visual consistency. If you'd rather drop the second section entirely for Bedrock — making its card just description + enterprise paragraph + Get-a-key link, no separator, no warning — set `warning` to `null` for Bedrock and gate the bottom section on `provider.warning ? … : null` in the component. Both shapes are easy.
2. **"Get a key" arrow vs external-link icon.** The mock shows `→`. Plan uses `ArrowRight`. If you want a clearer "opens in new tab" affordance, switch to `ExternalLink` (already imported in the codebase) — same position, same size.
3. **Card background.** Plan uses `bg-muted/30`. If that reads too subtle in the paywall dialog, bump to `bg-muted/50` or switch to `bg-card` with a slightly stronger border (`border-muted-foreground/20`).
4. **OpenRouter model list.** Mock copy lists "Claude, GPT, Gemini, Grok, and many open-source models." This is broadly accurate as of writing. If you want the list to age more gracefully, swap to "Claude, GPT, Gemini, and many other models" — drops Grok, drops "open-source" framing, less likely to need updating.
5. **Anthropic description.** Plan calls out "Sonnet, Opus, and Haiku." If a new tier ships, this becomes stale. Alternative: "Anthropic gives you direct access to the full Claude model family." Pick whichever the design lead prefers.

---

## Not in Scope

- **Per-step deep links.** The mock's numbered steps are plain text. Could become links to provider docs (e.g. step 1 → "Create account" link), but the user didn't ask for this and it adds maintenance burden.
- **Localisation.** English only, matching the rest of the app.
- **Dynamic step content.** Steps are static strings. We're not fetching from provider APIs or detecting partial setup.
- **Provider comparison view.** The info card is per-selected-provider; we are not building a side-by-side compare table.
- **Telemetry.** No event tracking added for "info card seen" or "Get a key clicked." If we want this, do it as a separate change so the UI plan stays focused.
