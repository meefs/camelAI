# Free-Tier Onboarding & Paywall — Implementation Spec

Implement free-first onboarding: new users go `signup → verify email → /chat` on
the Camel Free model with no billing step. Premium models appear locked in the
model picker; unlocking happens through an Unlock modal (4 methods) and an
Upgrade dialog (plan grid). A dismissible Upgrade dialog auto-opens once after
the assistant's second completed message. The credit-exhaustion "Switched to
Camel Free" toast becomes a sticky banner with recovery CTAs.

All product decisions in this spec are final — implement as written.

## Design intent (for copy consistency)

Two independent axes; never present them as one flat menu:

1. **Plan** (features): Free → Starter → Pro → Team → Enterprise. Plans gate
   deployed apps, automations, storage, seats, email inbox, daily capability
   allowances — and include monthly model credits equal to the plan price.
2. **Premium model access** (how model usage is paid): included plan credits,
   purchased credits, your own API key, or your OpenAI account. Camel Free
   needs none of these.

"Pay as you go" is no longer presented as a plan; it survives as the
**Buy credits / Top up** action. The internal plan id `payg` does NOT change.

## Hard constraints

- **Do not modify any Stripe code.** No changes to checkout/portal/webhook
  functions in `src/lib/billing.server.ts` (other than `resolveOrgBillingAccess`
  and non-Stripe helpers named below), no changes to Stripe logic in
  `workers/main/src/identity/org-do.ts`, no changes to
  `src/routes/api/billing.start-subscription.ts`, `billing.credit-packs.ts`,
  `billing.start-payg.ts`, or the webhook. Reuse these endpoints as-is.
- Do not rebuild what already exists (next section).
- Follow the repo conventions: shadcn/ui + Tailwind, `cn()` for classes,
  Lucide icons, loaders/actions/useFetcher over client fetching.

## Already implemented — reuse, do not rebuild

- **Server-side rollover to Camel Free** is live for every hosted-access
  failure. `HostedModelFallbackRequiredError`
  (`workers/main/src/chat-thread/pi-model-config.ts`) → retry with
  `CAMEL_FREE_LLM_MODEL` → `fallbackThreadToFreeModel`
  (`workers/main/src/chat-thread-do.ts`) → `modelFallbackNotice` on agent state
  (`src/lib/chat-agent-state.ts`, reasons `hosted_credits_exhausted` |
  `hosted_subscription_unavailable`). The client currently renders it as a
  transient toast in `src/components/Chat.tsx` (~line 2534) — WI-10 replaces
  that toast.
- **Camel Free** = `CAMEL_FREE_LLM_MODEL` (`"deepseek-v4-auto"`, exported from
  `src/lib/llm-provider-config.ts`), label "Camel Free", `cost: "Free"`,
  pinned first in the picker, credit-free at the inference gate, image-blind
  (already handled safely), hosted-only (no BYOK routing — keep it that way).
- **Paid vLLM priority** (`workers/main/src/hosted-vllm-priority.ts`): active
  subscriptions, enterprise, and orgs with purchased credits get priority over
  free traffic on Camel Free. "Priority over free traffic" copy is factual.
- **Capability allowances** (`src/lib/capability-allowances.ts`): daily
  sponsored web_search/web_fetch/research/oracle jobs. Free 100/200/50/100;
  Starter 5×; Pro & Team 20×. Used in plan-grid copy only (no UI meters in
  this branch).
- **Checkout invocation pattern**: `src/components/billing/paywall-takeover.tsx`
  posts `{ plan }` via `useFetcher` to `/api/billing/start-subscription`, then
  `window.location.assign(data.checkoutUrl)`. Copy this pattern.
- Existing dialogs to reuse: `TopUpDialog`
  (`src/components/billing/top-up-dialog.tsx`, posts to
  `/api/billing/credit-packs`), `ByokKeyDialog`
  (`src/components/onboarding/byok-key-dialog.tsx`), OpenAI device-code flow
  (`src/components/settings/openai-subscription-settings.tsx`, intents
  `startOpenAiSubscription`/`pollOpenAiSubscription` on
  `/api/orgs/:id/llm-provider`).

