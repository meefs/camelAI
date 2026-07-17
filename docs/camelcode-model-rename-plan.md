# Rename the Free Model from Camel Free to camelCode

Created: July 16, 2026

Status: implementation plan; no product code has been changed by this plan.

This document is intended to be handed directly to a coding agent. It covers
the camelAI application repository only.

## Goal

Rename the product-facing free model from **Camel Free** to **camelCode**
everywhere users or operators see the model name, and align model-specific
source names so the old brand does not keep spreading through new code.

This is a terminology-only change. It must not change model routing, billing
eligibility, free-tier behavior, model capabilities, persisted thread models,
usage pricing, or fallback behavior.

Use this exact spelling and capitalization in all human-readable copy:

```text
camelCode
```

Do not use `CamelCode`, `Camel Code`, or `camel Code`, including at the start of
a sentence.

## Critical Compatibility Boundary

The current product name and the underlying machine identifiers are separate.
Only the name is changing.

| Surface | Current value | Implementation decision |
| --- | --- | --- |
| Product/display name | `Camel Free` | Change to `camelCode`. |
| Curated `LlmModel` id | `deepseek-v4-auto` | **Keep unchanged.** It is stored on threads and used by routing, pricing, admin schemas, virtual AI bindings, evals, and tests. Do not add a model migration or legacy replacement. |
| Hosted gateway model | `dynamic/deepseek-v4-auto` | **Keep unchanged.** |
| Free-access billing mode | `camel_free` | **Keep unchanged.** This is an internal server/client access-mode discriminant, not displayed model copy. Renaming it would expand the change into an unrelated data-contract migration. |
| Model cost bucket / plan name | `Free` | **Keep unchanged.** “Free plan,” “free users,” “free traffic,” “free and always included,” and the `Free` cost badge still describe pricing/access and are not the old model name. |
| Welcome dismissal key | `camel-free-welcome-dismissed:{userId}:{orgId}` | **Keep reading and writing this exact key.** Existing dismissals must survive the rename so users do not see the first-run modal again. |
| Eval target/report ids | existing `camel-free-*` and `hosted-credit-camel-free-*` ids | **Keep unchanged.** They are machine-facing CLI/report identifiers with historical runs. Update their human-readable manifest descriptions, suite titles, and score labels only. |

There should be no changes to `src/types.ts`, `src/lib/usage-pricing.ts`,
`workers/main/src/pi-model-resolution.ts`,
`workers/main/src/ai-virtual-binding.ts`, or the admin model enums. Those
surfaces operate on `deepseek-v4-auto`, which remains the canonical model id.

## Audit Summary

The repository currently has two independent model-label sources plus several
hard-coded UX sentences. Updating only the picker catalog would leave the old
name in settings, onboarding, fallback, billing, and plan surfaces.

### Live model metadata

| File | Current role | Required change |
| --- | --- | --- |
| `src/lib/model-catalog.ts` | Canonical picker catalog entry for `deepseek-v4-auto`; feeds the thread picker, selected-model button, and metadata hover card | Change the entry label to `camelCode`; keep id, logo, order, cost, intelligence, and speed unchanged. |
| `src/lib/llm-provider-config.ts` | Provider/model option label used by settings and provider-scoped model lists | Change the option label to `camelCode`; keep its description and all routing/visibility sets unchanged. Rename only the model-specific exported source constant as described below. |

### Live user-facing copy

| File | User-visible surface | Required copy |
| --- | --- | --- |
| `src/components/camel-free-welcome-dialog.tsx` | First-run free-model welcome | Title becomes `You're on camelCode`. The two body references already say `camelCode` and should remain unchanged. |
| `src/components/model-fallback-banner.tsx` | Sticky banner after an exhausted/unavailable premium model falls back | Use `Monthly credits used up — switched to camelCode.` and `Your subscription is unavailable — switched to camelCode.` |
| `src/components/billing/unlock-premium-modal.tsx` | Explanation shown when a user selects a locked model | Use `camelCode is always included. Premium models like {triggerLabel} need one of these:`. |
| `src/components/billing/plan-upgrade-dialog.tsx` | Free-plan explanation at the top of the plan dialog | Use `You're on the Free plan — camelCode included forever. Upgrade for premium models, more apps, and automations.` |
| `src/components/billing/plan-picker-content.ts` | Starter, Pro, Team, and Enterprise plan features | Change each feature to `Priority over free traffic on camelCode`. Keep “free traffic”; it describes scheduling priority. |

