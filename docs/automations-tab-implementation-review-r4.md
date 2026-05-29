# Automations Tab Implementation Review R4

**Date:** 2026-05-28
**Scope:** review of the accidental UI-agent implementation after R3. This is intended as a handoff document for the next coding pass.

## Recommendation

Do **not** revert the entire implementation. The current direction is technically reasonable:

- Run history has moved out of the main automations loader.
- The panel fetches run history for only the selected automation.
- The new `/api/automations/:id/runs` route is workspace-access gated.
- The Durable Object uses keyset pagination for the selected automation.

However, do **not** merge it as-is. Patch the findings below first.

## Verification

These commands passed against the current diff:

```bash
bun run typecheck
bun run test:workers -- workspace-cron.test.ts
```

Passing tests are not enough here because the key issues are lifecycle/UI-state bugs that are not covered by the current worker tests.

## Findings

### P1: Previous runs panel flickers badly

The "Previous runs" section is flickering in the UI. The likely cause is the first-page run-history effect in `src/components/pages/automations/automations-client.tsx`.

Current shape:

```ts
useEffect(() => {
  if (!selectedRunsKey) {
    setRunState(null);
    setRunsLoading(null);
    return;
  }
  const { kind, id } = parseAutomationKey(selectedRunsKey);
  setRunState({ key: selectedRunsKey, runs: [], cursor: null });
  setRunsLoading("page");
  runsFetcher.load(buildRunsUrl(id, kind, null));
}, [selectedRunsKey, runsFetcher]);
```

`runsFetcher` should not be a dependency for this effect. `useFetcher()` state changes as it moves through idle/loading/data states, and depending on the whole fetcher object can re-run this effect during the request lifecycle. Each rerun clears `runState`, sets `runsLoading` back to `"page"`, and reloads the first page. That produces skeleton/list flicker and can cause repeated network requests.

Patch:

- Trigger the first-page load only when `selectedRunsKey` changes.
- Do not clear and reload run history just because the fetcher state changes.
- Use a stable load callback/ref if needed, but keep the effect dependency tied to the selected automation key, not the entire fetcher object.
- In browser verification, selecting an automation should issue one first-page runs request. Clicking "Show older runs" should issue one additional request. Polling or ordinary rerenders should not reset the section to skeleton.

Suggested implementation shape:

```ts
useEffect(() => {
  if (!selectedRunsKey) {
    setRunState(null);
    setRunsLoading(null);
    return;
  }

  const { kind, id } = parseAutomationKey(selectedRunsKey);
  setRunState({ key: selectedRunsKey, runs: [], cursor: null });
  setRunsLoading("page");
  runsFetcher.load(buildRunsUrl(id, kind, null));
  // Intentionally keyed only by selectedRunsKey. Do not add the fetcher object.
}, [selectedRunsKey]);
```

If lint objects, wrap the load call in a stable helper or use a small local exception with a comment explaining why the dependency is intentionally not the whole fetcher object.

### P1: Pending-question runs can be overwritten as successful

`ChatThreadDO.askUserQuestion()` records the active scheduled automation run as `question`, but `setChatIsStreaming(false, { markUnread: true })` later records the same active run as `success` and clears it.

Relevant files:

- `workers/main/src/chat-thread-do.ts`
- `workers/main/src/workspace-cron.ts`
- `src/lib/automations.server.ts`

This can break the intended "needs input" state. A scheduled task that asks the user a question should remain amber/needs-input until the question is answered or otherwise resolved. It should not be immediately converted to success just because the agent turn stopped after asking.

There is a related loader issue: `buildAutomationsPageData()` currently fetches `ChatThreadDO.getRuntimeStatus()` only for prompts whose thread appears in `WorkspaceDO.listStreamingThreadStatuses()`. Once the turn stops, a pending question can exist even though the thread is no longer streaming, so the automations page may miss pending-question state.

Patch:

- In `setChatIsStreaming(false, ...)`, before recording active automation success, check whether `browserPrompts.pendingQuestionCount > 0`.
- If pending questions exist, preserve `question` status and do not clear `activeAutomationRun`.
- Include prompts with `last_run_status === "question"` when deciding which thread IDs need `getRuntimeStatus()`, not just currently streaming thread IDs.
- Add a focused test or integration-style worker test for: scheduled prompt starts, agent asks a question, automations data reports `needs_input`/`question` and does not flip to `success` on turn stop.

### P2: Revert run-history retention to the previous cap

The accidental implementation changed run retention to `AUTOMATION_RUN_RETENTION = 1000` in `workers/main/src/workspace-cron.ts`.

Product direction for this pass: revert to the previous behavior. If the previous cap was 20, use 20 for now.

Patch:

- Set retention back to the previous cap, likely 20.
- Keep the new paginated endpoint if desired, but with retention at 20 it will only page through retained history.
- Update comments so this is described as current retention, not as a product promise that users can page through thousands of saved runs.

Important: this means older runs beyond the cap are intentionally deleted for now. That is acceptable for this round based on product feedback.

### P2: Run history does not refresh after "Run now"

The automations list/status poll updates the status dot and "Last ran", but the selected panel's run-history list is only loaded on selection changes and "Show older runs". If the user clicks "Run now" while the panel is open, the new run may not appear in "Previous runs" until they reselect or reopen the panel.

Patch options:

- After a successful run action for the selected automation, reload the first run-history page.
- Or append/prepend the returned run row if the backend action returns it.

The first option is simpler and safer. If reloading, avoid the flicker bug above: keep existing rows visible while refreshing, or use a small inline refresh state instead of resetting to the first-page skeleton.

### P2: Lifecycle coverage is still thin

`workspace-cron.test.ts` now covers manual result recording and keyset pagination, but it does not prove the real scheduled task lifecycle works across:

`WorkspaceCronDO -> ChatThreadDO.startInitialUserMessage() -> ChatThreadDO completion/question/error -> WorkspaceCronDO.recordScheduledPromptRunResult()`

Patch:

- Add at least one focused test for scheduled prompt lifecycle recording.
- Minimum useful case: accepted scheduled prompt inserts a `started` row, then ChatThreadDO records terminal success/error/question through the real active automation run path.
- Add a regression assertion for the question case from P1.

### P3: Tighten pagination/retention ordering

`listAutomationRunsPage()` orders by `(started_at DESC, id DESC)`, which is good. `trimAutomationRuns()` currently orders only by `started_at DESC`.

Patch:

- If keeping `trimAutomationRuns()`, order by `started_at DESC, id DESC` so retention is deterministic when multiple runs share the same timestamp.
- Consider changing the index to include `id` as the tie-breaker:

```sql
CREATE INDEX IF NOT EXISTS idx_automation_runs_lookup
ON automation_runs(kind, automation_id, started_at DESC, id DESC)
```

This is not the highest-risk issue, but it is cheap to fix while touching this area.

## Acceptance Checklist For Next Pass

- Opening an automation panel loads one first page of previous runs.
- The previous-runs section does not flicker between skeleton/list/empty while staying on the same automation.
- "Show older runs" loads one additional page and appends without duplicates.
- Clicking "Run now" does not show a success toast if dispatch failed or returned busy.
- A scheduled task that asks a question remains `needs_input`/`question` after the turn stops.
- A scheduled task that completes normally records `success`.
- Retention is back to the previous cap, likely 20.
- `bun run typecheck` passes.
- `bun run test:workers -- workspace-cron.test.ts` passes.
