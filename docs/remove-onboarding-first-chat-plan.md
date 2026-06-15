# Remove Onboarding First Chat Plan

## Status

2026-06-15 - Draft v1 for review.

## Goal

Remove the entire post-onboarding "first chat" flow. After a user satisfies the
remaining onboarding gates, they should land on the normal `/chat` welcome
screen with no auto-created thread, no seeded system message, no agent-initiated
`AskUserQuestion`, and no "Setting up your machine" modal.

Preserve the sales-site mock-chat pipe. The sales site lets a visitor type an
arbitrary prompt into a mock camelAI chat and passes that text into the main app.
This change must not drop, sanitize away, consume too early, or otherwise break
that handoff. The only behavioral difference for brand-new users is that the
prompt becomes editable text in the `/chat` welcome composer instead of being
auto-sent through an onboarding-created first thread.

The remaining onboarding gates are:

1. Email verification, when required for password signup.
2. Paywall / billing access.
3. LLM provider setup only when the chosen access path needs it, such as Free /
   BYOK or Pay as you go with a user-provided key.
4. Team invitation welcome, only as a lightweight confirmation screen.

This should be a deletion-heavy change. Do not replace the removed first-chat
experience with another prompt, modal, tour, or static interstitial.

---

## Current Behavior To Remove

The current flow is spread across these files:

| File | Current responsibility |
|---|---|
| `src/routes/_onboarding.tsx` | Calls `POST /api/onboarding/complete`, stores `sessionStorage.showBootModal`, and navigates to the created thread route. |
| `src/routes/api/onboarding.complete.ts` | Marks onboarding complete, creates or recovers `"{firstName}'s first chat"`, starts an initial hidden system/user message through `ChatThreadDO`, clears pending sales prompts, optionally starts title generation, and returns `showBootModal: true`. |
| `src/components/onboarding-loading-modal.tsx` | Static one-time boot modal with "Setting up your machine" copy. |
| `src/components/Chat.tsx` | Reads `sessionStorage.showBootModal`, opens `OnboardingLoadingModal` on new-thread routes, then clears the flag. |
| `src/routes/_onboarding.welcome.tsx` | Calls `completeOnboarding()` after email/team/BYOK flows and indirectly enters the first-chat path. |

Remove the first-chat parts only. Keep the paywall, BYOK key dialog, hosted
credit top-up, subscription checkout, legacy migration UI, and email
verification UI.

---

## Target Flow

### Brand-new OAuth signup

```text
OAuth signup
  -> /onboarding
  -> if billing/provider access is already ready, auto-complete onboarding
  -> /chat
```

No thread exists until the user submits the `/chat` welcome composer.

### Password signup

```text
Password signup
  -> /onboarding
  -> email verification card, if unverified
  -> once verified, auto-complete onboarding
  -> /chat
```

### Billing-required signup

```text
/onboarding
  -> PlanPicker / BYOK / Pay as you go / Stripe checkout
  -> return to /onboarding after access is ready
  -> auto-complete onboarding
  -> /chat
```

### Team invitation

```text
/onboarding?team=1
  -> lightweight team welcome
  -> Continue to chat
  -> /chat
```

### Sales-site prompt handoff

For new users arriving from the sales site with a prompt, do not auto-send the
prompt anymore. Preserve it by pre-filling the `/chat` welcome composer, matching
the existing returning-user behavior.

Protected pipe:

```text
sales-site mock chat input
  -> prompt_key / APP_KV
  -> signup or OAuth stores pending prompt on UserDO for incomplete users
  -> onboarding completes without creating a thread
  -> /chat loader consumes pending prompt
  -> Chat receives initialWelcomeInput
  -> welcome composer is prefilled, editable, and not auto-submitted
```

Do not remove `prompt_key`, `consumeSalesPrompt`, `setPendingSalesPrompt`, or the
existing returning-user `/chat` loader path. They are part of the pipe.

---

## UI Requirements

No new UI surfaces are needed.

Use the existing shadcn primitives already present in the project:

| Surface | Components |
|---|---|
| Onboarding errors | `Alert`, `AlertDescription` |
| Onboarding actions | `Button` |
| Paywall | Existing `PlanPicker` |
| BYOK setup | Existing `ByokKeyDialog` |
| Pay as you go choice | Existing `Dialog`, `DialogContent`, `DialogHeader`, `DialogFooter`, `Button` |
| Credit top-up | Existing `TopUpDialog` |

