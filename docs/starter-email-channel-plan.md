# Starter Email Channel Plan

## Problem

The native workspace email channel is currently treated as a Pro+ feature. The user wants the email inbox/channel included in the Starter plan. This is not only paywall copy: backend email ingress and outbound sending have real billing gates, and the Connections UI derives its disabled state from the same billing limits.

The implementation should make Starter orgs able to use the native workspace email address exactly like Pro orgs can today, while keeping Pay as you go / Free blocked.

## Goal

Move the native workspace email inbox/channel from Pro to Starter:

- Starter, Pro, Team, and Enterprise can receive email at the workspace address.
- Starter, Pro, Team, and Enterprise can send email through the workspace email channel/tooling where currently allowed.
- Pay as you go / Free remains blocked.
- Paywall plan cards show `Workspace email inbox` on Starter, not as a Pro-only bullet.
- Connections UI no longer renders the native Email channel as disabled for Starter orgs.
- Tests document the new plan matrix and guard against drift.

## Source Of Truth

Use `BillingPlanLimits.emailInbox` in [src/lib/billing-plans.ts](src/lib/billing-plans.ts) as the feature flag. Do not introduce a parallel `starterHasEmail` helper or copy/paste a plan allowlist unless a caller truly cannot use `getBillingPlanLimits`.

Current state:

- `starter.emailInbox` is `false`.
- `pro.emailInbox`, `team.emailInbox`, and `enterprise.emailInbox` are `true`.
- `payg.emailInbox` and `free.emailInbox` are `false`.

Target state:

- `starter.emailInbox` becomes `true`.
- `free` and `payg` stay `false`.
- `pro`, `team`, `enterprise` stay `true`.

## Implementation Steps

1. Update the backend feature flag in [src/lib/billing-plans.ts](src/lib/billing-plans.ts).

Change only the Starter plan's `emailInbox` field from `false` to `true`. This should automatically affect the Connections loader because [src/routes/_app.connections.tsx](src/routes/_app.connections.tsx) already computes `emailInboxEnabled` with `getBillingPlanLimits(...).emailInbox`.

2. Update stale backend error messages.

Search for the old wording:

```bash
rg -n "Pro, Team, or Enterprise|requires a Pro|Workspace email inbox requires" workers src tests
```

Known call sites:

- [workers/main/src/email-ingress.ts](workers/main/src/email-ingress.ts): inbound email rejection currently says `Workspace email inbox requires a Pro, Team, or Enterprise plan.`
- [workers/main/src/routes/email-send-proxy.ts](workers/main/src/routes/email-send-proxy.ts): sandbox email send proxy currently returns `Workspace email inbox requires a Pro, Team, or Enterprise plan`.

Replace these with Starter-inclusive copy. Suggested wording:

```text
Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan.
```

Keep the behavior plan-driven through `getBillingPlanLimits(...).emailInbox`; do not hard-code the allowlist into control flow.

3. Verify direct email send paths.

Important downstream impact: [workers/main/src/chat-thread-do.ts](workers/main/src/chat-thread-do.ts) has a direct `sendChannelEmailTool` path that sends through `env.EMAIL`. Code-mode `tools.send_email` reaches this method through `CodeModeToolsBinding.sendEmail`, and email-channel replies use the same method. The inbound path is already gated, but a user could have an existing email-originated thread or invoke `send_email` manually.

Implementation agent should inspect whether this method needs an explicit billing check for consistency. Preferred outcome:

- If current product intent is "email sending is part of the email channel", add a small plan check near the top of `sendChannelEmailTool` using `getBillingPlanLimits` and `context.orgId`. PayG/Free should throw the same Starter-inclusive message; Starter should pass.
- If the team intentionally allows outbound email independently from inbox access, leave it ungated but add or update a test/comment documenting that decision.

Do not add a separate check that accidentally blocks Starter after changing `BILLING_PLAN_LIMITS`.

4. Update plan-card/paywall copy.

Edit [src/components/billing/plan-picker-content.ts](src/components/billing/plan-picker-content.ts).

Target copy:

- Add `"Workspace email inbox"` to `PLAN_CONTENT.starter.features`.
- Remove `"Workspace email inbox"` from `PLAN_CONTENT.pro.features`.
- Keep `pro.upsellPrefix` as `Everything in Starter, plus:`. With the Starter bullet moved, Pro still inherits email through that prefix.
- Keep `team.upsellPrefix` as `Everything in Pro for every seat, plus:` unless product wants wording changed separately. Because Pro inherits Starter, Team still includes email.

Do not change pricing, CTAs, highlighted plans, Stripe behavior, or the rendered plan arrays.

5. Review Connections disabled copy.

The Connections UI already disables native Email when `email.inboxEnabled` is false:

- [src/components/pages/connections/connection-panel.tsx](src/components/pages/connections/connection-panel.tsx)
- [src/components/pages/connections/connection-row.tsx](src/components/pages/connections/connection-row.tsx)

No functional UI change should be necessary if `emailInboxEnabled` comes from `BILLING_PLAN_LIMITS`. However, manually confirm:

- Starter org: Email channel row has no `Disabled` badge, panel has no upgrade note.
- PayG/Free org: Email channel row still shows `Disabled`, panel still shows the upgrade note.

Optional copy polish: change generic upgrade notes from "Upgrade your plan" to "Upgrade to Starter or higher" only if the current copy feels too vague. Do not make this a required UI redesign.

6. Check docs and old implementation plans only for active source-of-truth references.

There are old docs under `docs/` that describe the prior paywall copy, especially [docs/paywall-tier-copy-iteration-plan.md](docs/paywall-tier-copy-iteration-plan.md). Those are historical plans and do not need to be rewritten unless they are actively used as product docs.