The model metadata card in `src/components/model-picker.tsx` does not hard-code
the old display name; it gets `entry.label` from the catalog. Its special free
model description should remain “Free and always included…” because that is
pricing/capability copy. Its import of the model-specific constant will change
as part of the source rename.

### Developer previews and operational documentation

| File | Required change |
| --- | --- |
| `src/routes/dev.billing-paywall.tsx` | Update the free-state description and “Open … welcome” button to `camelCode`; update the renamed welcome component import/use. |
| `src/routes/dev.chat-credit-states.tsx` | Update the renamed welcome component import/use. Fallback banner copy flows from the production component. |
| `docs/staging-onboarding-billing-e2e.md` | Update the current staging runbook’s human-readable model references to `camelCode`. |
| `e2e/staging-billing/staging-billing.spec.ts` | Update the test title, picker/banner assertions, and checkpoint artifact slug to the new name. |

`src/components/sidebar/app-sidebar.tsx` also carries the internal
`billingAccessMode === "camel_free"` check that decides whether to show the
free-org upgrade entry. It renders no old model-name copy and requires no
change; keep that access-mode check intact.

### Model-specific source terminology

The following names encode the retired product name rather than a durable data
contract. Rename them so future code uses the current product vocabulary:

| Current | Replacement |
| --- | --- |
| `CAMEL_FREE_LLM_MODEL` | `CAMEL_CODE_LLM_MODEL` |
| `src/components/camel-free-welcome-dialog.tsx` | `src/components/camel-code-welcome-dialog.tsx` |
| `CamelFreeWelcomeDialog` | `CamelCodeWelcomeDialog` |
| `src/lib/camel-free-welcome.ts` | `src/lib/camel-code-welcome.ts` |
| `getCamelFreeWelcomeStorageKey` | `getCamelCodeWelcomeStorageKey` |
| `shouldShowCamelFreeWelcome` | `shouldShowCamelCodeWelcome` |
| `recordCamelFreeWelcomeDismissal` | `recordCamelCodeWelcomeDismissal` |
| `shouldSwitchExhaustedThreadToCamelFree` | `shouldSwitchExhaustedThreadToCamelCode` |
| local `isCamelFreeMode` in `workers/main/src/chat-thread-do.ts` | `shouldDefaultToCamelCode` |
| private `isCamelFreeActive` in `workers/main/src/chat-thread-do.ts` | `isCamelCodeActive` |
| eval-local `CAMEL_FREE_MODEL` constants | `CAMEL_CODE_MODEL` |
| `tests/camel-free-welcome.test.ts` | `tests/camel-code-welcome.test.ts` |

Use `git mv` for the component, helper, and unit-test files so history remains
easy to follow. Update all imports and call sites in the same commit.

Do **not** mechanically rename generic free-access terms such as
`isCreditFreeHostedModel`, `CREDIT_FREE_HOSTED_MODELS`,
`fallbackThreadToFreeModel`, free-tier hooks, or the `camel_free` access-mode
value. Those names describe policy rather than the retired display name.

### Worker, test, and eval references found by the audit

The implementation must update imports, source-only identifiers, comments,
human-readable test titles, and fixture display names in these audited files.
Behavior assertions must continue to use `deepseek-v4-auto` and `camel_free`
where applicable.

- App/runtime source:
  - `src/components/Chat.tsx`
  - `src/components/model-picker.tsx`
  - `src/lib/billing.server.ts`
  - `src/lib/chat-credit-status.ts`
  - `src/lib/chat-do.server.ts`
  - `workers/main/src/chat-thread-do.ts`
  - `workers/main/src/chat-thread/pi-model-config.ts`
- App/unit tests:
  - `tests/app-loader-sales-prompt.test.ts`
  - `tests/billing-dialog-state.test.ts`
  - `tests/billing.test.ts`
  - `tests/camel-free-welcome.test.ts` (renamed as above)
  - `tests/chat-agent-state.test.ts`
  - `tests/chat-credit-status.test.ts`
  - `tests/chat-do-model-picker-state.test.ts`
  - `tests/chat-selected-model.test.ts`
  - `tests/model-catalog.test.ts`
  - `tests/model-picker-config.test.ts`
  - `tests/model-picker.test.tsx`
  - `tests/model-settings-action.test.ts`
  - `tests/onboarding-complete-sales-prompt.test.ts`
  - `tests/plan-picker-byok.test.tsx`