The local shadcn registry MCP is not configured in this workspace, and these
components already exist under `src/components/ui/`. Do not install new shadcn
blocks for this change.

Exact copy updates:

| Location | Current copy | New copy |
|---|---|---|
| `_onboarding.tsx` auto-complete error paragraph | `Retry and we'll set up your first chat.` | `Retry and we'll take you to chat.` |
| `_onboarding.welcome.tsx` non-billing/team CTA | `Get Started` | `Continue to chat` |
| `_onboarding.welcome.tsx` pending CTA | `Getting Started...` | `Opening chat...` |

Keep the existing `PlanPicker` heading and billing copy unless tests force a
small wording adjustment. The requested product change is removing the chat seed,
not redesigning the paywall.

---

## Implementation Plan

### 1. Simplify `POST /api/onboarding/complete`

File: `src/routes/api/onboarding.complete.ts`

Turn this endpoint into a pure onboarding completion gate:

1. Keep `POST` method validation.
2. Keep `requireAuthContext`.
3. Keep the selected workspace guard unless a nearby existing helper proves the
   app can safely land on `/chat` without one.
4. Keep email verification enforcement.
5. Keep BYOK access-choice validation:
   - If `accessChoice === "byok"` and no effective provider config exists,
     return the current 400 error.
6. Keep billing access enforcement through `resolveOrgBillingAccess` and
   `isOrgBillingAccessReady`.
7. If `authContext.onboarding?.completed_at` is missing, call
   `userStub.updateOnboarding({ completed_at: Date.now() })`.
8. Return:

```ts
return Response.json({
  success: true,
  redirectTo: "/chat",
});
```

Delete all first-chat behavior from this file:

- `chatDO.createThread`
- `chatDO.deleteThread`
- `chatDO.getThreadsPaginated`
- `chatDO.generateThreadTitle`
- `CHAT_THREAD.startInitialUserMessage`
- `getDefaultOnboardingSystemMessage`
- `SALES_SITE_ONBOARDING_SYSTEM_MESSAGE`
- `getOnboardingSystemMessage`
- `buildOnboardingInitialMessage`
- `startOnboardingInitialMessage`
- `onboardingInitialMessageFailureResponse`
- `hasUserThreadsAcrossOrgs`
- `waitUntil`
- `LlmModel` / `onboardingModel`
- `threadId`, `salesPrompt`, and `showBootModal` response fields
- recovery logic for already-completed onboarding threads

Important: do not consume or clear the pending sales prompt in this endpoint.
The `/chat` loader should consume it so the prompt becomes editable welcome
composer text instead of an auto-sent first message.

### 2. Remove boot-modal handoff from `_onboarding.tsx`

File: `src/routes/_onboarding.tsx`

Update `completeOnboarding`'s response type to only expect:

```ts
{
  redirectTo?: string;
}
```

Delete the `sessionStorage.showBootModal` write/remove block. Completion should
only call:

```ts
navigate(data.redirectTo || "/chat");
```

Keep the existing auto-complete retry loop. Its purpose remains useful: once
email/billing/provider gates are satisfied, `/onboarding` should quietly finish
and route the user into `/chat`.

Update the error-state copy to the exact string in the UI requirements table.

### 3. Keep onboarding welcome, but make its destination explicit

File: `src/routes/_onboarding.welcome.tsx`

Keep these existing surfaces:

- Email verification card.
- Team welcome summary.
- `PlanPicker`.
- `ByokKeyDialog`.
- Pay as you go choice dialog.
- `TopUpDialog`.
- Legacy migration dialogs.

Behavioral changes:

1. The "Get Started" button should become "Continue to chat".
2. The pending label should become "Opening chat...".
3. Existing calls to `context.completeOnboarding()` should remain, but they now
   land on `/chat`.
4. `continueWithOwnApiKey` should still:
   - immediately complete if `byokProviderLabel` already exists;
   - otherwise open `ByokKeyDialog`;
   - after provider save succeeds, call `completeWithByok()`.
5. Stripe checkout success should keep returning to `/onboarding`; once billing
   access is ready, `_onboarding.tsx` should auto-complete and navigate to
   `/chat`.

Do not add a new loading modal, welcome modal, onboarding checklist, or chat
prefill besides the sales-site prompt behavior below.

### 4. Delete the post-onboarding loading modal

Delete:

| File | Reason |
|---|---|
| `src/components/onboarding-loading-modal.tsx` | This is the static "Setting up your machine" modal being removed. |