## Out of scope for this branch

- Settings redesigns: no Billing-tab "Premium model access" section, no Usage
  "Daily allowances" meters.
- No queue-slowness notice, no capability-allowance-exhaustion rail.
- No plan-limit triggers (deploy-cap/cron-cap errors keep their current
  behavior).
- No changes to delinquent-subscriber handling: `past_due`/`canceled` orgs
  without credits/BYOK must still get the full-screen `PaywallTakeover`.
- No changes to email verification, team-mode onboarding, self-host mode, or
  enterprise behavior.

---

## Work items

Implement in this order; later items depend on components from earlier ones.

### WI-1: Free billing-access mode

`src/lib/billing.server.ts` — `resolveOrgBillingAccess()`: today the final
fallback returns `{ kind: "setup_required", reason: "missing_llm_provider" }`.
Change the ending to:

```ts
if (org?.billing_status === "past_due" || org?.billing_status === "canceled") {
  return { kind: "setup_required", reason: "missing_llm_provider", setupRouteAccessible };
}
return { kind: "ready", mode: "free", setupRouteAccessible: true };
```

Add `"free"` to the `mode` union on `OrgBillingAccessState`. Grep all
consumers of `resolveOrgBillingAccess` / the mode union and make them treat
`"free"` as ready (via the existing `isOrgBillingAccessReady`, most already
do). `src/routes/_app.tsx` needs no structural change: free mode is `ready`,
so `PaywallTakeover` no longer renders for these orgs; delinquent orgs still
hit it. Add a free-mode state to the `dev.billing-paywall.tsx` harness.

Definition used throughout this spec — **free mode** = `resolveOrgBillingAccess`
returned `mode: "free"`: not selfhost, not enterprise, no trialing/active
subscription, no BYOK provider config, zero purchased+granted credits, not
past_due/canceled. Note an org with ONLY an OpenAI subscription connected (no
BYOK config) still resolves as free mode — that is fine; their GPT models are
unlocked by WI-4's coverage rules.

Existing blocked users (signed up, never paid) become free-mode orgs on next
load with no migration — intended.

### WI-2: Onboarding skips the billing choice

With WI-1, `_onboarding.tsx`'s `needsWelcomeScreen` computes false for
self-serve users (billing access is now ready), so onboarding auto-completes
to `/chat`. Verify this, then delete the now-unreachable billing plan-picker
branch from `src/routes/_onboarding.welcome.tsx` (`isBillingChoiceRequired`
and everything it gates: the inline `PlanPicker`, the PAYG-choice dialog, the
BYOK dialog wiring). Keep the email-verification and team-mode welcome paths
untouched. In `src/routes/api/onboarding.complete.ts` the 402
"Choose a billing option" guard now passes for free orgs via the same
function — leave the guard in place (it still protects delinquent edge cases).
Update/remove `tests/onboarding-welcome-payg.test.tsx` accordingly and add a
test: new org with `billing_status: "inactive"`, no credits, no provider →
onboarding completes and redirects to `/chat`.

### WI-3: Camel Free is the free-mode default and always visible

1. Default model. Rule: in free mode, the fallback default model is
   `CAMEL_FREE_LLM_MODEL`; an explicitly chosen thread/user model always wins.
   Two anchor points:
   - App-side: `getWorkspaceModelPickerState` in `src/lib/chat-do.server.ts`
     (it already loads org + provider config + OpenAI subscription). When
     computing the default/initial model for a new chat in free mode, return
     `CAMEL_FREE_LLM_MODEL`.
   - DO-side safety net: in `workers/main/src/chat-thread-do.ts`, where a
     thread with no stored model resolves `normalizeLlmModel(undefined, ...)`
     (→ Sonnet today), use `CAMEL_FREE_LLM_MODEL` when the org is in free mode
     (the DO already reads org info for `checkHostedPiModelAccess`; a
     wrong-guess here is non-fatal since rollover would correct it, but the
     default should not burn a fallback).
