# Billing, Usage, and AI Provider Settings Redesign Plan

## Problems with the Current Pages

### `/settings/organization/billing` ([_app.settings.organization.billing.tsx](src/routes/_app.settings.organization.billing.tsx))
1. **Three stat cards at the top are noisy.** Subscription status, available credits, and lifetime usage are stacked side-by-side at the top of the page. The user already knows their status — they want to see *the plan* and *what they pay*.
2. **The plan list is a flat row of "Start X" forms.** No "manage" or "upgrade/downgrade" affordance for the current plan. It's only useful for orgs that are on Free.
3. **"Open Billing Portal" is a footnote.** The single most common billing action — managing payment method, viewing invoices, cancelling — is buried as a small outline button at the bottom.
4. **Buy Credits section is on the page even though we're descoping extra usage.** The user explicitly called out: leave the extra-usage purchase flow out of this redesign.
5. **Invoices are not visible at all** — users currently have to click into the Stripe Billing Portal to find them. The user noted "we get a lot of requests from customers about asking for their invoices."
6. **There's no quick "Cancel" affordance** for an active subscriber, even though the user wants one near the bottom of the page.

### `/settings/organization/usage` ([_app.settings.organization.usage.tsx](src/routes/_app.settings.organization.usage.tsx))
1. **Cramped and duplicated.** Three stat cards (Lifetime Usage, Available Credits, Subscription) sit on top of a Chargeable Usage card that re-shows two of the same numbers. Subscription status doesn't belong here — it's already on `/billing`.
2. **Window-cap progress bars and the request log are visually fine,** but they sit below a stack of redundant cards, so users have to scroll past the redundancy to reach the actually useful information.
3. **Doesn't acknowledge BYOK reality.** The page assumes hosted-credit usage is the only mode. For Free users (BYOK only), or paid users who have switched to BYOK, "Available Credits" and "Total Credits" are misleading because their actual LLM cost is happening on the BYOK provider's side and not on our credit balance.
4. **No clear "what happens when I run out of included credits?" framing.** The user mentioned the AI provider page is "complicated" — but this page is the one that should make the credit/BYOK relationship obvious.

### `/settings/organization/ai-provider` ([_app.settings.organization.ai-provider.tsx](src/routes/_app.settings.organization.ai-provider.tsx))
1. **Five-option radio list with descriptions.** Visually heavy and inconsistent with the four-pill `ToggleGroup` we just shipped in [byok-key-dialog.tsx](src/components/onboarding/byok-key-dialog.tsx).
2. **Custom Collapsible-based "How to get your API key" guide.** Duplicates the simpler "Get a key ↗" link pattern from the BYOK dialog.
3. **Per-provider input state is split across four `useState` calls** (`apiKey`, `openAiApiKey`, `openRouterApiKey`, `bearerToken`) — four refs for what should be one input. This survives the redesign because the field is shown at most once per provider, but the visual treatment can match the dialog directly.
4. **Doesn't reuse `BYOK_PROVIDERS` from [src/lib/byok-providers.ts](src/lib/byok-providers.ts).** The BYOK dialog redesign already flagged this with a FIXME. The settings page reimplements provider metadata, URLs, and copy.

### Settings nav order ([settings-nav.tsx:30-38](src/components/settings/settings-nav.tsx#L30-L38))
The Organization group currently lists:
```
General, Team, Workspaces, Billing, AI Provider, Experimental, Usage, Domains
```
The user wants Billing → AI Provider → Usage to sit together (and in that order). The Experimental tab is being deleted entirely as part of this redesign:
```
General, Team, Workspaces, Billing, AI Provider, Usage, Domains
```

---

## Design Goals

- **Match the visual density and layout pattern** used by Anthropic's Claude billing/usage pages (single column, headed sections, tabular invoices, prominent primary action).
- **No nested containers.** Match the [Workspaces](src/routes/_app.settings.organization.workspaces.tsx) and [Profile](src/routes/_app.settings.profile.tsx) settings pages: `SettingsHeader` + `Separator` + plain section headings + content rendered directly on the page background. **Sections are not cards.** Plan summary, Payment row, Invoices, Credit balance, Top-up, BYOK indicator, and the AI-Provider active-key area all render as plain typography and inputs — no `Card` wrappers around them. A `Card` is only used when there is a clear reason (e.g. a self-contained widget surfaced next to a different surface). The destructive AlertDialogs continue to use `AlertDialog` because they are modals, not page sections.
- **Lead with the plan summary.** "What plan am I on, when does it renew, and how do I change it?" should be answerable in the first viewport.
- **One-click "Manage plan"** opens an isolated paywall view for upgrade/downgrade/manage. Reuse the existing [PlanPicker](src/components/billing/plan-picker.tsx) — it already supports `currentPlan` and emits the right CTA shape.
- **Surface invoices as a table on the page,** not behind a Stripe portal click. Each row gets a "View" link that opens the hosted invoice URL in a new tab.
- **Make the AI Provider page feel like the BYOK dialog** — same `ToggleGroup`, same field treatment, same "Get a key ↗" link. Add the only thing the dialog doesn't have: a way to **delete** the existing key.
- **Out of scope: Anthropic-style "extra usage" / auto-reload purchasing.** Leave it out. A different engineer is wiring Stripe; mark new Stripe-shaped intents with `// FIXME(billing-stripe):` comments so they're easy to find.
- **Reorder the Organization nav** so Billing → AI Provider → Usage are adjacent, and **delete the Experimental tab** entirely.

---

## Settings Nav Reorder

[src/components/settings/settings-nav.tsx](src/components/settings/settings-nav.tsx) — change the Organization group's items array to:

```ts
items: [
  { label: "General", href: "/settings/organization/general" },
  { label: "Team", href: "/settings/organization/team" },
  { label: "Workspaces", href: "/settings/organization/workspaces" },
  { label: "Billing", href: "/settings/organization/billing" },
  { label: "AI Provider", href: "/settings/organization/ai-provider", adminOnly: true },
  { label: "Usage", href: "/settings/organization/usage" },
  { label: "Domains", href: "/settings/organization/domains" },
],
```

The order is updated and the **Experimental** entry is removed.

### Delete the Experimental tab

Remove the route, its registration, and its nav entry:

| File | Change |
|---|---|
| `src/routes/_app.settings.organization.experimental.tsx` | **Delete the file.** |
| `src/routes.ts:73-74` | Remove the `'settings/organization/experimental'` registration. |
| `src/components/settings/settings-nav.tsx` | Remove the Experimental nav item (already shown in the items array above). |

Do **not** touch any other code that references "experimental settings" today. The names `OrganizationExperimentalSettings`, `experimentalSettings`, `getOrganizationExperimentalSettings` show up in the Chat surface, the admin thread editor, and `llm-provider-config.ts`. Those are distinct: they're org-level model gating used at runtime, not the settings page. Keep them. The redesign only deletes the *user-facing* `/settings/organization/experimental` route. The runtime `experimentalSettings` plumbing should stay so chat/admin behavior is unchanged.

If, after deleting the route, the only remaining consumer is internal admin tooling and the user wants to also remove the runtime gating, that should be a separate cleanup PR with its own scope — flag it as a follow-up but do not include it here.

---

## Page 1: Billing

### ASCII Design — Active subscription state

```
┌──────────────────────────────────────────────────────────────────────┐
│  Billing                                                             │
│  Manage your plan, payment method, and invoices.                     │
├──────────────────────────────────────────────────────────────────────┤
│  ─────────── separator ───────────                                   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Pro plan                                    [    Manage plan  ]    │  ← Plan summary (no card)
│  $30/month in hosted credits.                                        │
│  Renews May 8, 2026.                                                 │
│                                                                      │
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Payment                                                             │
│                                                                      │
│  ▣  Visa ending in 4242                            [    Update    ]  │  ← Payment row (no card)
│                                                                      │
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Invoices                                                            │
│                                                                      │
│  Date              Total       Status     Actions                    │
│  ─────────────────────────────────────────────────────               │
│  Apr 8, 2026       $30.00      Paid       View                       │
│  Mar 8, 2026       $30.00      Paid       View                       │
│  Feb 8, 2026       $30.00      Paid       View                       │
│  ...                                                                 │
│                                                                      │
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Cancellation                                                        │
│                                                                      │
│  Cancel plan                                              [ Cancel ] │  ← Destructive button
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### ASCII Design — Free / no-subscription state

```
┌──────────────────────────────────────────────────────────────────────┐
│  Billing                                                             │
│  Manage your plan, payment method, and invoices.                     │
├──────────────────────────────────────────────────────────────────────┤
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Free plan                                  [   Choose a plan  ]    │  ← Plan summary (no card)
│  Bring your own API key. No included credits.                        │
│                                                                      │
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Payment                                                             │
│  No payment method on file.                                          │
│                                                                      │
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Invoices                                                            │
│  No invoices yet.                                                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