Update `src/components/Chat.tsx`:

1. Remove the `OnboardingLoadingModal` import.
2. Remove `shouldShowBootModalFromStorage`.
3. Remove `bootModalOpen` state.
4. Remove the effect that clears `sessionStorage.showBootModal`.
5. Remove the `<OnboardingLoadingModal ... />` render near the bottom.

After this change, `Chat.tsx` should not reference `showBootModal` or
`OnboardingLoadingModal`.

### 5. Preserve sales-site prompts as `/chat` welcome composer text

Current new-signup behavior stores a pending prompt on `UserDO`:

- `src/routes/api/auth.signup.ts`
- `workers/main/src/routes/oauth.ts`
- `workers/main/src/identity/user-do.ts`

Because `/api/onboarding/complete` will no longer consume that prompt, add a
server-side handoff to the `/chat` welcome loader.

Recommended implementation:

1. Add a `consumePendingSalesPrompt(): string | null` method to
   `workers/main/src/identity/user-do.ts`.
2. Implement it by reading `pendingSalesPrompt`, deleting it when present, and
   returning the value.
3. In `src/routes/_app.chat._index.tsx`, after the existing `prompt_key` KV
   handling, consume the UserDO pending prompt when:
   - `authContext.onboarding?.completed_at` is truthy;
   - `salesPrompt` is still null.
4. Sanitize the returned prompt with `sanitizeSalesPrompt` from
   `src/lib/sales-prompt.server.ts` before assigning it to the loader's
   `salesPrompt`.
5. Keep passing `salesPrompt` to `<Chat initialWelcomeInput={salesPrompt} />`.
   `Chat.tsx` already seeds the welcome composer from this prop and removes
   `prompt_key` from the URL for the KV path.

Constraints for the pipe:

- Returning users with `?prompt_key=...` should behave exactly as they do today:
  the `/chat` loader consumes KV and pre-fills the composer.
- New or incomplete users should keep the current signup/OAuth behavior of
  moving the prompt from KV into `UserDO`, because email verification can outlive
  the KV TTL.
- The pending `UserDO` prompt should be consumed only after onboarding is
  complete and the user is actually loading `/chat`.
- If consuming the pending prompt fails, log the failure and still render `/chat`;
  do not block onboarding completion.
- Do not auto-submit the prompt from the `/chat` loader or `Chat.tsx`.

Pseudo-code for the loader:

```ts
if (authContext.onboarding?.completed_at) {
  if (promptKey) {
    salesPrompt = await consumeSalesPrompt(env.APP_KV, promptKey).catch(...);
  }

  if (!salesPrompt && authContext.user?.id) {
    const pendingPrompt = await authEnv.USER
      .get(authEnv.USER.idFromName(authContext.user.id))
      .consumePendingSalesPrompt()
      .catch((error) => {
        console.error("Failed to consume pending sales prompt:", error);
        return null;
      });

    salesPrompt = pendingPrompt ? sanitizeSalesPrompt(pendingPrompt) : null;
  }
}
```

Update comments in signup/OAuth code so they no longer say the prompt is stored
for the first-chat onboarding flow. It is stored for the `/chat` welcome loader.

### 6. Clean up stale tests and mocks

Update or replace `tests/onboarding-complete-sales-prompt.test.ts`.

The new test shape should assert:

- `POST` is required.
- Email verification still blocks completion with 403.
- Missing workspace still blocks completion if that guard is kept.
- `accessChoice: "byok"` still requires an effective provider config.
- Missing billing access still returns 402.
- Ready hosted billing, enterprise, and BYOK states mark onboarding complete and
  return `{ success: true, redirectTo: "/chat" }`.
- Already-completed onboarding returns `{ success: true, redirectTo: "/chat" }`
  without trying to recover a first-chat thread.
- Pending sales prompt methods are not called by this endpoint.
- No chat DO mocks are needed.

Update `tests/new-chat-sales-prompt-loader.test.ts`:

- Keep the existing `prompt_key` KV test for returning users.
- Add a test where `UserDO.consumePendingSalesPrompt()` returns a prompt for an
  onboarded user and the loader returns it as `salesPrompt`.
- Assert the pending prompt method is called once and that malformed system tags
  are stripped via `sanitizeSalesPrompt`.
- Add a regression test for the sales-site mock-chat pipe: signup/OAuth stored
  prompt on `UserDO` -> onboarding complete -> `/chat` loader returns that prompt
  as `salesPrompt`.