2. Visibility under BYOK. In `src/lib/llm-provider-config.ts`,
   `isLlmModelAllowedForOrgProvider` currently hides
   `CAMELAI_HOSTED_ONLY_CODEX_MODELS` whenever an org provider is set. Exempt
   `CAMEL_FREE_LLM_MODEL`: it stays visible and selectable for every org type.
   Routing needs no change — `pi-model-resolution.ts` marks it
   `byokAllowed: false`, so BYOK branches already skip it and it runs hosted
   and credit-free.

### WI-4: Locked premium rows in the model picker

**State** — `getWorkspaceModelPickerState` (`src/lib/chat-do.server.ts`):
introduce

```ts
export type ModelPickerOption = ModelCatalogEntry & {
  locked?: boolean;
  unlockHint?: "openai" | "generic";
};
```

For **free-mode orgs only**: options = Camel Free (unlocked) followed by the
standard hosted catalog a subscription org would see, each marked
`locked: true` with `unlockHint: isCodexLlmModel(id) ? "openai" : "generic"`.
Exception: if the org has an OpenAI subscription connected, the GPT/Codex
models it covers are NOT locked (existing `allowOpenAiSubscription` logic).
All other org modes: options unchanged, nothing locked.

Implementation constraints:

- Compute the locked list AFTER `resolveModelPickerCatalog` (i.e. after the
  org/workspace curated-models config and `EXPLICIT_OPT_IN_MODELS` are
  applied), not from the raw `MODEL_CATALOG` — mark the curated visible set,
  minus Camel Free and OpenAI-covered models, as locked. Models an admin
  removed via Manage models must not reappear as locked rows.
- If `effectiveConfig.default_model` (admin-set picker default) resolves to a
  locked model in free mode, coerce the default to `CAMEL_FREE_LLM_MODEL` —
  a new chat must never start on a locked model.
- `getWorkspaceModelPickerState` does not currently read org billing state;
  add the org-info read to its existing `Promise.all` batch to determine free
  mode (do not serialize a new roundtrip).

**Component** — `src/components/model-picker.tsx` (options prop becomes
`ReadonlyArray<ModelPickerOption>`):

```
┌────────────────────────────────────────────────┐
│  ◇ Camel Free                        Free   ✓  │   ← pinned, selected
│ ─────────────────────────────────────────────  │
│  PREMIUM MODELS                                │   ← muted uppercase label
│  ◆ Claude Sonnet         ●●●●○      $$$     🔒 │
│  ◆ Claude Opus 4.8       ●●●●●    $$$$$     🔒 │
│  ◆ GPT-5.6 Sol           ●●●●●     $$$$     🔒 │
│  ◆ GPT-5.6 Luna          ●●●●○       $$     🔒 │
│  …                                             │
│ ─────────────────────────────────────────────  │
│  🔓 Unlock premium models                    → │   ← footer row, accent
└────────────────────────────────────────────────┘
```

- Insert a separator + `PREMIUM MODELS` section label (muted, uppercase,
  text-xs) before the first locked row.
- Locked row: existing row content at reduced opacity (`opacity-60`), Lucide
  `Lock` icon in the checkmark slot. Clicking (or Enter) does NOT select — it
  calls a new prop `onLockedModelSelect(modelId)`. Keyboard navigation still
  reaches locked rows.
- Footer row (only when any option is locked): Lucide `LockOpen` icon +
  "Unlock premium models", accent/primary color, calls new prop
  `onUnlockRequest()`. The existing admin-only "Manage models" link moves
  below it.
- Hover card (`ModelMetadataCard`): on locked rows append one muted line —
  `unlockHint === "openai"`: "Unlock with a plan, credits, an API key — or
  your OpenAI account." otherwise: "Unlock with a plan, credits, or an API
  key." On the Camel Free row append: "Free and always included. Text-only —
  it can't see images. Comes with daily research and Oracle boosts powered by
  premium models."

Thread the two new callbacks through `prompt-input.tsx` / `Chat.tsx` / the
chat routes to open the Unlock modal (WI-5), passing the clicked model as
`triggerModel` (footer → `triggerModel: null`).

### WI-5: Unlock modal