If this repo contains current public docs or user-facing pricing text outside `PLAN_CONTENT`, update those too. Search:

```bash
rg -n "Workspace email inbox|Email inbox|workspace inbox|emailInbox|email channel" src workers docs README.md
```

Do not churn historical plan files just to make old design documents match new product behavior.

## Tests To Update Or Add

1. Billing matrix tests.

Known file: [tests/billing.test.ts](tests/billing.test.ts)

Update the plan matrix assertion so `BILLING_PLAN_LIMITS.starter.emailInbox` is `true`. Keep `free` / `payg` false and Pro/Team true.

Also consider adding a smaller focused assertion in [tests/billing-plans.test.ts](tests/billing-plans.test.ts):

```ts
expect(BILLING_PLAN_LIMITS.payg.emailInbox).toBe(false);
expect(BILLING_PLAN_LIMITS.starter.emailInbox).toBe(true);
expect(BILLING_PLAN_LIMITS.pro.emailInbox).toBe(true);
```

2. Connections loader tests.

Known file: [tests/connections-action.test.ts](tests/connections-action.test.ts)

Current tests cover Pro enabled and Free disabled. Add or modify coverage so Starter is explicitly enabled:

- Default mocked org can use `billing_plan: "starter", billing_status: "active"` and expect `emailInboxEnabled === true`.
- Keep a separate PayG/Free disabled case expecting `false`.

3. Inbound email tests.

Known files:

- [workers/main/tests/email-ingress.test.ts](workers/main/tests/email-ingress.test.ts)
- [workers/main/tests/email-ingress-markdown.test.ts](workers/main/tests/email-ingress-markdown.test.ts)

Most happy-path fixtures currently use `billing_plan: "pro"`. Change at least one representative happy-path inbound email test to `starter` to prove Starter can receive email. Keep any tests unrelated to plan gating on Pro if changing them adds noise.

If no test currently proves disabled plans reject inbound email, add one:

- Mock org `billing_plan: "payg"` or `"free"`.
- Send to a known workspace email handle.
- Expect `message.setReject` to be called with the Starter-inclusive billing message.
- Expect no thread to be started.

4. Outbound email proxy tests.

Known file: [workers/main/tests/email-send-proxy.test.ts](workers/main/tests/email-send-proxy.test.ts)

Default fixture currently returns `billing_plan: "pro"`. Change a representative successful send test or the default fixture to Starter and ensure success still returns `200`.

Add or keep a disabled-plan test:

- Mock org as PayG/Free.
- Expect `403`.
- Expect the Starter-inclusive billing message.

5. Direct `sendChannelEmailTool` tests, if a plan check is added.

Known file: [workers/main/tests/chat-thread-codex-external-turn.test.ts](workers/main/tests/chat-thread-codex-external-turn.test.ts)

Existing tests call `sendChannelEmailTool` directly. If adding a billing check there, update the fake `env.ORG` stubs so successful tests return Starter or Pro with active status. Add a focused PayG/Free rejection test if the check is added.

6. Paywall copy tests.

There may not be direct plan-card copy tests today. If there is an existing billing UI snapshot/test after searching, update it. Otherwise, add a light test only if the project already has a nearby pattern. The minimum acceptable verification is a code review of `PLAN_CONTENT` plus manual UI check.

## Manual QA

Run the smallest checks that cover both backend and UI:

```bash
bun run test:run tests/billing.test.ts tests/billing-plans.test.ts tests/connections-action.test.ts
bun run test:workers -- workers/main/tests/email-ingress.test.ts workers/main/tests/email-send-proxy.test.ts
bun run typecheck
```

If `sendChannelEmailTool` is changed, also run:

```bash
bun run test:workers -- workers/main/tests/chat-thread-codex-external-turn.test.ts
```

Manual app checks:

- Starter org on `/connections`: native Email channel is enabled and shows the workspace email address.
- PayG/Free org on `/connections`: native Email channel is disabled with upgrade messaging.
- Billing/paywall plan grid: Starter card includes `Workspace email inbox`; Pro card does not list it as a separate delta.
- Send an inbound email to a Starter workspace address in a local/staging route if available; it should start a thread.
- Try the same for PayG/Free; it should reject with the updated billing message.

## Edge Cases And Downstream Impacts

- Workspace email handles are generated independently of plan. Do not remove handle generation for PayG/Free; disabled plans can still see the address, but backend must reject use until upgraded.
- Existing Pro users are unaffected; they retain email through `pro.emailInbox: true`.
- Team and Enterprise inherit email through current limits and plan copy. Keep them enabled.
- Legacy `free` normalizes to `payg` in `normalizeBillingPlan`. Make sure tests account for both when checking disabled behavior.
- If there are public pricing docs outside this repo, they must be updated in the same release even though this code change cannot modify them.
- Any analytics or observability dashboards that segment email usage by plan may start seeing Starter traffic. No schema changes should be needed, but release notes should mention the expected shift.

## Non-Goals

- Do not change Stripe prices, subscription migration behavior, credits, seat limits, deployed app limits, custom domain limits, storage, or automation frequency.
- Do not redesign the Connections page.
- Do not change workspace email handle generation or routing domains.
- Do not broaden email access to PayG/Free.
- Do not edit historical plan/feedback docs unless they are used as current product documentation.

## Suggested Implementation Order

1. Change `starter.emailInbox` to `true`.
2. Update Starter-inclusive billing error strings.
3. Move the `Workspace email inbox` paywall bullet from Pro to Starter.
4. Update tests around billing limits and Connections loader.
5. Update inbound/outbound email tests, using Starter as at least one happy-path plan.
6. Decide and test whether `sendChannelEmailTool` needs a mirrored plan gate.
7. Run focused tests and `bun run typecheck`.
