# Automation Billing Enforcement Plan

**Date:** 2026-06-11
**Primary owner:** `workers/main/src/workspace-cron.ts`

This plan is for the coding agent implementing billing-tier enforcement for scheduled automations. Keep the change centered in `WorkspaceCronDO`; all creation, update, manual run, MCP, code-mode, and `/automations` UI paths already funnel through that Durable Object.

## Goal

Automations must honor the org's current billing tier at execution time, not only when the automation is created or edited.

The immediate production issue is legacy or downgraded free/pay-as-you-go users whose scheduled automations still fire more often than the current tier allows. Creation-time gating exists, but `alarm()` dispatches due work without re-checking current billing limits.

## Current Code Path Audit

### Billing limits source

`src/lib/billing-plans.ts` defines the current machine-enforced limits, which currently drift from the paywall for lower tiers:

| Plan | Current count limit | Paywall-authoritative count limit | Frequency limit |
|---|---:|---:|---:|
| `free` | `maxCronJobsPerWorkspace: 2` | `maxCronJobsPerWorkspace: 1` | daily |
| `payg` | `maxCronJobsPerWorkspace: 2` | `maxCronJobsPerWorkspace: 1` | daily |
| `starter` | `maxCronJobsPerWorkspace: 10` | `maxCronJobsPerWorkspace: 1` | hourly |
| `pro` | `maxCronJobsPerWorkspace: 50` | `maxCronJobsPerWorkspace: 50` | every 5 minutes |
| `team` | `maxCronJobsPerUser: 50` | `maxCronJobsPerUser: 50` | every 5 minutes |
| `enterprise` | unlimited | unlimited | unlimited |

The paywall copy in `src/components/billing/plan-picker-content.ts` says:

- Pay as you go: `1 automated task daily`
- Starter: `1 automated task hourly`
- Pro: `Automations every 5 minutes`
- Team: inherits Pro copy

There is an existing note about this mismatch in `docs/paywall-tier-copy-iteration-plan.md`. Product has now confirmed the paywall is authoritative. The implementation must update `BILLING_PLAN_LIMITS` so Free/PayG and Starter count limits match the paywall copy.

### Creation and update gating

`WorkspaceCronDO.assertCronWithinBillingLimits()` already checks:

- cron minimum interval via `getCronMinimumIntervalMs(cronExpression)`
- count limits across `scheduled_prompts` and `deterministic_automations`

It is called from:

- `createScheduledPrompt()`
- `createDeterministicAutomation()`
- `updateScheduledPrompt()`
- `updateDeterministicAutomation()`

Those methods are reached by:

- MCP tools in `workers/main/src/mcp-handler.ts`
- code-mode helpers in `workers/main/src/code-mode-scheduled-prompts.ts`
- code-mode helpers in `workers/main/src/code-mode-deterministic-automations.ts`
- the `/automations` page action via `src/lib/automations.server.ts` for enable/disable/rename

### Execution gap

`WorkspaceCronDO.alarm()` currently:

1. Loads the workspace.
2. Selects due enabled `scheduled_prompts`.
3. Calls `dispatchPrompt()` for every due row.
4. Computes the next raw cron time with `getNextCronRunAt()`.
5. Repeats the same pattern for `deterministic_automations`.

There is no billing re-check in the scheduled execution path.

`runScheduledPromptNow()` and `runDeterministicAutomationNow()` also do not check billing limits. This plan leaves manual runs allowed because they are user-triggered, not scheduled automation fires. They should still use billing-aware `next_run_at` recomputation so a manual run does not re-arm a legacy over-frequent cron for the next minute.

## Confirmed Product Direction

The paywall is authoritative for automation count limits. Update `free`/`payg` to 1 automation per workspace and `starter` to 1 automation per workspace, matching `1 automated task ...` copy.

## Implementation Decisions

1. **Manual "Run now" remains allowed for this pass.** Manual runs are user-triggered, not scheduled automation fires. They should still re-arm `next_run_at` using billing-aware cadence logic.
2. **Over-cap enabled automations use a deterministic allow-list.** Sort by `created_at ASC, id ASC` among enabled rows, across both automation tables. The earliest enabled automations within the cap continue firing; later enabled automations are blocked until the user upgrades, disables older automations, or deletes them.

## Implementation Plan

### 1. Align count constants to the paywall

In `src/lib/billing-plans.ts`, update the automation count constants to match the confirmed paywall source of truth:

- `free.maxCronJobsPerWorkspace: 1`
- `payg.maxCronJobsPerWorkspace: 1`
- `starter.maxCronJobsPerWorkspace: 1`