New file `src/components/billing/unlock-premium-modal.tsx`. shadcn `Dialog`,
`max-w-lg`. Props:
`{ open, onOpenChange, triggerModel: LlmModel | null, isOrgAdmin: boolean, orgId: string, onSeePlans: () => void, onTopUp: () => void, onAddKey: () => void, onOpenAiSignIn: () => void }`
(the four callbacks close this modal and open the respective flow, all owned
by the chat-level billing-dialogs host — see WI-6 note).

```
┌─────────────────────────────────────────────────────────────┐
│  Unlock premium models                                  ✕   │
│  Camel Free is always included. Premium models like        │
│  {triggerModel label ?? "Claude and GPT"} need one of      │
│  these:                                                     │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ★  Subscribe                    from $10/mo [See plans]│  │
│  │    Monthly model credits matching your plan price,    │  │
│  │    plus more apps, automations, and storage.          │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ⬡  Sign in with OpenAI    Have ChatGPT?    [Sign in]  │  │
│  │    Use the model allowance already included in your   │  │
│  │    ChatGPT plan for GPT models. No extra cost.        │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ⛁  Buy credits              pay as you go   [Top up]  │  │
│  │    Prepaid credits billed at model cost. No           │  │
│  │    subscription — and you skip the free-model line.   │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 🔑 Use your own API key                    [Add key]  │  │
│  └───────────────────────────────────────────────────────┘  │
│  │    Anthropic, OpenAI, OpenRouter, Bedrock, or a       │  │
│  │    custom endpoint.                                   │  │
└─────────────────────────────────────────────────────────────┘
```

- One bordered card per method (`rounded-lg border p-4`, icon left, title +
  description, `Button variant="outline" size="sm"` on the right). Icons:
  `Sparkles` (Subscribe), OpenAI provider logo (reuse the picker's provider
  logo assets), `Coins` (credits), `KeyRound` (API key).
- Order: Subscribe, OpenAI, Credits, Key. When
  `triggerModel && isCodexLlmModel(triggerModel)`, move the OpenAI card first
  and add `<Badge>Best value for GPT models</Badge>` next to its title.
- Non-admin (`!isOrgAdmin`): keep the cards, replace each button with muted
  text "Ask an org admin". No dead buttons.

**OpenAI device-code extraction**: extract the device-code panel
(one-time code, "Open OpenAI sign-in" link, polling) from
`src/components/settings/openai-subscription-settings.tsx` into a shared
`src/components/billing/openai-sign-in-dialog.tsx` that posts the existing
`startOpenAiSubscription` / `pollOpenAiSubscription` intents to
`/api/orgs/:id/llm-provider` via `useFetcher`. The settings page and this
dialog both use it. On success: revalidate (picker state refresh unlocks GPT
models) and close.

### WI-6: Upgrade dialog (plan grid) + plan-picker content changes

New file `src/components/billing/plan-upgrade-dialog.tsx`: shadcn `Dialog`
`max-w-4xl` hosting the existing `<PlanPicker>`.

- Subscribe CTA: post `{ plan }` to `/api/billing/start-subscription` via
  `useFetcher`, then `window.location.assign(data.checkoutUrl)` — copy the
  pattern from `paywall-takeover.tsx` verbatim. Enterprise CTA keeps the
  existing `BOOK_DEMO_URL` behavior.
- Header: title "Choose your plan", subtitle "You're on the Free plan —
  Camel Free included forever. Upgrade for premium models, more apps, and
  automations."
- Footer under the grid: `"Not ready to subscribe?"` followed by three inline
  link-buttons (`Button variant="link"` separated by `·`):
  "Buy credits as you go" → `onTopUp`, "Add an API key" → `onAddKey`,
  "Sign in with OpenAI" → `onOpenAiSignIn`.

```
┌────────────────────────────────────────────────────────────────┐
│  Choose your plan                          [Individual | Team] │
│  You're on the Free plan — Camel Free included forever.    ✕   │
│  ┌────────────┐  ┌─────────────┐                               │
│  │ Starter    │  │ Pro  ★      │                               │
│  │ $10/mo     │  │ $40/mo      │                               │
│  │ [Subscribe]│  │ [Subscribe] │                               │
│  └────────────┘  └─────────────┘                               │
│  Not ready to subscribe?                                       │
│  Buy credits as you go · Add an API key · Sign in with OpenAI  │
└────────────────────────────────────────────────────────────────┘
```

