# In-App Paywall Takeover for Already-Onboarded Users

## Problem

A user who belongs to more than one org and is paying in only one can get permanently stranded on the paywall.

Reproduction:
1. User is in Org A (paid) and Org B (free, no BYOK).
2. User switches to Org B from `/settings/organizations`.
3. `_app.tsx` loader sees Org B has no `llmProviderConfig` and no `trialing`/`active`/`enterprise` billing_status, and **`throw redirect("/onboarding")`** at [_app.tsx:65-66](src/routes/_app.tsx#L65-L66).
4. `/onboarding` renders the welcome paywall with `PlanPicker`.
5. The user is stuck. The onboarding shell has no sidebar, no nav, no back button, no org switcher, no logout. They can't get back to Org A short of clearing cookies or typing a URL.

Same surface hits churned users (someone whose subscription lapsed, no BYOK to fall back on). They get treated identically to a first-time signup, which is wrong — they've already onboarded once.

---

## Goal

1. **Treat billing failures for already-onboarded users as an in-app state**, rendered as a takeover inside the app shell with the sidebar visible. They can switch orgs/workspaces, log out, and see that their data is still there — they just can't enter any of it until billing is resolved.
2. **Preserve the first-time onboarding experience exactly as it is today.** Brand-new users still go through `/onboarding` with `PlanPicker` → Stripe/BYOK → polished first-chat (boot modal + agent-seeded conversation). No regressions to the welcome flow, the `/api/onboarding/complete` endpoint, or anything downstream.
3. **Hard takeover, not soft gate.** When billing is not ready, the content area is fully replaced by the paywall. Sidebar items navigate but each navigation lands on the same takeover. We don't build a half-functional browse mode for churned users (BYOK is free and 30 seconds away).

### Non-goals
- Changing what *triggers* the paywall. The `billingAccessReady` logic stays exactly as-is.
- Touching `/api/onboarding/complete`, the boot modal, the AskUserQuestion seeding, the salesPrompt flow, or anything else in the first-time onboarding sequence.
- Letting users send messages / deploy / create connections without billing.
- A separate "data export only" mode for churned users.
- Redesigning the workspace switcher. Org name is already in the subtitle and cross-org switching already works.

---

## Audit Findings

### Onboarding is already user-scoped (✓ — do not "fix" this)

- `OnboardingPreferences { completed_at: number | null }` is stored on the **User DO** via `userStub.updateOnboarding(...)` ([onboarding.complete.ts:214, :308](src/routes/api/onboarding.complete.ts)).
- `authBootstrap.onboarding` is fetched from `getAuthBootstrap()` on the UserDO ([auth.server.ts:474](src/lib/auth.server.ts#L474)) and the flag persists across org switches.
- `_app.tsx:40-41` checks `authContext.onboarding?.completed_at` — user-scoped, not org-scoped.
- `/api/onboarding/complete` further guards against re-running for already-onboarded users via `hasUserThreadsAcrossOrgs` ([onboarding.complete.ts:198-224](src/routes/api/onboarding.complete.ts)) — even if the flag somehow weren't set, the endpoint recovers/recreates the onboarding thread instead of redoing the seeded first message.

**Verdict: the "user onboards once, ever" invariant already holds.** This plan must not disturb it.

### Billing is correctly org-scoped

`billingAccessReady` reads from the **current org's** OrgDO. Each org has its own billing. That's right — billing is a property of the org, not the user.

### The bug is purely a routing mistake for *already-onboarded* users

`_app.tsx`'s billing redirect at line 65-66 punts already-onboarded users into the same `/onboarding` shell that exists for first-time users. The shell has no escape hatches because first-time users shouldn't need them. The fix is to stop punting onboarded users there and instead render a paywall in-app.

### The first-time onboarding sequence we must preserve

I read the endpoint and traced the client flow. For a brand-new user, clicking "Get Started" runs this sequence:

1. **`POST /api/onboarding/complete`** runs three preconditions: email verified ([onboarding.complete.ts:157-162](src/routes/api/onboarding.complete.ts#L157-L162)) → `accessChoice === 'byok' && !llmProviderConfig` check ([:176-181](src/routes/api/onboarding.complete.ts#L176-L181)) → **billing access check ([:183-196](src/routes/api/onboarding.complete.ts#L183-L196))**. Then the seeding logic runs.

2. **A thread is created**, titled `"{firstName}'s first chat"`, owned by the user in their current workspace ([:310-317](src/routes/api/onboarding.complete.ts#L310-L317)).

3. **A system message is composed**, one of two variants ([:65-79](src/routes/api/onboarding.complete.ts#L65-L79)):
   - **Sales-site path** (`SALES_SITE_ONBOARDING_SYSTEM_MESSAGE`): the user typed a starter prompt on camelai.com, it was stashed in KV via `?prompt_key=...`, the endpoint pulls it via `userStub.getPendingSalesPrompt()` ([:166](src/routes/api/onboarding.complete.ts#L166)), and the system message tells the agent "skip the standard questions, dive into this request." The user's prompt is appended.
   - **Default path** (`getDefaultOnboardingSystemMessage`): system message tells the agent to welcome briefly and immediately call `AskUserQuestion` (Claude) / `ask_user_question` (Codex) with two seeded questions ("What do you want to build first?" with 4 options, "Do you have data or services to connect?" with 3 options).

4. The endpoint returns `{ threadId, redirectTo: "/chat/{threadId}?newThread=1", initialMessageContent, salesPrompt, showBootModal: true }`. `initialMessageContent` wraps the system message in `<camelai system message>` tags.

5. Client navigates with **router state** `{ initialMessageContent }` and sets `sessionStorage.showBootModal=1` ([_onboarding.tsx:190-207](src/routes/_onboarding.tsx#L190-L207)).

6. **Chat.tsx** mounts, sees `newThread=1` + sessionStorage flag, plays the **boot modal** ("Creating workspace / Mounting filesystem / Starting conversation / Machine ready" — `onboarding-loading-modal.tsx`).

7. After the modal dismisses, Chat.tsx **auto-sends `initialMessageContent`** as the first message. System message is invisible to the user but seeds the agent. The agent responds — `AskUserQuestion` on the default path, immediate work on the sales-site path.

8. `?newThread=1` is stripped from the URL.

**Why the billing precondition matters at step 1:** if we let a brand-new user reach `/chat` without billing, the auto-sent first message hits a missing LLM provider and the whole sequence collapses into an error or empty state. **The 402 isn't just monetization — it's protecting the first-chat experience.** We do not touch it.

### Other redirects to `/onboarding`

`grep` for `redirect("/onboarding")` found:
- [_app.tsx:41, :47, :66](src/routes/_app.tsx) — the three we know about. We're removing line 66 only.
- [_app.settings.profile.tsx:34](src/routes/_app.settings.profile.tsx) — unrelated email-reset flow. Out of scope.

### Child loaders are safe under a hard takeover

Audited every `_app.*` loader. None require billing to load:
- `_app.chat.$id.tsx:471-472` and `_app.chat._index.tsx:304` already handle a null billing overview gracefully.
- `_app.computer.*`, `_app.apps.tsx`, `_app.connections.tsx`, `_app.history.tsx` — no billing-dependent calls.

So even though child loaders technically still run before the takeover renders (React Router runs all loaders, then the parent decides what to render), they won't break. We're not redirecting away from a chat URL when the takeover fires — the URL stays, the content swaps.

---

## Architecture

### Before

```
                ┌─────────────────────────────────────────┐
                │  Browser navigates to any URL           │
                └────────────────┬────────────────────────┘
                                 │
                                 v
                ┌─────────────────────────────────────────┐
                │  _app.tsx loader                        │
                │   ├─ !onboarding.completed_at?          │
                │   │    → redirect("/onboarding")        │
                │   ├─ emailVerification.required?        │
                │   │    → redirect("/onboarding")        │
                │   └─ !billingAccessReady?               │
                │        → redirect("/onboarding")  ← BUG │
                └────────────────┬────────────────────────┘
                                 │  (no billing)
                                 v
                ┌─────────────────────────────────────────┐
                │  /onboarding (no sidebar, no escape)    │
                │  ┌──────────────────────┐               │
                │  │ welcome.tsx          │ ← already-    │
                │  │ PlanPicker shows here│   onboarded   │
                │  │                      │   user stuck  │
                │  └──────────────────────┘               │
                └─────────────────────────────────────────┘
```

### After

```
                ┌─────────────────────────────────────────┐
                │  Browser navigates to any _app URL      │
                └────────────────┬────────────────────────┘
                                 │
                                 v
                ┌─────────────────────────────────────────┐
                │  _app.tsx loader                        │
                │   ├─ !onboarding.completed_at?          │
                │   │    → redirect("/onboarding")        │ ← unchanged
                │   ├─ emailVerification.required?        │
                │   │    → redirect("/onboarding")        │ ← unchanged
                │   └─ (no billing redirect)              │
                │       Returns { billingAccessReady,     │
                │                  paywallContext }       │
                └────────────────┬────────────────────────┘
                                 │
                                 v
            ┌─────────────────────────────────────────────────┐
            │  _app.tsx render                                │
            │  ┌──────────────────────────────────────────┐  │
            │  │ <SidebarProvider>                        │  │
            │  │   <AppSidebar />     ← always rendered   │  │
            │  │   <SidebarInset>                         │  │
            │  │     {billingAccessReady                  │  │
            │  │       ? <Outlet />                       │  │
            │  │       : <PaywallTakeover ... />}         │  │
            │  │   </SidebarInset>                        │  │
            │  │ </SidebarProvider>                       │  │
            │  └──────────────────────────────────────────┘  │
            └─────────────────────────────────────────────────┘

  /onboarding still handles first-time users exactly as today.
  Brand-new user flow (welcome → PlanPicker → Stripe/BYOK →
  Get Started → /api/onboarding/complete → first-chat with boot
  modal + agent seeding) is untouched.
```

### What it looks like

```
┌─────────────────┬──────────────────────────────────────────────────────────┐
│                 │                                                          │
│  Org B / WS1 ▾  │                     Choose your plan                     │
│  ─────────────  │                                                          │
│  + New chat     │   Org B is on the Free plan with no API key set up.     │
│                 │   Pick a plan, or switch to an organization with an     │
│  Chat Groups    │   active plan using the sidebar.                        │
│  · Group 1      │                                                          │
│                 │              [ Individual ]   [ Team ]                  │
│  Workspace      │                                                          │
│  · Computer     │  ┌──────────┐   ┌──────────────┐   ┌──────────────┐    │
│  · Chat History │  │   Free   │   │   Starter    │   │      Pro     │    │
│  · Connections  │  │          │   │              │   │  ⭐ Most pop │    │
│  · Apps         │  │  $0 /mo  │   │   $40 /mo    │   │   $150 /mo   │    │
│                 │  │          │   │              │   │              │    │
│                 │  │ [Add my  │   │ [Start trial]│   │ [Start trial]│    │
│                 │  │   key ]  │   │              │   │              │    │
│                 │  └──────────┘   └──────────────┘   └──────────────┘    │
│                 │                                                          │
│  ─────────────  │                                                          │
│  ⓘ Get Help    │                                                          │
│  ada@acme.com ▾ │                                                          │
└─────────────────┴──────────────────────────────────────────────────────────┘
```

The sidebar is fully interactive:
- `WorkspaceSwitcher` shows ALL workspaces grouped under org-name subtitles (already today's behavior). Clicking an Org A workspace switches both workspace and org, the loader revalidates with Org A's billing, and the takeover dismisses.
- `NavUser` → Log out works.
- `NavUser` → Settings navigates to `/settings/profile`, which works (settings is not billing-gated).
- Other sidebar items navigate but land on the same takeover until billing is resolved.

---

## Component & File Changes

### Modified: `src/routes/_app.tsx`

The structural change.

1. **Loader**: drop the billing redirect at lines 65-66. Keep the onboarding and email-verification redirects exactly as they are. Add a `paywallContext` to the response when `billingAccessReady` is false:

   ```ts
   // existing computation of billingAccessReady stays
   const billingAccessReady = Boolean(/* same as today */);

   // NEW: when billing is missing, fetch the props PaywallTakeover needs.
   const paywallContext = billingAccessReady
     ? null
     : {
         currentOrgName: currentOrg.name,
         multiOrg: authContext.orgs.length > 1,
         trialAvailable: !hasOrgUsedSubscriptionTrial(orgInfo),
         byokProviderLabel: getByokProviderLabel(llmProviderConfig?.provider),
       };

   // No redirect on billing. Return as part of responseData.
   ```

   `hasOrgUsedSubscriptionTrial` and `getByokProviderLabel` are already used in `_onboarding.welcome.tsx` ([_onboarding.welcome.tsx:13, :27](src/routes/_onboarding.welcome.tsx)) — just import them here. `orgInfo` is already loaded for the enterprise check ([_app.tsx:52-58](src/routes/_app.tsx#L52-L58)) but is currently consumed and discarded; capture it so we can reuse it for `trialAvailable`. Same for `llmProviderConfig` ([_app.tsx:51](src/routes/_app.tsx#L51)) which we'd reuse for `byokProviderLabel`.

   `legacyMigration` is already on the loader response ([_app.tsx:104-109](src/routes/_app.tsx#L104-L109)) and will be passed to the takeover separately.

2. **Render**: gate the `Outlet` on `billingAccessReady`.

   ```tsx
   <SidebarProvider defaultOpen={defaultSidebarOpen}>
     <ChatGroupsProvider>
       <AppSidebar />
       <SidebarInset className="h-svh overflow-hidden flex flex-col">
         {billingAccessReady ? (
           <Outlet />
         ) : (
           <PaywallTakeover
             paywallContext={paywallContext!}
             legacyMigration={legacyMigration}
           />
         )}
       </SidebarInset>
     </ChatGroupsProvider>
     <LegacyUserBanner ... />
     <LegacyMigrationDialog ... />   {/* unchanged — keeps firing for users who DO have billing but are legacy-eligible */}
   </SidebarProvider>
   ```

### Modified: `src/routes/_onboarding.tsx`

A small but important change so already-onboarded users who land at `/onboarding` (via direct URL or any other path) get redirected back out instead of seeing the welcome paywall.

[Lines 110-117](src/routes/_onboarding.tsx#L110-L117) today:
```ts
if (
  onboardingComplete &&
  billingAccessReady &&
  !teamMode &&
  !emailVerificationRequired
) {
  throw redirect("/chat");
}
```

Drop the `billingAccessReady` requirement:
```ts
if (
  onboardingComplete &&
  !teamMode &&
  !emailVerificationRequired
) {
  throw redirect("/chat");
}
```

The reasoning: if a user has already onboarded, `/onboarding` has nothing to show them — the welcome heading + Get Started button is a first-time-only flow, and the billing-choice branch they used to land in is now the `PaywallTakeover` in `/chat`. Send them to `/chat` and let `_app.tsx` decide what to render.

**`needsWelcomeScreen` ([:221-224](src/routes/_onboarding.tsx#L221-L224))**: leave as-is. For a brand-new user without billing, `needsWelcomeScreen` is true via `!billingAccessReady`, and the welcome screen shows `PlanPicker` exactly as today — that's the first-time billing-choice flow we're preserving.

### New: `src/components/billing/paywall-takeover.tsx`

Owns the in-app paywall render. Structurally close to the current `_onboarding.welcome.tsx` `isBillingChoiceRequired` branch ([_onboarding.welcome.tsx:453-578](src/routes/_onboarding.welcome.tsx#L453-L578)), but as a standalone component callable from `_app.tsx`.

```tsx
interface PaywallTakeoverProps {
  paywallContext: {
    currentOrgName: string;
    multiOrg: boolean;
    trialAvailable: boolean;
    byokProviderLabel: string | null;
  };
  legacyMigration: LegacyMigrationDialogData | null;
}
```

What it renders:
- A centered container, `max-w-4xl mx-auto px-4 sm:px-6 py-8`, sitting inside the existing `<SidebarInset className="h-svh">`.
- A heading + subtitle, computed via the same ternary as today with a new top branch for multi-org users:

  ```ts
  const subtitle = legacyMigration?.eligible
    ? "Pick a paid plan to switch over from your existing subscription, or bring your own API key to keep using camelAI on the free tier."
    : multiOrg
      ? `${currentOrgName} is on the Free plan with no API key set up. Pick a plan, or switch to an organization with an active plan using the sidebar.`
      : byokProviderLabel
        ? `Your ${byokProviderLabel} API key is connected. Continue on Free, or start a paid plan for hosted credits.`
        : trialAvailable
          ? "Start a free trial with model credits, or use your own API key."
          : "Choose a plan, or use your own API key.";
  ```

  The multi-org branch points the user at the sidebar so they discover the workspace switcher as the cross-org escape hatch.
- `<PlanPicker>` with the same prop shape used in `welcome.tsx` (`defaultBillingMode="individual"`, `trialAvailable`, `byokProviderLabel`, `legacyMigration`, `disabledReason` for the multi-legacy-sub case, `onLegacyWhyClick`, `pendingPlan`, `onSelectPlan`).
- `<ByokKeyDialog>` for BYOK setup, identical wiring.
- `<LegacyMigrationDialog>` + `<LegacyMigrationConfirmDialog>` when `legacyMigration?.eligible`.
- The Alert blocks for `checkoutError`, `migrationError`, and provider-save errors, identical to welcome's pattern.

**Fetchers live inside `PaywallTakeover`:**
- Checkout fetcher posts to **`/api/billing/start-trial`** (new endpoint — see below). On success, redirects to the Stripe `checkoutUrl`.
- Provider fetcher posts to `/api/orgs/${currentOrgId}/llm-provider` — unchanged.
- Migration fetcher posts to `/api/billing/legacy-migration` — unchanged.

**`PaywallTakeover` does NOT call `/api/onboarding/complete`.** The user has already onboarded (otherwise `_app.tsx` would have redirected them to `/onboarding` for the onboarding-incomplete gate). After successful BYOK or Stripe return, the natural revalidation of the `_app.tsx` loader picks up the new state and the takeover unmounts.

The `currentOrgId` for the provider fetcher comes from `useAuthData().currentOrg.id` — already available via `_app.tsx`'s loader.

### New: `src/routes/api/billing.start-trial.ts`

Extract the trial-checkout logic from the welcome route's action ([_onboarding.welcome.tsx:112-175](src/routes/_onboarding.welcome.tsx#L112-L175)) into a standalone endpoint, with `/chat?checkout=success` as the return URL (since the takeover lives in `_app`):

```ts
import { createSubscriptionCheckoutSession, getBillableTeamSeatCountForOrg } from "@/lib/billing.server";
// ...same imports as the welcome action

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const formData = await request.formData();
  const rawPlan = String(formData.get("plan") || "").trim();
  if (!isTrialPlan(rawPlan)) {
    return Response.json(
      { error: "Choose Starter, Pro, or Team to start a trial." },
      { status: 400 },
    );
  }

  const successUrl = new URL("/chat?checkout=success", request.url).toString();
  const cancelUrl = new URL("/chat?checkout=cancelled", request.url).toString();

  const seatCount = rawPlan === "team"
    ? await getBillableTeamSeatCountForOrg(env, authContext.currentOrg.id)
    : 1;

  const checkoutUrl = await createSubscriptionCheckoutSession({
    env,
    org: authContext.currentOrg,
    customerEmail: authContext.user.email,
    successUrl,
    cancelUrl,
    plan: rawPlan,
    seatCount,
  });

  return Response.json({ checkoutUrl });
}
```

Register in `src/routes.ts`.

**The welcome route's existing action is left alone** — it keeps its `/onboarding?checkout=success` and `/onboarding?checkout=cancelled` URLs so the brand-new-user flow still returns into the auto-complete sequence at `_onboarding.tsx:226-244`, which fires `/api/onboarding/complete` and runs the boot-modal / first-chat seeding flow. The two endpoints are parallel:
- **Welcome action**: serves brand-new users mid-onboarding. Success returns to `/onboarding`.
- **`/api/billing/start-trial`**: serves already-onboarded users in the takeover. Success returns to `/chat`.

Small duplication (~30 lines), big safety. Don't try to unify them in this PR.

### Modified: `src/routes/dev.billing-paywall.tsx`

Today this preview renders the bare `PlanPicker`. Change it to render `<PaywallTakeover paywallContext={...} legacyMigration={...} />` directly with mock data, so the dev preview shows what users actually see. Keep the existing `PREVIEW_STATES` for visual coverage.

---

## Files Changed

### New
| File | Purpose |
|---|---|
| `src/components/billing/paywall-takeover.tsx` | In-app paywall (PlanPicker + BYOK dialog + legacy dialogs + fetchers). |
| `src/routes/api/billing.start-trial.ts` | Standalone Stripe-trial checkout endpoint for the takeover flow. Returns to `/chat`. |

### Modified
| File | Change |
|---|---|
| `src/routes/_app.tsx` | Drop the billing redirect at line 65-66. Capture `orgInfo` / `llmProviderConfig` for `paywallContext`. Render `<PaywallTakeover>` inside `<SidebarInset>` when `!billingAccessReady`. |
| `src/routes/_onboarding.tsx` | Drop `billingAccessReady` from the redirect-to-/chat condition at lines 110-117 so already-onboarded users always leave `/onboarding`. |
| `src/routes/dev.billing-paywall.tsx` | Render `<PaywallTakeover>` instead of bare `<PlanPicker>`. |
| `src/routes.ts` | Register the new `/api/billing/start-trial` route. |

### NOT changed (deliberately)
- **`src/routes/api/onboarding.complete.ts`** — all preconditions stay (email verified, billing access, BYOK presence). System messages, salesPrompt handling, thread creation, `hasUserThreadsAcrossOrgs` recovery, `showBootModal`, `initialMessageContent` — every line preserved.
- **`src/routes/_onboarding.welcome.tsx`** — left alone. Brand-new users continue to see the `isBillingChoiceRequired` PlanPicker branch, the existing `checkoutFetcher` posts to the route's own action (returns to `/onboarding?checkout=success`), the `auto-complete` flow fires after Stripe return, and the polished first-chat plays.
- **The welcome route's action** — keeps creating Stripe sessions with `/onboarding?checkout=success`.
- **`/api/onboarding/complete`'s billing precondition at lines 183-196** — explicitly preserved. This is what protects the seeded first-chat from running without an LLM.
- **`onboarding-loading-modal.tsx`, `Chat.tsx`'s `initialMessageContent` auto-send, `sessionStorage.showBootModal` flag** — untouched.
- **`AppSidebar`, `WorkspaceSwitcher`, `NavUser`, chat-groups list** — no UI changes. Cross-org workspace switching already works ([auth.switch-workspace.ts:108-114](src/routes/api/auth.switch-workspace.ts#L108-L114)).
- **`PlanPicker`, `PlanPickerCard`, `LegacyMigrationDialog`, `ByokKeyDialog`, `LegacyMigrationConfirmDialog`** — no API or visual changes.
- **`/api/billing/legacy-migration`, `/api/orgs/:id/llm-provider`, `/api/auth/switch-org`, `/api/auth/switch-workspace`** — all reused as-is.

---

## Behavior Details

### Brand-new signup (unchanged)

1. Sign up → session pinned to fresh Org A → `/onboarding`.
2. `_onboarding.tsx` loader: `onboardingComplete=false`. Doesn't redirect.
3. `welcome.tsx` `isBillingChoiceRequired=true` → renders `PlanPicker`.
4. User picks Starter trial → welcome's action creates Stripe session with `successUrl=/onboarding?checkout=success` → redirected to Stripe.
5. Stripe payment succeeds → returns to `/onboarding?checkout=success`.
6. `_onboarding.tsx` loader: `onboardingComplete=false, billingAccessReady=true`. `needsWelcomeScreen=false`. `runAutoComplete` fires.
7. `/api/onboarding/complete` runs — email verified ✓, billing access ✓ → creates thread, builds `initialMessageContent`, returns `{ threadId, redirectTo: /chat/{threadId}?newThread=1, initialMessageContent, showBootModal: true }`.
8. Client navigates with router state + sessionStorage flag.
9. `_app.tsx` loader: `onboardingComplete=true, billingAccessReady=true` → renders `<Outlet />`.
10. Chat.tsx mounts → boot modal plays → first message auto-sends → agent responds (AskUserQuestion or sales-prompt dive-in). ✅

**Every step is identical to today.** The plan touches none of it.

The BYOK variant of this flow is the same: user picks Free → BYOK key dialog → submits → `/api/orgs/:id/llm-provider` fires → `completeWithByok` is invoked → `/api/onboarding/complete` runs (now with `llmProviderConfig` satisfying the billing check) → polished first-chat. Unchanged.

### Multi-org user switching to an unpaid org (the bug)

1. User in Org A (paid, already onboarded) opens `/settings/organizations` → clicks "Switch to Org B" (free, no BYOK).
2. `/api/auth/switch-org` re-signs cookie.
3. Loaders revalidate. `_app.tsx` loader: `onboardingComplete=true` (user-scoped — already true from when they onboarded in Org A), `billingAccessReady=false` (Org B). Returns `paywallContext` instead of redirecting.
4. `_app.tsx` render: sidebar renders, `<SidebarInset>` shows `<PaywallTakeover>`.
5. `WorkspaceSwitcher` lists Org A's workspaces with "Org A" as the subtitle. User clicks an Org A workspace.
6. `switchWorkspace(orgA-ws-id)` → cross-org switch → loader revalidates → `billingAccessReady=true` for Org A → takeover unmounts → chat renders. ✅

### Churned user (subscription lapsed, no BYOK)

Same flow as above without the "switch back." They see the takeover in their current org. They can pay again, set up BYOK, log out, or navigate to `/settings/profile` from `NavUser`. Their workspaces / chats / apps are visible in the sidebar (reassurance their data is intact) but each click lands on the same takeover.

### Stripe checkout from PaywallTakeover

1. User clicks "Start trial" (Starter/Pro/Team) in the takeover.
2. `checkoutFetcher.submit({ plan }, { method: "post", action: "/api/billing/start-trial" })`.
3. Endpoint creates Stripe Checkout Session with `success_url=/chat?checkout=success`, returns `checkoutUrl`.
4. Client redirects to Stripe via `window.location.assign(checkoutUrl)`. **At this point the user is on Stripe's domain, not ours.**
5. Stripe payment succeeds → returns to `/chat?checkout=success`. `_app.tsx` loader sees `billingAccessReady=true`, renders `<Outlet />`. Chat works.
6. Cancelled checkout returns to `/chat?checkout=cancelled` → `_app.tsx` still sees `billingAccessReady=false` → takeover re-renders. User can retry or pick BYOK.

### BYOK setup from PaywallTakeover

1. User clicks "Add my API key" on the Free card → `ByokKeyDialog` opens.
2. User submits → `providerFetcher.submit(payload, { method: "POST", action: "/api/orgs/${currentOrgId}/llm-provider" })`.
3. On success, the loader revalidates, `llmProviderConfig` is set, `billingAccessReady=true`, takeover unmounts. No call to `/api/onboarding/complete` (user already onboarded).

### Already-onboarded user navigates to `/onboarding` directly

Some users may have `/onboarding` bookmarked from the bad multi-org redirect days. After the fix:
1. `_onboarding.tsx` loader: `onboardingComplete=true, !teamMode, !emailVerificationRequired` → redirect to `/chat`.
2. In `/chat`, `_app.tsx` decides Outlet vs PaywallTakeover based on billing.

Clean.

### Legacy migration

`legacyMigration` is already fetched in `_app.tsx`'s loader ([_app.tsx:104-109](src/routes/_app.tsx#L104-L109)). Two surfaces consume it:
- The floating `LegacyMigrationDialog` at the bottom of `_app.tsx` (already there) — keeps firing for users who DO have billing but are legacy-eligible.
- The new `PaywallTakeover` — renders its own intro `LegacyMigrationDialog` + `LegacyMigrationConfirmDialog` when applicable, identical pattern to today's welcome route.

---

## Risks & Regressions to Watch

1. **First-time signup regression.** The plan explicitly does not touch `welcome.tsx` or `/api/onboarding/complete`, so this should be fully preserved. Manual QA: sign up a fresh test account, walk through `Choose Starter` → Stripe checkout (test mode) → return → confirm boot modal plays → confirm AskUserQuestion fires → confirm agent responds. Repeat with BYOK path. Repeat with the sales-site `?prompt_key=...` path.

2. **Tests asserting `/onboarding` redirect for billing.** Likely some worker tests assert the `_app.tsx` billing redirect. Flip them to assert the new "renders content + paywallContext" behavior.

3. **`_app.tsx` loader cost.** When billing is missing, we now do an extra DO call (`hasOrgUsedSubscriptionTrial(orgInfo)`) — but `orgInfo` is already fetched for the enterprise check, so this is a property read on existing data, not a new round-trip. No real cost increase.

4. **Tail behavior of legacy migration on the `_app.tsx` floating dialog.** The floating dialog at [_app.tsx:202-213](src/routes/_app.tsx#L202-L213) renders regardless of `billingAccessReady`. When the takeover *also* renders its own `LegacyMigrationDialog`, we could get two modals trying to open simultaneously. Mitigation: in `PaywallTakeover`, only render its `LegacyMigrationDialog` and skip the floating one when both would otherwise fire — easiest is to suppress the floating one when `!billingAccessReady` (pass a `legacyMigrationOpen=false` or render `null` for it). Verify in dev which order they open in practice and gate accordingly.

---

## Implementation Order

1. **Extract `/api/billing/start-trial`** as a standalone endpoint with `/chat?checkout=success`. Don't touch the welcome route's action.
2. **Build `PaywallTakeover`** and wire it via `dev.billing-paywall.tsx` first so it can be visually iterated without touching the routing layer.
3. **Modify `_app.tsx`**: drop the billing redirect, capture `orgInfo` + `llmProviderConfig` for `paywallContext`, render `<PaywallTakeover>` conditionally. Manual QA: log into an account with billing → app works as today. Log into an account without billing (toggle to an unpaid org) → takeover renders with sidebar.
4. **Modify `_onboarding.tsx`** redirect condition. Verify already-onboarded users hitting `/onboarding` get bounced to `/chat`.
5. **Modify `dev.billing-paywall.tsx`** to render the new takeover.
6. **Manual QA — bug fix path**: as a multi-org user (one paid, one unpaid), switch into the unpaid one. Confirm takeover renders with sidebar. Switch via workspace switcher to a paid-org workspace. Confirm chat loads.
7. **Manual QA — first-time onboarding path**: sign up fresh accounts on both billing paths (Stripe trial + BYOK). Confirm welcome PlanPicker still appears, Stripe checkout still returns into auto-complete, boot modal still plays, first-chat seeding still works.
8. **Tests**: add a focused test for `_app.tsx` returning `paywallContext` (not redirecting) when billing is missing. Update any worker tests asserting the old redirect. `bun run typecheck`, `bun run test:run`, `bun run test:workers`.

---

## Alternatives Considered (and rejected)

### Decouple billing from `/api/onboarding/complete` entirely

Earlier draft of this plan proposed removing the 402 check so brand-new users could "complete onboarding" without billing and land in `/chat` with the in-app takeover. Rejected: the endpoint creates a thread and seeds an `initialMessageContent` system message that the chat auto-sends. Without an LLM provider, the auto-sent first message fails and the polished boot-modal + AskUserQuestion + agent-response sequence collapses. The 402 protects first-chat UX, not just monetization.

### Soft gate (user can browse, can't send messages)

Lets churned users browse and export. Rejected: BYOK is free and 30 seconds away (it's the real export path); gating every interactive surface (send, deploy, cron, connection-create) expands surface area for a marginal audience; partial functionality is more confusing than a clean takeover.

### Keep the `/onboarding` redirect and just add escape hatches (an earlier draft)

Drafted as v1, then rejected in conversation. The header-fix approach solves the symptom but leaves the conceptual mistake in place: a churned user still gets "welcomed" through an onboarding-shaped shell.

### Redesign the workspace switcher to group by org

Out of scope. Org name is already in the subtitle of each workspace item and cross-org switching already works. Not making UI changes the bug doesn't require.

---

## Not in Scope

- Any change to the first-time onboarding flow.
- Any change to `/api/onboarding/complete`, the boot modal, the salesPrompt path, or chat first-message auto-send.
- Workspace switcher redesign.
- Adding a dedicated org switcher to `NavUser`.
- A `toast.success("Trial started")` on `?checkout=success`. Trivial follow-up.
- Letting `/onboarding` show a logout for users stuck mid-onboarding. Separate edge case.
- Reworking the legacy-migration UX. The existing dialogs are reused as-is.
- Telemetry on takeover impressions / conversions. Worth adding once shipped.