(No Cancellation section when there's no active subscription.)

### ASCII Design — Manage Plan view

The existing [PlanPicker](src/components/billing/plan-picker.tsx) is rendered in an isolated full-width section (replacing the page body). The user clicked "Manage plan" — show only the picker plus a Back link.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ←  Back to billing                                                  │
│                                                                      │
│              Choose your plan                                        │
│              Pick the plan that fits how you build.                  │
│                                                                      │
│              [ Individual ] [ Team ]                                 │
│                                                                      │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                │
│   │  Free       │   │  Starter    │   │  Pro     ★  │                │
│   │  $0         │   │  $40/mo     │   │  $150/mo    │                │
│   │  Downgrade  │   │  Downgrade  │   │  Current    │                │
│   └─────────────┘   └─────────────┘   └─────────────┘                │
└──────────────────────────────────────────────────────────────────────┘
```

The PlanPicker already supports this state via the `currentPlan` and `disabledReason` props. The CTA emits `{ kind: "downgrade" | "trial" | "byok" | "contact", plan }`.

### Data already available on the page

The loader already fetches the org's `OrgBillingOverview` ([billing.server.ts:134](src/lib/billing.server.ts#L134)). It exposes:

- `billing_status` and `billing_plan` — for the plan card.
- `billing_trial_ends_at` — for the trial-state subtitle.
- `billing_subscription_status` — to decide whether to show the Cancellation section.

What the loader **does not** currently fetch and we need to add:

- **Stripe customer's default payment method** (brand + last4) — for the Payment row. New helper: `getStripeDefaultPaymentMethodSummary(env, org)`.
- **Stripe subscription's renewal date** (`current_period_end`) — for the "Renews May 8, 2026" line. The existing `StripeSubscription` type doesn't include `current_period_end`; extend it.
- **Stripe invoice list** for the customer (last ~24 months, paid only) — for the Invoices table. New helper: `listStripeInvoicesForOrg(env, org)`.

Each new server helper goes in [src/lib/billing.server.ts](src/lib/billing.server.ts) alongside the existing Stripe wrappers, gated on `isStripeBillingConfigured(env)` so the page degrades gracefully when Stripe is unconfigured (dev environments).

> Tag every new Stripe call with `// FIXME(billing-stripe): wire to real Stripe API` if it's not trivially shaped against the existing helpers — the user said another engineer is doing the Stripe wiring. The frontend should render against shapes that we'd realistically receive, even if the implementation is stubbed.

### Manage / Upgrade / Downgrade / Cancel — action wiring

All four actions go through Stripe, which a different engineer is wiring. The frontend's job is to:

1. **Manage plan** — switch the page into the in-page `<PlanPicker>` view (state: `view = "manage"`). No round-trip needed for the picker itself.
2. **Selecting a plan** in the picker (`onSelectPlan`) — submit a form with `intent: "changePlan"` and `plan: <BillingPlan>`. Add a `case "changePlan"` to the existing `action()` function. Inside it, leave a `// FIXME(billing-stripe): create/upgrade/downgrade subscription via Stripe` comment and a `throw redirect(billingUrl)` so the UI roundtrips cleanly.
3. **Update payment method** — submit `intent: "updatePaymentMethod"`. The existing `manageBilling` intent (which opens the Stripe Billing Portal) already does this — keep it as-is and reuse the URL. Just rename the button to "Update".
4. **View invoice** — `<a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">View</a>`. No action needed; Stripe-hosted.
5. **Cancel plan** — submit `intent: "cancelSubscription"`. Add a `case "cancelSubscription"` with a `// FIXME(billing-stripe): cancel subscription at period end` comment. Show a confirmation `AlertDialog` first (do not cancel on a single click).

### Component structure

```
src/routes/_app.settings.organization.billing.tsx
├── BillingPage (default export)
│   ├── view === "manage" ? <ManagePlanView /> : <BillingOverviewView />
│
├── BillingOverviewView    ← inlined directly in the route file as plain JSX
│   ├── Plan summary       ← <h2>{plan.label}</h2> + subtitle <p> + Manage <Button>
│   ├── <Separator />
│   ├── Payment section    ← "Payment" <h2> + brand glyph + last4 + Update <Button>
│   ├── <Separator />
│   ├── Invoices section   ← "Invoices" <h2> + <Table> or "No invoices yet" <p>
│   ├── <Separator />
│   └── Cancellation section ← only when subscription is active/trialing; "Cancel plan" + destructive <Button>
│
└── ManagePlanView
    ├── Back link → setView("overview")
    └── <PlanPicker currentPlan={...} onSelectPlan={...} />
```

These sections are intentionally **inlined as plain JSX in the route**, not extracted into per-section components. Extracting `<PlanCard>` / `<PaymentMethodSection>` / `<InvoicesSection>` / `<CancellationSection>` adds files without re-use value — the only consumer is this route. The previous draft of this plan over-extracted; reverting here.

The two pieces worth extracting are:
- **`<InvoicesTable>`** — non-trivial markup (`Table` + headers + per-row link), worth its own file for clarity and unit testing.
- **`<CancelPlanDialog>`** — destructive `AlertDialog` with copy that benefits from being a single component, not inlined into a route.

`view` is local component state (`"overview" | "manage"`) — no URL change. If we want this URL-addressable, use a search param `?view=manage`; nice-to-have, not required.

### shadcn components used

| Element | Component | Source |
|---|---|---|
| Plan summary | Plain typography (`<h2 className="text-lg font-semibold">` + `<p className="text-sm text-muted-foreground">`) — **no `Card` wrapper** | — |
| Section headings | Plain `<h2 className="text-base font-semibold">` | — |
| Manage / Update / Cancel buttons | `Button` (variant: `outline` for Manage/Update, `destructive` for Cancel) | [src/components/ui/button.tsx](src/components/ui/button.tsx) |
| Cancel confirmation | `AlertDialog`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogCancel`, `AlertDialogAction` | [src/components/ui/alert-dialog.tsx](src/components/ui/alert-dialog.tsx) |
| Invoices table | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` | [src/components/ui/table.tsx](src/components/ui/table.tsx) |
| Plan picker | `PlanPicker` | [src/components/billing/plan-picker.tsx](src/components/billing/plan-picker.tsx) |
| Section dividers | `Separator` | [src/components/ui/separator.tsx](src/components/ui/separator.tsx) |
| Payment brand glyph | Inline SVG (Stripe brand list) or generic `CreditCard` from `lucide-react` as a fallback when brand is unknown | — |

If the Stripe Link icon shown in the Anthropic screenshot is needed, the Stripe brand is `"link"` and we just render `CreditCard` for now and let the brand-mapping be a follow-up.

### Loader / action contract — final shape

```ts
// loader return type (additive — keep existing fields)
interface BillingLoaderData {
  org: Organization;
  overview: OrgBillingOverview;
  stripeConfigured: boolean;
  subscriptionPlans: ConfiguredSubscriptionPlanSummary[]; // unchanged
  // NEW:
  subscription: {
    plan: BillingPlan;
    statusLabel: string;          // "Trial", "Active", "Canceled", "Free"
    renewsAtLabel: string | null; // "May 8, 2026" or null
    trialEndsAtLabel: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  paymentMethod: {
    brand: string;                 // "visa", "mastercard", "link", ...
    last4: string;
  } | null;
  invoices: Array<{
    id: string;
    createdAtMs: number;
    amountPaidCents: number;
    currency: string;
    status: string;                // "paid" | "open" | ...
    hostedInvoiceUrl: string | null;
  }>;
}
```

The loader continues to handle the no-Stripe case by returning `subscription: null`, `paymentMethod: null`, `invoices: []`.

### Action intents

```ts
// new intents to add
case "changePlan":         // leave FIXME, redirect to billing page
case "cancelSubscription": // leave FIXME, redirect to billing page
// existing intents to keep
case "manageBilling":      // already wired — reuse for "Update payment method"
// REMOVED:
// case "startSubscription" — replaced by changePlan
// case "buyCredits"         — out of scope (extra usage descoped)
```

### Edge cases

- **Enterprise orgs** — render the plan card with "Enterprise" label, hide Manage plan / Cancellation entirely, hide Payment section. (The current page already has an `isEnterprise` short-circuit; preserve it.)
- **`cancelAtPeriodEnd === true`** — render the plan card subtitle as "Cancels on May 8, 2026" instead of "Renews on May 8, 2026", and hide the Cancellation section.
- **`stripeConfigured === false`** — render the plan card showing the org's local `billing_plan`, but disable Manage plan / Update / Cancel buttons and show a small `text-xs text-muted-foreground` line: "Stripe billing is not configured."
- **No invoices** — render `<p className="text-sm text-muted-foreground">No invoices yet.</p>` in place of the table.

### Files changed

| File | Change |
|---|---|
| `src/routes/_app.settings.organization.billing.tsx` | Replace contents per ASCII; add new view state, new loader fields, new action intents |
| `src/lib/billing.server.ts` | Add `listStripeInvoicesForOrg`, `getStripeDefaultPaymentMethodSummary`, extend `StripeSubscription` with `current_period_end` and `cancel_at_period_end` fields. Tag the helper bodies with `// FIXME(billing-stripe)` if the Stripe response shape isn't already covered |
| `src/components/billing/invoices-table.tsx` (new) | Renders the invoices `Table`. Accepts `invoices: BillingLoaderData["invoices"]` |
| `src/components/billing/cancel-plan-dialog.tsx` (new) | The destructive `AlertDialog` confirmation flow for cancelling |
| `src/components/settings/settings-nav.tsx` | Reorder Organization items; remove Experimental |
| `src/routes.ts` | Remove the `settings/organization/experimental` route registration |
| `src/routes/_app.settings.organization.experimental.tsx` | **Delete** the file |

The plan summary, payment row, and cancellation section are inlined directly in [_app.settings.organization.billing.tsx](src/routes/_app.settings.organization.billing.tsx) — no per-section component files. Section markup is just headings + paragraphs + buttons; extracting them adds files without reuse.

### Files deleted / scope-removed

The current page has Buy Credits cards and a Plans grid; both go away in favor of the PlanPicker manage view. No standalone files to delete (everything is inline in the route).

---

## Page 2: Usage

### Why credits matter even on BYOK

Earlier I framed BYOK as "no camelAI credits are consumed" — that's wrong going forward. camelAI is implementing its own agent harness, which means **hosted tools (web search, future tool-calls, etc.) consume camelAI credits regardless of whether the LLM itself is BYOK or hosted.** Every user — Free, Starter, Pro, Team, BYOK or not — needs to be able to:

1. See their credit balance for the current period.
2. See what's been spent against it.
3. Top up when they want more.

The page should always render. There is no "no key set" empty state on Usage anymore — the page is about credits, not about whether the LLM is wired up. Wiring the LLM lives on `/ai-provider`.

### ASCII Design — Default state (every plan, BYOK or hosted)

No card wrappers around any section — sections are headings + plain content directly on the page background. Only the destructive AlertDialogs (handled elsewhere) and the multi-pack picker `Dialog` use container chrome.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Usage                                                               │
│  Track camelAI credit consumption for camelAI Org Name.              │
├──────────────────────────────────────────────────────────────────────┤
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Credit balance                                                      │
│                                                                      │
│  30.00 credits                                                       │  ← Big number, no card
│  Available this billing period                                       │
│                                                                      │
│  ███████████████░░░░░░░░░░░░░  50% used                              │  ← Progress, full-width
│                                                                      │
│  $15.00 used of $30.00 included.    Resets May 8, 2026.              │
│                                                                      │
│  Credits cover hosted LLM calls and built-in tools like web search.  │
│  Bringing your own LLM key only avoids the LLM cost.                 │
│                                                                      │
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Top up                                                              │
│  Top up any time. Credits never expire and roll over alongside       │
│  your monthly included balance.                                      │
│                                                                      │
│                                                [  Top up credits  ]  │  ← Right-aligned button
│                                                                      │
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Recent requests                                                     │
│                                                                      │
│  Model              Input    Output   Credits   Time                 │
│  ────────────────────────────────────────────────────────────        │
│  sonnet-4-6         12,304   1,508    0.0241    Apr 28, 11:34 AM     │
│  opus-4-7           8,210      744    0.0184    Apr 28, 11:30 AM     │
│  ...                                                                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Top-up button → existing flow

The "Top up credits" button is **not new wiring** — the current page already submits `intent: "buyCredits"` against the Stripe credit-pack flow at [_app.settings.organization.billing.tsx:157-168](src/routes/_app.settings.organization.billing.tsx#L157-L168) and the loader already fetches `creditPacks` via `fetchConfiguredCreditPacks` ([_app.settings.organization.billing.tsx:88-92](src/routes/_app.settings.organization.billing.tsx#L88-L92)). We're moving that intent and that loader call from the Billing page to the Usage page.

Two button behaviors are acceptable:

1. **One-button shortcut (preferred for v1).** If exactly one credit pack is configured, the button submits `intent: "buyCredits"` with that pack's `priceId` and Stripe Checkout opens directly.
2. **Picker dialog.** If multiple credit packs are configured, clicking the button opens a small `Dialog` (`<TopUpDialog>`) listing each pack as a row (`{creditsLabel} — {priceLabel}` + a "Buy" button per row, each submitting its own `priceId`). This re-uses the same intent.

Either way, the **action** in `_app.settings.organization.usage.tsx` adds a single new case:

```ts
case "buyCredits": {
  const selectedPriceId = String(formData.get("priceId") || "");
  const url = await createCreditsCheckoutSession({
    env,
    org: authContext.currentOrg,
    customerEmail: authContext.user.email,
    successUrl,
    cancelUrl,
    priceId: selectedPriceId,
  });
  throw redirect(url);
}
```

This is the *exact* code that's getting deleted from the Billing route — move it, don't rewrite it. The `successUrl` / `cancelUrl` should land back on `/settings/organization/usage?checkout=success` (and `cancelled`).

When `creditPacks.length === 0` (Stripe not configured), the top-up section renders with a disabled button and a small `text-xs text-muted-foreground` note: "Top-up is not configured yet."

### ASCII Design — Enterprise

Enterprise orgs don't go through Stripe credits, so the top-up section is hidden and the credit balance section collapses to one line of plain text — no card:

```
│  Credit balance                                                      │
│                                                                      │
│  Enterprise                                                          │
│  Hosted usage and tool calls are billed outside camelAI credits for  │
│  this organization.                                                  │
```

Recent requests table still renders.

### Decision tree the page renders against

```
overview.billing_status === "enterprise"
  → Enterprise card + recent requests table; no top-up section.

else (every other plan, BYOK or not)
  → Credit balance card + top-up section + recent requests table.
```

There is no longer a separate "BYOK user" view or "no key set" empty state. The page is plan-agnostic and BYOK-agnostic; what it shows is the same set of camelAI credits that fund hosted tools across all plans.

### Optional: small BYOK indicator

If the org has a BYOK config set, render a thin one-line note immediately under the credit balance explainer — purely informational, not a blocking state. **No card, no border, no background fill** — just a paragraph of `text-sm text-muted-foreground` with an inline link:

```
Using your Anthropic key for LLM turns. Built-in tools still draw from
credits. Manage in AI Provider →
```

This makes the relationship between BYOK and credits explicit without taking over the page.

### Data the loader needs

The current loader fetches `overview`, `spend`, `log`. After this redesign:

- **Add `creditPacks: ConfiguredCreditPack[]`** — call `fetchConfiguredCreditPacks(env)` (already exists in [billing.server.ts](src/lib/billing.server.ts)).
- **Add `stripeConfigured: boolean`** — call `isStripeBillingConfigured(env)` (already exists).
- **Add `llmProviderConfig`** — same fetch the AI Provider page does, only used for the optional one-line BYOK note. If we decide to skip the note, drop this addition.
- **Drop the `spend.windows` UI** — window caps are a leftover diagnostic. Keep the `spend` fetch only if useful for the progress bar; `overview.chargeable_usage_cents` and `overview.total_credit_limit_cents` are enough.

### What we cut

- The "Subscription" badge card → already on `/billing`, gone here.
- The "Lifetime Usage" card → low signal for a billing-period view; replaced by the in-period progress bar.
- The "Total credits" tile (included + purchased breakdown) → consolidated into the line under the progress bar.
- The "Usage Windows" grid (rolling caps) → cut entirely. If we need it back later, gate it behind a "Show advanced" toggle.
- The "no API key" empty state → no longer reachable. Every plan needs the credits view.
- Hiding the Credits column on the recent-requests table → no longer correct. Keep the column on every plan, since hosted tools incur credit cost even on BYOK.

### shadcn components used

No `Card` on the Usage page. Sections are plain `<section>` blocks with an `<h2>` heading and plain content beneath them.

| Element | Component | Source |
|---|---|---|
| Big credit balance | Plain typography (`text-3xl font-semibold`) | — |
| Progress bar | `Progress` | [src/components/ui/progress.tsx](src/components/ui/progress.tsx) |
| Top-up dialog (multi-pack only) | `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` | [src/components/ui/dialog.tsx](src/components/ui/dialog.tsx) |
| Top-up button | `Button` (default variant — primary CTA on the page) | [src/components/ui/button.tsx](src/components/ui/button.tsx) |
| Section headings | `<h2 className="text-base font-semibold">` (consistent with Billing) | — |
| Section dividers | `Separator` | [src/components/ui/separator.tsx](src/components/ui/separator.tsx) |
| Recent requests | `Table` (existing) | [src/components/ui/table.tsx](src/components/ui/table.tsx) |

The `Progress` shadcn primitive needs to exist. If [src/components/ui/progress.tsx](src/components/ui/progress.tsx) isn't there, install via the shadcn registry first; the current page rolls its own `<div className="bg-muted">` which we can also keep verbatim.

### Files changed

| File | Change |
|---|---|
| `src/routes/_app.settings.organization.usage.tsx` | Replace page body per ASCII; loader gains `creditPacks`, `stripeConfigured`, optional `llmProviderConfig`; new `buyCredits` action case (moved from Billing); cut window-cap UI; **all sections rendered inline as plain JSX — no `<Card>` wrappers** |
| `src/components/billing/top-up-dialog.tsx` (new) | The multi-pack picker dialog — one row per pack, each row a `Form` posting `intent=buyCredits` with that pack's `priceId` |
| `src/routes/_app.settings.organization.billing.tsx` | Remove `case "buyCredits"` and the `creditPacks` loader fetch — both move to Usage |

The credit balance section, the top-up section, and the optional BYOK indicator are all inlined directly in [_app.settings.organization.usage.tsx](src/routes/_app.settings.organization.usage.tsx). No `<CreditBalanceCard>`, no `<CreditTopUpCard>`, no `<ByokUsageCallout>`. The single extracted component is `<TopUpDialog>` because it has its own state (open/closed) and a non-trivial pack-list render.

---

## Page 3: AI Provider

### ASCII Design — No key configured

```
┌──────────────────────────────────────────────────────────────────────┐
│  AI Provider                                                         │
│  Bring your own API key to use camelAI without hosted credits.       │
├──────────────────────────────────────────────────────────────────────┤
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Provider                                                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 │
│  │OpenRouter│ │Anthropic │ │  OpenAI  │ │ Bedrock  │                 │  ← ToggleGroup
│  └══════════┘ └──────────┘ └──────────┘ └──────────┘                 │
│                                                                      │
│  OpenRouter API key                       Get a key ↗                │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │ sk-or-...                                                   │      │
│  └────────────────────────────────────────────────────────────┘      │
│  ⓘ Any model — Claude, GPT, Gemini, and more via OpenRouter.        │
│                                                                      │
│  ─────────── separator ───────────                                   │
│                                                                      │
│                                                  [    Save key    ]  │
└──────────────────────────────────────────────────────────────────────┘
```

### ASCII Design — Key configured

```
┌──────────────────────────────────────────────────────────────────────┐
│  AI Provider                                                         │
│  Bring your own API key to use camelAI without hosted credits.       │
├──────────────────────────────────────────────────────────────────────┤
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Active key                                                          │
│                                                                      │
│  Anthropic   sk-ant-...zX42                  [  Test  ]  [ Remove ]  │  ← Plain row, no card
│  Added Apr 12, 2026                                                  │
│                                                                      │
│  ─────────── separator ───────────                                   │
│                                                                      │
│  Replace key                                                         │
│                                                                      │
│  Provider                                                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 │
│  │OpenRouter│ │Anthropic │ │  OpenAI  │ │ Bedrock  │                 │
│  └──────────┘ └══════════┘ └──────────┘ └──────────┘                 │
│                                                                      │
│  Anthropic API key                          Get a key ↗              │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │ sk-ant-...                                                  │      │
│  └────────────────────────────────────────────────────────────┘      │
│  ⓘ Claude models only.                                              │
│                                                                      │
│                                                  [   Save key    ]   │
└──────────────────────────────────────────────────────────────────────┘
```

When the user removes their key, the page transitions back to the "No key configured" layout.

### Approach

- **Reuse the BYOK dialog's structure inline** instead of in a Dialog. Build a small subcomponent `<ByokKeyForm>` extracted from the body of [byok-key-dialog.tsx](src/components/onboarding/byok-key-dialog.tsx) (the `<form>` block — pills + input + region select + coverage note + submit button) so both the dialog and this page render the same JSX. The dialog keeps its `Dialog` wrapper; the settings page renders the form directly.
- **Drop the "default / camelAI billing" radio option** entirely. The user said the BYOK dialog doesn't include it; matching the dialog means this page is purely about BYOK. Switching back to camelAI billing happens via the **Remove key** button on the active-key row. (Wire that to the existing `deleteProvider` intent.)
- **Drop the per-provider Collapsible "How to get your API key" guide.** The "Get a key ↗" link on the input row is enough — same call as the dialog. Remove `PROVIDER_GUIDES`, `ProviderSetupInstructions`, the `ChevronDown` import, and the `Collapsible` imports.
- **Keep `Test`** on the active-key row. Useful diagnostic, no replacement.
- **Centralize provider metadata.** Import `BYOK_PROVIDERS`, `BYOK_PROVIDER_ORDER`, `AWS_REGIONS`, and `OnboardingByokProvider` from `@/lib/byok-providers` and delete the `PROVIDER_CARD_OPTIONS` / `PROVIDER_GUIDES` constants in this file. This kills the FIXME left by the BYOK dialog plan ([byok-modal-plan.md:494](docs/byok-modal-plan.md#L494)).

### Component structure

```
src/components/byok/byok-key-form.tsx (new)
└── ByokKeyForm — reusable provider-pills + input + region + coverage + button block
    Props mirror today's ByokKeyDialog inputs:
      selectedProvider, onProviderChange,
      apiKey, onApiKeyChange,
      awsRegion, onAwsRegionChange,
      onSubmit, isSubmitting,
      errorMessage,
      submitLabel: string  // "Continue" in dialog, "Save key" on settings page

src/components/onboarding/byok-key-dialog.tsx (modified)
└── Dialog wrapper around <ByokKeyForm submitLabel="Continue" />

src/routes/_app.settings.organization.ai-provider.tsx (rewritten)
├── if (config) → "Active key" <h2> + plain key-info row + Test/Remove buttons
│                 + <Separator />
│                 + "Replace key" <h2>
│                 + <ByokKeyForm submitLabel="Save key" />
└── else        → <ByokKeyForm submitLabel="Save key" />
```

There is **no `<ActiveKeyCard>` component**. The active-key row is rendered inline in the route as plain JSX: a flex row with provider label + key hint on the left, "Added <date>" on a second line, Test and Remove buttons on the right. No `Card` wrapper, no border, no fill — matches the rest of the redesigned settings pages.

The dialog's footer button is rendered by `ByokKeyForm` via the `submitLabel` prop. The dialog wraps the form in `DialogFooter` styling; the settings page renders the button inline. Both use the same `Button` for visual parity.

### Action wiring

The page already has the right backend endpoint at `POST /api/orgs/:id/llm-provider` with `setProvider` / `deleteProvider` / `testProvider` intents. Keep all three, just call them from the new component layout:

- **Save key** (form submit) → `setProvider` with `provider`, `api_key` (or `bearer_token` for Bedrock), and `aws_region` (Bedrock only). Same shape as today.
- **Remove** (active-key row) → `deleteProvider`. Show an `AlertDialog` confirmation first ("Remove your Anthropic key? Your org will switch back to camelAI hosted credits.") — single click is too easy to misfire on a destructive action.
- **Test** (active-key row) → `testProvider`. Render the result inline as today.

### Provider metadata reuse

Today's [_app.settings.organization.ai-provider.tsx:91-151](src/routes/_app.settings.organization.ai-provider.tsx#L91-L151) defines `PROVIDER_GUIDES` independently from the dialog. After this redesign:

- The `displayName` previously in `PROVIDER_GUIDES` lives on `BYOK_PROVIDERS[key].label` already.
- The `placeholder` and `fieldLabel` already match `BYOK_PROVIDERS[key]`.
- The `getKeyUrl` already matches `BYOK_PROVIDERS[key].getKeyUrl`.
- The `description`, `firstStepLinkLabel`, `steps`, `note` fields are gone (Collapsible deleted).

Net: the new file imports nothing from a local provider-guide map.

### shadcn components used

Already-installed primitives — no new shadcn additions required.

| Element | Component |
|---|---|
| Provider pills | `ToggleGroup`, `ToggleGroupItem` (variant `outline`, size `lg`) |
| Key input | `Input` |
| AWS region (Bedrock) | `Select` |
| Coverage note icon | `Info` from `lucide-react` |
| External-link icon | `ExternalLink` from `lucide-react` |
| Save / Remove / Test | `Button` (`destructive` for Remove) |
| Confirmation | `AlertDialog` for the Remove flow |
| Active key summary | Plain `<div>` row — provider label, key hint, "Added <date>", Test + Remove buttons. **No `Card`** |
| Section dividers | `Separator` |
| Errors | `Alert`, `AlertDescription` (`variant="destructive"`) |

### Files changed

| File | Change |
|---|---|
| `src/routes/_app.settings.organization.ai-provider.tsx` | Rewrite per ASCII; delete `PROVIDER_GUIDES`, `PROVIDER_CARD_OPTIONS`, `ProviderSetupInstructions`; consume `BYOK_PROVIDERS` from `@/lib/byok-providers`; render the active-key row inline + `<ByokKeyForm>` |
| `src/components/byok/byok-key-form.tsx` (new) | The shared pills + input + region + submit JSX, extracted from `byok-key-dialog.tsx` |
| `src/components/onboarding/byok-key-dialog.tsx` | Replace inline `<form>` body with `<ByokKeyForm submitLabel="Continue" />`. Keep dialog wrapper unchanged |
| `src/components/byok/remove-key-dialog.tsx` (new) | The destructive `AlertDialog` for confirming key removal |

The active-key row is **inlined directly in the route** — no `<ActiveKeyCard>` file. It's a small flex row with state already on the page; extracting it would add a file without reuse value.

---

## Cross-cutting Notes

### Stripe / billing-action FIXMEs

Each new server action that needs Stripe wiring should look like:

```ts
case "changePlan": {
  // FIXME(billing-stripe): create or update Stripe subscription for the new plan,
  // pro-rate as appropriate, and surface the trial-vs-paid state.
  // For now, redirect back to the billing page so the UI flow stays intact.
  throw redirect(billingUrl.toString());
}
```

This pattern lets the next engineer grep `FIXME(billing-stripe)` to find every entry point. Existing intents (`manageBilling`) that already work should keep working.

### Loading states

For each action button (`Manage plan`, `Update`, `Save key`, `Remove`, `Cancel plan`), reflect the fetcher state with a disabled button + label change ("Saving…", "Removing…"). The `useFetcher` hook is already in use on the AI Provider page; replicate the pattern on Billing for the new actions.

### Accessibility

- Every card with a primary action gets a screen-reader-friendly heading (`<h2>` for section titles, `<h3>` for card titles).
- The destructive AlertDialogs (`Cancel plan`, `Remove key`) need both a clear title and a clear description — never just "Are you sure?". Examples:
  - "Cancel your Pro subscription? Your plan stays active until May 8, 2026 and then switches to Free."
  - "Remove your Anthropic key? Your org will switch back to camelAI hosted credits, which may incur charges."
- The invoices table uses real `<th>` for the column headers; `Table` from shadcn already does this via `TableHead`.

### Testing checklist

- **Billing page (active subscriber):** Plan card shows correct plan + renewal date; "Manage plan" toggles in-page picker; PlanPicker correctly marks current plan; "Update" opens Stripe portal in new tab (or current tab — match today's flow); invoices render with hosted_invoice_url links; Cancel button opens confirmation, second click submits.
- **Billing page (free org):** "Choose a plan" CTA opens picker; no Cancellation section; no Payment row beyond "No payment method on file."; no Invoices table.
- **Billing page (no Stripe configured):** Plan card renders; all action buttons disabled; "Stripe billing not configured" footnote.
- **Usage page (every plan, hosted or BYOK):** Page renders unconditionally; big credit number matches `overview.available_credits_cents`; progress bar reflects `chargeable_usage_cents / total_credit_limit_cents`; recent requests table shows last 20 with the Credits column populated; one-line BYOK indicator (if rendered) links to `/settings/organization/ai-provider`.
- **Usage page top-up (single pack):** Clicking "Top up credits" submits `intent=buyCredits` with the configured `priceId` and redirects to Stripe Checkout.
- **Usage page top-up (multi-pack):** Clicking "Top up credits" opens `<TopUpDialog>`; selecting a row submits the right `priceId`; cancelling closes the dialog without state change.
- **Usage page top-up (Stripe unconfigured):** Top-up button disabled with the "Top-up is not configured yet." note; no `buyCredits` action is reachable.
- **Usage page (Enterprise):** Enterprise card replaces the credit balance card; no top-up section; recent requests still render.
- **AI Provider (no key):** Form renders, OpenRouter selected by default, save submits and transitions to active-key state without page reload.
- **AI Provider (key set):** Active-key card shows correct provider, key hint, and added date; Test button surfaces inline result; Remove opens AlertDialog, confirmation submits and transitions back to no-key state; replace flow lets the user paste a different provider's key and Save replaces the existing config (server already supports this — single endpoint).
- **Settings nav:** Organization items appear in the new order; Experimental moves to the bottom.
- **Typecheck and lint:** `bun run typecheck && bun run lint`.
- **Targeted Vitest:** Add at least one test for any new server helper that touches Stripe response shapes.

### Files Changed Summary

#### New files
| File | Purpose |
|---|---|
| `src/components/billing/invoices-table.tsx` | Invoices `Table` (only non-trivial Billing markup worth extracting) |
| `src/components/billing/cancel-plan-dialog.tsx` | Destructive AlertDialog for cancel |
| `src/components/billing/top-up-dialog.tsx` | Multi-pack picker dialog used when more than one credit pack is configured |
| `src/components/byok/byok-key-form.tsx` | Pills + input + region + coverage + submit (shared between BYOK dialog and AI Provider page) |
| `src/components/byok/remove-key-dialog.tsx` | Destructive AlertDialog for key removal |

The plan summary, payment row, cancellation section, credit balance section, top-up section, optional BYOK indicator, and AI-Provider active-key row are all **inlined directly in their route files as plain JSX** — no per-section component files. Sections are headings + paragraphs + buttons; extracting them adds files without reuse.

#### Modified files
| File | Change |
|---|---|
| `src/routes/_app.settings.organization.billing.tsx` | Replace page; new view state; new loader fields; new action intents (`changePlan`, `cancelSubscription`); remove `creditPacks` loader fetch and `case "buyCredits"` (move to Usage); plan summary, payment row, and cancellation section rendered inline as plain JSX; FIXME(billing-stripe) markers |
| `src/routes/_app.settings.organization.usage.tsx` | Replace page per ASCII; loader gains `creditPacks`, `stripeConfigured`, optional `llmProviderConfig`; new `case "buyCredits"` action moved from Billing; credit balance, top-up, and BYOK indicator rendered inline as plain JSX (no `Card` wrappers); cut window-caps UI |
| `src/routes/_app.settings.organization.ai-provider.tsx` | Rewrite per ASCII; delete `PROVIDER_GUIDES` / `PROVIDER_CARD_OPTIONS` / `ProviderSetupInstructions`; consume `BYOK_PROVIDERS`; active-key row rendered inline (no `<ActiveKeyCard>`) |
| `src/components/onboarding/byok-key-dialog.tsx` | Inline form replaced with `<ByokKeyForm submitLabel="Continue" />` |
| `src/components/settings/settings-nav.tsx` | Reorder Organization items; remove Experimental |
| `src/routes.ts` | Remove the `settings/organization/experimental` route registration |
| `src/lib/billing.server.ts` | Add `listStripeInvoicesForOrg` + `getStripeDefaultPaymentMethodSummary`; extend `StripeSubscription` with `current_period_end`, `cancel_at_period_end`; tag with `// FIXME(billing-stripe)` where Stripe response wiring is incomplete |

#### Deleted files
| File | Why |
|---|---|
| `src/routes/_app.settings.organization.experimental.tsx` | The Experimental settings tab is removed entirely. Runtime `experimentalSettings` plumbing (Chat, admin tooling, `llm-provider-config.ts`) stays — those are separate concerns. |

---

## Implementation Order

1. **Settings nav reorder + Experimental tab removal** — update `settings-nav.tsx`, remove the registration in `src/routes.ts`, delete `src/routes/_app.settings.organization.experimental.tsx`. Verify chat and admin still typecheck and run.
2. **Extract `<ByokKeyForm>`** from the dialog. Verify the dialog still works in onboarding before touching the settings page.
3. **AI Provider page rewrite** — render the active-key row inline (no `<ActiveKeyCard>` extraction); `<ByokKeyForm submitLabel="Save key" />` for the form; new `<RemoveKeyDialog>`. Delete `PROVIDER_GUIDES` and friends. `bun run typecheck`.
4. **Billing page rewrite** — render plan summary, Payment, and Cancellation inline as plain JSX. Extract `<InvoicesTable>` and `<CancelPlanDialog>`. Leave Stripe-needing intents as FIXMEs.
5. **Usage page rewrite** — move `creditPacks` loader fetch and `case "buyCredits"` from Billing to Usage; render the credit balance, top-up, and optional BYOK indicator inline (no `Card` wrappers); extract `<TopUpDialog>` only.
6. **`bun run typecheck && bun run lint`** — single pass after all five chunks.
7. **Manual smoke** — exercise each page against the primary states (active subscriber, free, enterprise; BYOK-on and BYOK-off). Verify the Experimental tab is gone and chat still loads.

---

## Out of Scope (explicit)

- **Anthropic-style "Extra usage" / auto-reload purchases** — fully descoped per the user. The Usage page's top-up section uses the existing one-shot `buyCredits` intent (already in the codebase). Do not add auto-reload thresholds, monthly-spend caps, or "extra usage" toggles.
- **Wiring Stripe for upgrade / downgrade / cancel** — another engineer is doing that work. The plan only adds the action intents and FIXMEs at the call sites so the UI redirects cleanly even when the backend is stubbed.
- **Mobile-first redesign** — current pages already work on mobile via the settings layout's responsive nav. The new components inherit Tailwind responsiveness; no special mobile work in this pass.
- **Per-seat billing for Team plans on the Plan summary** — out of scope; the Manage plan picker already handles team plan seat math, so the Billing summary just shows the plan label.
- **Removing runtime `experimentalSettings` plumbing** — only the user-facing settings tab is deleted. The `OrganizationExperimentalSettings` type, `getOrganizationExperimentalSettings`, and the chat/admin consumers stay. If we want to fully retire the runtime gating, that's a separate cleanup PR.
- **Localized currency / invoice download (PDF)** — Stripe-hosted invoice URL is the canonical source; we just link to it.
- **Brand-specific payment-method icons (Visa/MC/etc.)** — out of scope; ship with the lucide `CreditCard` fallback. Brand mapping can come later.