`src/components/billing/plan-picker-content.ts`:

- Remove `"payg"` from `INDIVIDUAL_PLANS` (grid becomes Starter, Pro / Team,
  Enterprise). Delete the payg card content if now unused. Note: this also
  removes the payg card from `PaywallTakeover` (delinquent orgs) and the
  billing-settings Manage view — intended; the cancellation flow in billing
  settings is separate and unchanged.
- Add feature bullets: Starter — "5× daily web search, research, and Oracle
  allowances"; Pro and Team — "20× daily web search, research, and Oracle
  allowances"; every paid plan — "Priority over free traffic on Camel Free".
  Keep the credits bullet first on each card.

**Billing-dialogs host**: the chat surface needs one owner for the dialog set
(UnlockPremiumModal, PlanUpgradeDialog, TopUpDialog, ByokKeyDialog,
OpenAiSignInDialog) so any entry point (locked row, picker footer, first-run
card, rollover banner, sidebar button, auto-paywall) can open any of them.
Put this state in `Chat.tsx` (or a small `useBillingDialogs` hook next to it)
and pass openers down; the sidebar button (WI-8) gets its own
`PlanUpgradeDialog` instance since it lives outside the chat route.

### WI-7: First-run "You're on Camel Free" card

`src/routes/_app.chat._index.tsx`, empty/new-chat state, directly above the
prompt input. Render when: free mode AND
`localStorage["camel-free-welcome-dismissed:{userId}:{orgId}"]` unset.
Dismiss (X) sets the key. "See premium models" (link-button) opens the Unlock
modal with `triggerModel: null`.

```
┌──────────────────────────────────────────────────────────────┐
│  ◇  You're on Camel Free                                 ✕   │
│     Our free hosted model, with daily research and Oracle    │
│     boosts powered by premium models. It's shared, so        │
│     replies can slow down at busy times. Premium models      │
│     (Claude, GPT) are one click away.                        │
│                                    [See premium models]      │
└──────────────────────────────────────────────────────────────┘
```

Styling: bordered card (`rounded-lg border bg-muted/30 p-4`), Camel logo or
`Sparkles` icon left, `X` ghost icon-button top-right, text-sm body.

### WI-8: Sidebar Upgrade button

`src/components/sidebar/app-sidebar.tsx`, footer area (adjacent to
`nav-user`). Render only when free mode AND org admin (thread billing mode +
admin flag from the `_app.tsx` loader data down to the sidebar).
`Button variant="outline" size="sm"` full-width, Lucide `Sparkles` icon +
label "Upgrade". Opens `PlanUpgradeDialog`. Hidden for paid, enterprise,
selfhost, and non-admin members.

### WI-9: Auto-shown paywall after the second completed assistant message

The one guaranteed paywall impression. Hook into the existing
`use-completed-turns` hook (`src/hooks/use-completed-turns.tsx`) in
`Chat.tsx`: each time `freshlyCompletedTurnId` fires (an assistant turn
finished), and the org is in free mode, increment
`localStorage["free-completed-turns:{userId}:{orgId}"]`.

When the counter reaches **2** and
`localStorage["upgrade-auto-shown:{userId}:{orgId}"]` is unset and the viewer
is an org admin: set the flag, then open `PlanUpgradeDialog`.

- The flag is set at show time, so it appears **once ever** per user+org,
  regardless of how it is closed. Standard `Dialog` dismissal (X / ESC /
  overlay click) — no special "are you sure" step.
- The counter accumulates across threads and sessions (localStorage).
- If localStorage is unavailable, skip silently (never show).
- Do not open while another billing dialog from the host is already open;
  in that case mark the flag set and skip.

### WI-10: Rollover sticky banner (replaces the toast)

Remove the `toast.info("Switched to Camel Free", ...)` block in
`src/components/Chat.tsx` (~line 2534) and its sessionStorage bookkeeping.
Add `src/components/model-fallback-banner.tsx`, rendered sticky above the
prompt input in the same slot family as `BillingCreditNotice` (wired near
`Chat.tsx` ~3882). Reuse the low-credit rail's visual style from
`chat-billing-credit-notice.tsx`.

