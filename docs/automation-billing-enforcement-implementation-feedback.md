# Automation Billing Enforcement Implementation Feedback

**Date:** 2026-06-11
**Reviewed diff:** local changes to `src/lib/billing-plans.ts`, `workers/main/src/workspace-cron.ts`, and `workers/main/tests/workspace-cron.test.ts`

## Summary

Do not open the PR yet. The implementation correctly updates the paywall-backed count constants, and the focused cron worker tests pass, but the runtime behavior still follows the earlier throttling plan rather than the updated Product direction.

Product clarification: if an existing automation is now over the user's tier, it should fail without firing chat/workflow work, and then stop retrying. We should not silently change an hourly/minutely schedule into a daily schedule on the user's behalf. Disable as many noncompliant scheduled automations as needed.

## Findings

### 1. Over-frequency legacy automations can still run once after downgrade

Current code allows a too-frequent legacy automation to run when there is no recent scheduled attempt inside the current plan interval:

- `workers/main/src/workspace-cron.ts:947-980` returns `null` from `getCronIntervalRuntimeBlock()` in that case.
- `workers/main/src/workspace-cron.ts:2228-2264` then dispatches the scheduled prompt to chat.
- `workers/main/src/workspace-cron.ts:2360-2391` then starts deterministic workflow instances.
- `workers/main/tests/workspace-cron.test.ts:566-598` explicitly codifies this as expected behavior.

This conflicts with the clarified requirement. After downgrade, an hourly/minutely automation on Free/PayG should fail and stop, not run once and become daily.

Recommended fix:

- Remove the "first post-downgrade run is allowed" path.
- For scheduled execution, treat any current interval violation as a hard scheduled-run block.
- Insert a billing error run-history row, update `last_run_status = "error"` / `last_run_error`, set `enabled = 0`, and set `next_run_at = NULL`.
- Do not call `dispatchPrompt()` or `dispatchDeterministicAutomation()`.

### 2. Blocked automations remain enabled and will keep retrying later

On billing violation, the implementation keeps automations enabled and computes a future `next_run_at`:

- scheduled prompts: `workers/main/src/workspace-cron.ts:2194-2224` sets `enabled = 1` and a billing-adjusted `next_run_at`.
- deterministic workflows: `workers/main/src/workspace-cron.ts:2307-2329` sets `enabled = 1` and a billing-adjusted `next_run_at`.

For over-count automations with daily cron expressions, this means the blocked automation can fail again every day. For over-frequency automations, it effectively rewrites cadence to the billing minimum, which Product explicitly said is out of scope and undesirable.

Recommended fix:

- On any scheduled billing block, set `enabled = 0` and `next_run_at = NULL`.
- Keep the failure visible via `last_run_status`, `last_run_error`, and run history.
- Add tests that call `alarm()` a second time after the block and assert no additional run-history row is inserted.

### 3. Manual runs should not re-arm a noncompliant schedule with a new cadence

Manual runs currently recompute stale `next_run_at` using `getNextRunAtWithBillingInterval()`:

- scheduled prompts: `workers/main/src/workspace-cron.ts:1868-1904`
- deterministic workflows: `workers/main/src/workspace-cron.ts:1933-1943`

That means a user-triggered run can turn an existing every-minute automation into a daily scheduled automation after downgrade. Product's clarification says we should not change frequency on the user's behalf.

Recommended fix:

- Manual "Run now" can remain allowed if desired, but after the manual run, if the saved cron expression violates current billing limits or the automation is over count cap, disable the scheduled automation instead of setting a billing-adjusted `next_run_at`.
- Add tests covering manual run on a legacy over-frequency scheduled prompt and deterministic workflow: manual dispatch may occur, but the saved schedule should end with `enabled = false` and `next_run_at = null`.

### 4. Test suite still has stale billing limit expectations

The shared billing test still expects the old Free and Starter automation counts:

- `tests/billing.test.ts:189-220`

I ran:

```bash
bun run test:run -- tests/billing.test.ts
```

It fails because the implementation changed `free.maxCronJobsPerWorkspace` from `2` to `1` but did not update the test. Starter will also need to change from `10` to `1` in that matrix.

Recommended fix:

- Update `tests/billing.test.ts` to match the confirmed paywall source of truth.
- Add `tests/billing.test.ts` to the verification commands for this PR.

## Testing Feedback

The new `workspace-cron.test.ts` coverage is useful but currently tests the wrong behavior in several places:

- Replace `allows the first post-downgrade legacy run but rearms it with billing cadence` with a test that asserts the first post-downgrade due run is blocked, no chat message/workflow instance starts, and the automation is disabled.
- Update the existing "blocks and throttles" tests to assert `enabled === false` and `next_run_at === null`, not "roughly one day later."
- For over-count overflow, assert the overflow automation is disabled and a second alarm does not create another billing error row.
- Add a creation count-limit test: on PayG/Free and Starter, creating a second enabled daily automation should reject with `allows 1 automation per workspace`.
- Keep a direct assertion that no scheduled chat message fires: for scheduled prompts, the billing-blocked run-history row should have `thread_id === null`; for workflows, `instance_id === null`.

## Verification Status

Ran:

```bash
bun run test:workers -- workers/main/tests/workspace-cron.test.ts
```

Result: passed, but the tests currently assert throttling/re-cadencing behavior that should be changed.

Ran:

```bash
bun run test:run -- tests/billing.test.ts
```

Result: failed due to stale expected automation counts.