Leave `minCronIntervalMs` as-is: daily for free/payg, hourly for Starter, five minutes for Pro/Team.

### 2. Refactor limit checks into reusable helpers

Keep `assertCronWithinBillingLimits()` for create/update behavior, but extract shared pieces so execution can reuse them without throwing for every due row:

- `getWorkspaceBillingLimits(workspace: WorkspaceInfo)`:
  - calls `this.getOrgStub(workspace.org_id).getInfo()`
  - returns `getBillingPlanLimits(org?.billing_plan, org?.billing_status)`
- `getCronBillingIntervalViolation(cronExpression, limits)`:
  - returns `null` when compliant
  - returns a user-facing message when `getCronMinimumIntervalMs()` is below `limits.minCronIntervalMs`
- `getLatestScheduledAttemptAt(kind, id)`:
  - reads the newest `automation_runs.started_at` for this automation with `trigger = "schedule"`
  - include both successful dispatches and previous billing blocks; this is what prevents minute-by-minute wake-ups after the first block
- `getAutomationCountViolation(kind, id, createdBy, limits)`:
  - execution-time count checks should count enabled rows only
  - use both `scheduled_prompts` and `deterministic_automations`
  - for workspace caps, build one enabled list across the workspace
  - for user caps, build one enabled list for `created_by = ?` inside this workspace
  - sort by `created_at ASC, id ASC`
  - return `null` if the current automation is inside the allowed slice

Note: `team.maxCronJobsPerUser` is currently only enforceable inside this workspace DO. Do not try to build a cross-workspace org/user index in this fix.

### 3. Add billing-aware schedule recomputation

Create a helper that replaces raw `getNextCronRunAt()` in scheduled execution:

```ts
private getNextRunAtWithBillingInterval(
  cronExpression: string,
  fromMs: number,
  minIntervalMs: number | null,
): number | null
```

Behavior:

- If there is no `minIntervalMs`, return `getNextCronRunAt(cronExpression, fromMs)`.
- If the cron's minimum interval is compliant, return the raw next cron time.
- If the cron is too frequent for the current plan, return the next cron occurrence at or after `fromMs + minIntervalMs`.

This prevents legacy `* * * * *` automations from waking the DO every minute just to be blocked. After one scheduled attempt or billing block, the next check should be no sooner than the plan minimum.

Also add a small runtime decision helper for interval throttling:

```ts
private getCronIntervalRuntimeBlock(
  kind: AutomationRunKind,
  automationId: string,
  cronExpression: string,
  now: number,
  minIntervalMs: number | null,
): { message: string; nextRunAt: number | null } | null
```

Behavior:

- If the cron expression is compliant, return `null`.
- If the cron expression is too frequent but there is no recent scheduled attempt inside the current plan interval, return `null`; the legacy automation may fire once, then its next run is rearmed with `getNextRunAtWithBillingInterval()`.
- If the latest scheduled attempt is inside the current plan interval, return a billing message plus a billing-aware `nextRunAt`.

### 4. Gate scheduled prompt dispatch in `alarm()`

Before `dispatchPrompt()` in the due scheduled prompt loop:

1. Evaluate current billing limits.
2. Check the cron frequency runtime block.
3. Check the enabled automation count violation.
4. If either check fails:
   - do not call `dispatchPrompt()`
   - insert a bounded run-history row with `trigger: "schedule"`, `status: "error"`, and a message like `Blocked by billing plan: your current plan allows ...`
   - update the prompt's `last_run_status` and `last_run_error` so the Automations page shows the problem
   - set `next_run_at` with `getNextRunAtWithBillingInterval(prompt.cron_expression, Date.now(), limits.minCronIntervalMs)`
   - keep `enabled = 1`
   - do not create a chat thread or send a scheduled prompt message

When dispatch is allowed, keep the existing behavior but compute the next run with the billing-aware helper instead of raw `getNextCronRunAt()`.

Important: a too-frequent legacy cron expression is not automatically blocked forever. It is throttled. Example: after downgrade to PayG, an old `* * * * *` automation may run once, then its next scheduled attempt should be about one day later.

### 5. Gate deterministic workflow dispatch in `alarm()`

Apply the same enforcement before creating a workflow instance:

1. Check billing frequency and count.
2. If blocked:
   - do not call `workflow.create()`
   - insert an `automation_runs` row with `kind: "deterministic_automation"`, `trigger: "schedule"`, `status: "error"`, and the billing message
   - update `last_run_status`, `last_run_error`, and billing-aware `next_run_at`
   - keep `enabled = 1`
   - leave `last_instance_id = NULL`