- If both `prompt_key` and pending prompt exist, `prompt_key` should win.

Update component tests that mock the removed modal:

- `tests/chat-draft-persistence.test.tsx` currently mocks
  `@/components/onboarding-loading-modal`; remove that mock after the import is
  gone from `Chat.tsx`.

Keep the existing Pay as you go route/component tests and adjust only if button
copy assertions change:

- `tests/onboarding-welcome-payg-route.test.ts`
- `tests/onboarding-welcome-payg.test.tsx`

### 7. Search-based cleanup

Before finishing implementation, run these searches and remove stale references
that are in the onboarding first-chat path:

```bash
rg -n "showBootModal|OnboardingLoadingModal|Setting up your machine|Machine ready" src tests
rg -n "startInitialUserMessage|onboardingInitialMessage|onboarding chat|first chat" src/routes src/components tests
rg -n "getPendingSalesPrompt|clearPendingSalesPrompt|pendingSalesPrompt" src workers/main tests
```

Do not delete unrelated "first chat" references in analytics, admin explorer, or
chat-group docs/code unless they specifically point at the onboarding-seeded
thread flow.

---

## Files Summary

### Delete

| File | Reason |
|---|---|
| `src/components/onboarding-loading-modal.tsx` | Static setup modal removed from onboarding. |

### Modify

| File | Change |
|---|---|
| `src/routes/api/onboarding.complete.ts` | Reduce to validation + `completed_at` update + `/chat` response. Remove all thread creation and initial-message code. |
| `src/routes/_onboarding.tsx` | Stop storing `showBootModal`; navigate to `/chat`; update response type and retry error copy. |
| `src/routes/_onboarding.welcome.tsx` | Keep existing gates; update CTA copy; ensure completion lands on `/chat`. |
| `src/components/Chat.tsx` | Remove boot-modal state, storage reads, import, and render. |
| `workers/main/src/identity/user-do.ts` | Add `consumePendingSalesPrompt()` for `/chat` loader handoff. |
| `src/routes/_app.chat._index.tsx` | Consume pending UserDO sales prompt into existing `initialWelcomeInput` path. |
| `src/routes/api/auth.signup.ts` | Update comments around pending prompt storage. |
| `workers/main/src/routes/oauth.ts` | Update comments around pending prompt storage. |
| Relevant tests | Rewrite expectations away from thread creation and boot modal. |

---

## Verification

Run:

```bash
bun run typecheck
bun run test:run -- \
  tests/onboarding-complete-sales-prompt.test.ts \
  tests/onboarding-welcome-payg-route.test.ts \
  tests/onboarding-welcome-payg.test.tsx \
  tests/new-chat-sales-prompt-loader.test.ts \
  tests/app-loader-sales-prompt.test.ts \
  tests/chat-draft-persistence.test.tsx
```

Manual smoke checks:

1. Fresh OAuth signup with billing/provider access ready -> lands on `/chat`,
   no thread is created, no modal appears.
2. Fresh password signup -> email verification gate remains; after verification,
   lands on `/chat`.
3. Free/BYOK path -> save API key -> lands on `/chat`, no modal, no seeded
   assistant message.
4. Pay as you go with hosted credits -> Stripe/top-up success returns to
   `/onboarding`, then lands on `/chat`.
5. Starter/Pro/Team subscription checkout -> success returns to `/onboarding`,
   then lands on `/chat`.
6. Team invitation -> team welcome -> `Continue to chat` -> `/chat`.
7. Sales-site prompt for a new user -> after onboarding, `/chat` composer is
   prefilled with the prompt and nothing is auto-sent.
8. Sales-site prompt for a returning user -> `/chat?prompt_key=...` still
   pre-fills the composer as it does today.

---

## Out Of Scope

- Redesigning the `/chat` welcome screen.
- Changing `WelcomeScreen`, `PromptInput`, recent chats, app cards, connections,
  or chat groups.
- Changing `AskUserQuestion` itself. It should simply no longer be triggered by
  onboarding.
- Changing the sales site transport mechanism or KV prompt format.
- Migrating or deleting historical onboarding-created threads.
- Removing admin/chat-explorer "first chat" analytics concepts.
- Removing billing paywall takeover behavior for already-onboarded users.
- Editing historical docs such as `docs/onboarding-overhaul-plan.md` or
  `docs/post-onboarding-loading-modal.md`; they can remain as historical plans.