- Worker tests:
  - `workers/main/tests/chat-thread-billing-access.test.ts`
  - `workers/main/tests/chat-thread-pi-turn.test.ts`
  - `workers/main/tests/llm-provider-config.test.ts`
- Live eval source and manifest copy:
  - `workers/main/tests/evals/hosted-credit-camel-free-fallback-live.test.ts`
  - `workers/main/tests/evals/camel-free-oracle-live.test.ts`
  - `workers/main/tests/evals/camel-free-oracle-trivial-live.test.ts`
  - `workers/main/tests/evals/camel-free-oracle-fix-live.test.ts`
  - `workers/main/tests/evals/camel-free-oracle-project-start-live.test.ts`
  - `workers/main/tests/evals/manifest.json`

The existing eval filenames, manifest `id` values, and score ids such as
`thread_switched_to_camel_free` remain unchanged for report continuity. Update
only their displayed descriptions/labels and source constant names.

### Historical documents

The following are completed implementation plans and review artifacts, not
current user-facing or operational documentation:

- `docs/free-tier-onboarding-paywall-plan.md`
- `docs/free-tier-ui-polish-plan.md`
- `docs/free-tier-ui-polish-feedback.md`
- `docs/free-tier-ui-polish-feedback-r2.md`

Do not rewrite these historical records as part of the implementation. Their
old screenshots, quoted copy, identifiers, and review notes describe the state
at the time. This new plan is the authoritative record of the rename. The
current operational runbook `docs/staging-onboarding-billing-e2e.md` is not
historical and must be updated.

## Implementation Plan

### 1. Change both canonical display-label sources

In `src/lib/llm-provider-config.ts`:

1. Change the `deepseek-v4-auto` option label from `Camel Free` to
   `camelCode`.
2. Rename `CAMEL_FREE_LLM_MODEL` to `CAMEL_CODE_LLM_MODEL`.
3. Update `CREDIT_FREE_HOSTED_MODELS`, `PINNED_VISIBLE_LLM_MODELS`, and every
   import/call site to reference the renamed constant.
4. Do not change the option value, description, provider allowlists, or model
   normalization behavior.

In `src/lib/model-catalog.ts`:

1. Change only the `deepseek-v4-auto` entry’s `label` to `camelCode`.
2. Keep its `providerLogo: "camelai"`, `cost: "Free"`, ordering, ratings, and
   pricing key unchanged.

Add a regression assertion that both sources expose `camelCode` for
`deepseek-v4-auto`. This guards the current duplication from drifting again.

### 2. Update every live UX sentence

Apply the exact copy from the audit table to the welcome dialog, fallback
banner, unlock modal, upgrade dialog, and all four plan feature lists. Preserve
the existing component structure and styling; this task does not redesign any
surface.

Rename the welcome component/helper/test files and exports with `git mv`, then
update imports in `Chat.tsx` and both dev preview routes.

In the renamed `src/lib/camel-code-welcome.ts`, rename the exported functions
but return the existing `camel-free-welcome-dismissed:*` key. Add a short
compatibility comment beside the key explaining why the legacy string is
intentional and must not be changed without a migration.

### 3. Align source-only model terminology

Update model-specific identifiers and comments in the app and Worker without
altering logic:

- In `Chat.tsx`, use `CAMEL_CODE_LLM_MODEL`, the renamed welcome helpers and
  component, and `shouldSwitchExhaustedThreadToCamelCode`. Rewrite comments
  that currently call the model “Camel Free” to say `camelCode`.
- In `src/lib/chat-credit-status.ts`, rename only the branded switch helper;
  leave generic credit-free helpers unchanged.
- In `src/lib/billing.server.ts`, update the explanatory comment to say
  `camelCode` is always available. Keep the returned access mode
  `mode: "camel_free"`.
- In `src/lib/chat-do.server.ts`, switch imports to `CAMEL_CODE_LLM_MODEL`.
  Keep `isFreeMode` because it describes the billing mode.