3. If allowed, keep existing dispatch behavior, but compute next run with `getNextRunAtWithBillingInterval()`.

### 6. Avoid duplicate org reads per alarm

`alarm()` should fetch billing limits once after `getWorkspaceInfo()`, then pass those limits into both due loops. Do not call `OrgDO.getInfo()` separately for every due automation.

Create/update paths can continue fetching limits inside `assertCronWithinBillingLimits()`.

### 7. Keep manual runs user-triggered

Do not block `runScheduledPromptNow()` or `runDeterministicAutomationNow()` for frequency/count limits in this pass.

Do update their `next_run_at` recomputation:

- when an enabled automation has a missing/stale `next_run_at`, use `getNextRunAtWithBillingInterval()` with current billing limits
- this prevents "Run now" from rearming a legacy every-minute schedule for one minute later

### 8. Error copy

Reuse `formatInterval()` for interval messages. Prefer "automation" in user-facing messages, not "cron job", because the paywall and Automations page use that term.

Examples:

- `Blocked by billing plan: your current plan allows automations no more frequent than every 1 day.`
- `Blocked by billing plan: your current plan allows 1 automation per workspace.`
- `Blocked by billing plan: your current plan allows 50 automations per user.`

Do not include prompt text, workflow source, request bodies, secrets, or auth headers in logs/errors.

## Tests

Add focused coverage to `workers/main/tests/workspace-cron.test.ts`.

Important fixture note: `createOrg()` in `workers/main/tests/test-helpers.ts` defaults to `enterprise`, so tests must explicitly create or downgrade lower-tier orgs.

### Required tests

1. **Creation still rejects over-frequent schedules**
   - create a `payg` org
   - `createScheduledPrompt({ cronExpression: "* * * * *" })` rejects with the billing interval message
   - repeat for `createDeterministicAutomation()`

2. **Legacy over-frequent scheduled prompt is blocked/throttled after a recent run**
   - create org as `enterprise`
   - create enabled scheduled prompt with `* * * * *`
   - make it due and call `cronStub.alarm()` once while still `enterprise` so a scheduled attempt is recorded
   - downgrade org to `payg` with `orgStub.updateBillingState({ billing_plan: "payg", billing_status: "inactive" })`
   - advance/fix time to the next raw minute and call `cronStub.alarm()`
   - assert no second scheduled prompt dispatch started
   - assert latest run history has `trigger: "schedule"`, `status: "error"`, and billing copy
   - assert `next_run_at` is roughly one day later, not one minute later

3. **Legacy over-frequent deterministic workflow is blocked/throttled after downgrade**
   - same shape as test 2
   - assert no second workflow instance starts
   - assert `last_instance_id` does not change to a new instance id
   - assert `next_run_at` is roughly one day later

4. **Allowed legacy run is rearmed with billing-aware cadence**
   - create as `enterprise`
   - create `* * * * *`
   - downgrade to `payg`
   - make it due and call `alarm()`
   - if the implementation allows the first post-downgrade due run, assert the next run is daily; if it blocks immediately because a recent scheduled attempt exists, assert the block is daily-throttled
   - the key invariant is no next run one minute later

5. **Over count cap blocks deterministic overflow**
   - create two enabled daily automations while `enterprise`
   - downgrade to `payg`
   - make both due
   - assert only the earliest enabled automation is allowed and the later one records a billing error

6. **Manual run does not bypass scheduled rearm**
   - create legacy `* * * * *` while `enterprise`
   - downgrade to `payg`
   - call `runScheduledPromptNow()`
   - assert the manual dispatch still returns, but `next_run_at` is not one minute later

Use fake timers where practical (`vi.useFakeTimers()` / `vi.setSystemTime()`), and restore timers after each test that changes time.

## Verification Commands

Run the focused worker tests first:

```bash
bun run test:workers -- workers/main/tests/workspace-cron.test.ts
```

If `getNextRunAtWithBillingInterval()` is placed in `cron-schedule.ts` instead of staying private to `WorkspaceCronDO`, also run:

```bash
bun run test:run -- tests/cron-schedule.test.ts
```

Finish with typechecking:

```bash
bun run typecheck
```

## Out Of Scope

- Cross-workspace enforcement for `team.maxCronJobsPerUser`.
- A billing-status change hook that immediately sweeps all workspace cron DOs.
- Blocking manual `Run now`.
- UI redesign for paywall-blocked automations. The existing failed status dot can surface the billing error.
- Renaming internal `maxCronJobs*` fields to `maxAutomations*`.