Show when: `state.modelFallbackNotice` exists AND
`notice.toModel === state.model` AND
`localStorage["model-fallback-dismissed:{notice.id}"]` unset.

- Change `shouldShowModelFallbackNotice` (`src/lib/chat-agent-state.ts`) to
  drop the `MODEL_FALLBACK_NOTICE_MAX_AGE_MS` expiry (banner persists until
  acted on); remove the constant if nothing else uses it. Update
  `tests/chat-agent-state.test.ts`.
- **Auto-dismiss** needs no code beyond the display rule: when the user (or a
  successful unlock flow) switches the thread to a premium model,
  `notice.toModel !== state.model` and the banner disappears.
- Manual dismiss (✕) sets the localStorage key.

Copy and CTAs by `notice.reason` (model labels from `MODEL_CATALOG`):

`hosted_credits_exhausted`:

```
┌──────────────────────────────────────────────────────────────┐
│ ⓘ Monthly credits used up — switched to Camel Free.          │
│   Get back on {fromModel label}:                             │
│   [Top up credits]  [Upgrade plan]  [Use API key]        ✕   │
└──────────────────────────────────────────────────────────────┘
```

If `isCodexLlmModel(notice.fromModel)`, prepend **[Sign in with OpenAI]** as
the first CTA. Buttons open TopUpDialog / PlanUpgradeDialog / ByokKeyDialog /
OpenAiSignInDialog via the billing-dialogs host.

`hosted_subscription_unavailable`:

```
┌──────────────────────────────────────────────────────────────┐
│ ⓘ Your subscription is unavailable — switched to Camel Free. │
│   [Fix payment]  [Use API key]                           ✕   │
└──────────────────────────────────────────────────────────────┘
```

[Fix payment] is a plain link to `/settings/organization/billing` (no Stripe
code involved).

Non-admin members (both reasons): no CTA buttons; body text ends with
"Ask an org admin to top up or upgrade."

### WI-11: Naming

- `src/lib/billing.ts` `billingStatusLabel`: `inactive` → "Free" (was
  "Pay as you go").
- `src/lib/billing-plans.ts` `BILLING_PLAN_LIMITS.payg.label`: → "Free".
- Update every test/snapshot asserting the old strings. Do not rename the
  `payg` plan id, org fields, or Stripe metadata anywhere.

---

## Tests

Unit/UI (`bun run test:run`):

- `tests/billing.test.ts` — `resolveOrgBillingAccess`: inactive/no-credit org
  → `{ kind: "ready", mode: "free" }`; past_due and canceled without
  credits/BYOK → still `setup_required`; BYOK/credits/subscription/enterprise
  modes unchanged.
- `tests/onboarding-welcome-payg.test.tsx` (rework) — free org skips the
  billing choice and lands in `/chat`.
- `tests/chat-do-model-picker-state.test.ts` — free mode: Camel Free default +
  locked premium options with correct `unlockHint`; OpenAI-subscription org:
  GPT models unlocked; subscription org: no locked rows.
- `tests/model-picker-config.test.ts` — Camel Free visible when a BYOK
  provider is configured.
- `tests/chat-agent-state.test.ts` — `shouldShowModelFallbackNotice` without
  expiry; hides when active model ≠ `toModel`.
- Plan-picker content tests — `INDIVIDUAL_PLANS` has no `payg`; new bullets
  present.
- New: unlock-modal ordering (GPT trigger puts OpenAI first with badge;
  non-admin renders no buttons); auto-paywall counter (fires on 2nd completed
  turn once, respects flags, skips without localStorage).

Worker (`bun run test:workers -- chat-thread`):

- `workers/main/tests/chat-thread-billing-access.test.ts` — free-mode org
  with no stored thread model starts on `CAMEL_FREE_LLM_MODEL`.

Also run `bun run typecheck` and `bun run lint`. Extend
`src/routes/dev.billing-paywall.tsx` and `dev.chat-credit-states.tsx` dev
harnesses with the free mode and both rollover-banner states.