- In `workers/main/src/chat-thread/pi-model-config.ts`, switch imports and
  references to `CAMEL_CODE_LLM_MODEL`; do not change any `CHIRIDION_*` model
  values.
- In `workers/main/src/chat-thread-do.ts`, use
  `CAMEL_CODE_LLM_MODEL`, rename `isCamelFreeActive` to `isCamelCodeActive`,
  rename local `isCamelFreeMode` to `shouldDefaultToCamelCode`, and update
  associated comments/tests. Keep `fallbackThreadToFreeModel` as the generic
  policy operation and keep all fallback reasons and notice payloads unchanged.

### 4. Update tests and strengthen copy coverage

Update test descriptions and human fixture names to `camelCode`, while keeping
machine assertions on `deepseek-v4-auto` and `camel_free`.

Required focused assertions:

1. `tests/model-catalog.test.ts`
   - Expect `MODEL_CATALOG["deepseek-v4-auto"].label` to be `camelCode`.
   - Verify the corresponding provider option label is also `camelCode`.
   - Update the hosted/pinned test description to the new name.
2. `tests/model-picker.test.tsx`
   - Select `camelCode`, assert the selected row/tooltip says `camelCode`, and
     retain the `Free` cost and “Free and always included” assertions.
3. `tests/model-fallback-banner.test.tsx`
   - Add explicit assertions for both banner variants: exhausted credits and
     unavailable subscription. Neither assertion should rely only on the
     catalog label because these sentences are hard-coded in the component.
4. Renamed `tests/camel-code-welcome.test.ts`
   - Use renamed helpers and describe the camelCode welcome behavior.
   - Assert the helper still writes and reads the exact legacy
     `camel-free-welcome-dismissed:user_123:org_123` key.
5. Add or extend a welcome-dialog render test to assert the title
   `You're on camelCode` and the existing two body references. The existing
   welcome-helper test does not render the component, so it cannot catch stale
   dialog copy.
6. `tests/plan-picker-byok.test.tsx`
   - Expect `Priority over free traffic on camelCode` for the rendered paid
     plans.
7. Worker tests
   - Update private-method access for `isCamelCodeActive`, renamed imports, test
     titles, and fixture display names. Preserve every routing, persistence,
     fallback-reason, and model-id assertion.
8. Evals
   - Rename eval-local constants and update `describe`/test strings, score
     labels, and manifest descriptions to `camelCode`.
   - Keep eval target ids, filenames, report ids, score ids, and the
     `deepseek-v4-auto` model value unchanged.

### 5. Update staging E2E coverage and runbook

In `e2e/staging-billing/staging-billing.spec.ts`:

- Change the scenario title to say it falls back to `camelCode`.
- Expect the initial picker, post-fallback picker, and post-reload picker to say
  `camelCode`.
- Replace the currently stale exact fallback assertion
  `Switched to Camel Free` with the component's complete credits-exhausted
  sentence: `Monthly credits used up — switched to camelCode.` The current
  exact assertion does not match the banner's full text even before the rename.
- Rename the checkpoint from `03-camel-free-fallback` to
  `03-camel-code-fallback`; this is a new report artifact name, not a persistent
  product identifier.
- Do not change fixture setup, credit mutation, fallback timing, prompts, or
  Stripe scenarios.

Update the matching prose in `docs/staging-onboarding-billing-e2e.md` so the
manual procedure and the automated assertions use the same current name.

## Verification

### Static audit

Run an exact user-facing copy search across active implementation surfaces:

```bash
rg -n "Camel Free|CamelCode|Camel Code|camel Free" src workers tests e2e
```

Expected result: no matches.

Then audit all old-name-shaped identifiers, including filenames:

```bash
rg -n -i "camel[ _-]?free" src workers tests e2e docs/staging-onboarding-billing-e2e.md
rg --files src workers tests e2e | rg -i "camel[-_]?free"
```

Review every remaining match. The only expected remnants are deliberately
stable compatibility identifiers:

- the `camel_free` billing access mode and tests that assert it;
- the literal `camel-free-welcome-dismissed:*` localStorage key and its
  compatibility test/comment;
- existing eval filenames, manifest ids, and score ids retained for reporting
  history.

No remaining match may be rendered product copy, a test title/description, a
fixture display name, a source constant/function/class name, or a live code
comment that treats “Camel Free” as the current product name.

Confirm the new spelling appears on every intended surface:

```bash
rg -n "camelCode" src workers tests e2e docs/staging-onboarding-billing-e2e.md
```

### Automated tests

Use Bun, per repository convention:

```bash
bun run typecheck
bun run lint

bun run test:run -- \
  tests/model-catalog.test.ts \
  tests/model-picker.test.tsx \
  tests/model-fallback-banner.test.tsx \
  tests/camel-code-welcome.test.ts \
  tests/billing-dialog-state.test.ts \
  tests/plan-picker-byok.test.tsx \
  tests/chat-credit-status.test.ts \
  tests/chat-selected-model.test.ts \
  tests/chat-do-model-picker-state.test.ts \
  tests/billing.test.ts \
  tests/app-loader-sales-prompt.test.ts \
  tests/onboarding-complete-sales-prompt.test.ts \
  tests/model-settings-action.test.ts \
  tests/chat-agent-state.test.ts

bun run test:workers -- \
  workers/main/tests/llm-provider-config.test.ts \
  workers/main/tests/chat-thread-billing-access.test.ts \
  workers/main/tests/chat-thread-pi-turn.test.ts
```

If the test runner does not accept multiple worker file paths after `--`, run
the three worker files separately. Live agent evals are not required for this
copy/source-symbol change; their inference behavior and model id do not change.

### Manual UI smoke test

Use the local dev previews first, then repeat the critical chat flow on staging:

1. Open `/dev/billing-paywall?state=free` and verify:
   - the preview description and button say `camelCode`;
   - the welcome title says `You're on camelCode`;
   - the body still describes the shared self-hosted model and priority access
     without duplicate or mixed naming;
   - the unlock and plan dialogs use `camelCode` while the plan remains named
     `Free`.
2. Open `/dev/chat-credit-states?state=fallback-credits` and
   `?state=fallback-subscription`; verify both fallback banner variants say
   `camelCode`.
3. In a fresh free hosted org, verify the thread model picker and model hover
   card say `camelCode`, with the camelAI logo and `Free` cost unchanged.
4. Dismiss the welcome, reload, and confirm it stays dismissed. Specifically
   verify the browser still stores the legacy `camel-free-welcome-dismissed:*`
   key rather than creating a second camelCode-named key.
5. Exhaust credits on a premium hosted thread. Verify the fallback banner and
   picker switch to `camelCode`, the fallback persists across reload, and the
   next agent turn completes.
6. Open organization model settings and verify the hosted model option says
   `camelCode` there as well as in chat.

## Rollout and Risk

No migration, backfill, feature flag, deploy ordering, pricing update, or
gateway change is needed. App and Worker code can deploy together through the
normal main-worker release path.

The main risks are:

- updating only one of the two label sources and leaving settings/picker copy
  inconsistent;
- accidentally changing `deepseek-v4-auto` and breaking stored threads or
  routing;
- changing `camel_free` and expanding a display rename into an access-state
  contract change;
- changing the localStorage key and re-showing the one-time modal to existing
  users;
- renaming eval ids and splitting historical report continuity;
- replacing legitimate pricing/access words such as `Free` and “free traffic.”

The compatibility assertions and static audit above are the guards for these
risks.

## Acceptance Criteria

- Every live human-readable model-name reference uses exact casing
  `camelCode`.
- The chat picker, model settings, welcome dialog, fallback banners, premium
  unlock modal, plan upgrade dialog, paid-plan feature lists, dev previews,
  staging E2E, and current staging runbook are updated.
- Model-specific source names use `CamelCode` / `CAMEL_CODE` naming, except for
  explicitly preserved machine identifiers.
- `deepseek-v4-auto`, `dynamic/deepseek-v4-auto`, routing, pricing, capabilities,
  provider visibility, pinned ordering, and fallback behavior are unchanged.
- `camel_free` remains the billing access mode.
- Existing welcome dismissals remain effective through the unchanged
  `camel-free-welcome-dismissed:*` key.
- Existing eval target/report/score ids remain valid while displayed eval copy
  uses `camelCode`.
- Historical plan/review artifacts remain unchanged.
- Typecheck, lint, focused app tests, and focused worker tests pass.
- Static audit finds no stale or incorrectly capitalized user-facing name in
  active code, tests, E2E, or the current staging runbook.
