# Eval Suite Improvements — Implementation Plan

**Date:** 2026-07-09
**Scope:** `workers/main/tests/evals/*`, `workers/main/tests/evals/manifest.json`, `scripts/run-agent-eval.mjs`, `scripts/run-eval-suite.sh`, `scripts/report-eval-run.mjs`, `workers/eval-reports/*`
**Four workstreams:**
1. Kill the evals that are dead after the bash/legacy-VM removal.
2. Fix the buggy evals (prompt contradictions, false-pass/false-fail criteria, misclassified pass/fail vs scorecard).
3. Add three new hard skill evals.
4. Make eval results faster to scan (manifest `tier`, criteria conventions, eval-reports viewer UI).

Do the phases in order (§8). Phases 0–2 are independent of phases 3–4 and can ship separately.

---

## 1. Platform context (why evals are dead)

The platform retired the per-project VM (`plans/no-vm-build-deploy-architecture.md`): **agent bash is gone by design**, not temporarily. Facts that drive every decision below:

- `bash` / `vm_exec` are "legacy project VM only" tools; DO-backed projects reject them via `assertVmProjectAllowed` (`workers/main/src/code-mode-tools.ts:1732-1744`). The agent's `create_project` tool always creates `backend: "do-r2"` projects (`code-mode-tools.ts:1727`).
- **Trap:** the raw `workspaceFs.createProject(...)` RPC that eval harnesses use to seed fixtures defaults to `backend: "vm"` when no backend is passed (`workers/main/src/workspace-filesystem-do.ts:777`). Any eval that seeds a project without `backend: "do-r2"` is silently testing the retired runtime.
- Build/deploy are platform actions: `build_project`, `deploy_project`, `add_dependency`, `list_commits`, `revert_project` are **js_exec-only** (called as `await tools.deploy_project(...)` inside `js_exec`); `create_project` is top-level.
- The bundled `developing-software/SKILL.md` now forbids `create-worker`, `wrangler init`, `bun run deploy`, and package-manager deploy scripts for DO-backed projects.
- The Miniflare eval env has **no BROWSER binding** — `env.BROWSER.launch` and `take_screenshot` always fail there (documented in `workers/main/tests/evals/eval-signal.ts:79-84`); the harness must verify deployed apps itself by fetching the public URL.
- DO-backed project files are read in tests via `new ProjectFilesystemClient(testEnv, project.id)` (`workspace-filesystem-do.ts:1142`): `.readFile/.writeFile/.exists/.listFiles/.createSourceSnapshot/...`. Do not use the legacy `PROJECT_RUNTIME_HOST /v1/projects/:id/fs/read` HTTP path for DO-backed fixtures.

### Eval design contract (apply to every edit in this plan)

- **Pass/fail criteria are the hard contract**: binary, evidence-backed, tied to persisted or user-visible behavior (file exists with required content, live endpoint returns correct JSON, record persisted in the owning DO). Any failure fails the run.
- **Scorecard criteria are graded quality signals**: efficiency, discovery path, verification habits, response quality. They must never fail a run, and they must be **orthogonal to the hard gates** — a scorecard criterion that is 5/5 exactly when the run passes and 0/5 exactly when a hard gate already failed carries zero information. Several such duplicates are removed below.
- **Final-response wording checks are scorecard**, with one exception: when the prompt demands a specific machine-checkable token ("reply with exactly the file contents", "reply with the restored marker"), the token check may be a hard gate.
- **Transcript-substring checks are banned as hard gates.** Evidence must come from runtime tool items (`usedTool` / `collectRuntimeEvidence` in `project-eval-helpers.ts`, which inspect tool calls and `js_exec` code, not reasoning text), from persisted state, or from live fetches. `JSON.stringify(result.events).includes("...")` false-passes because the events blob contains the agent's reasoning, which echoes the prompt.
- **Hard evals grade outcomes hard and paths soft**: prompts state product requirements, not tool call sequences; "used the intended tool/path" checks live in the scorecard.

---

## 2. Suite disposition map

```
workers/main/tests/evals/                       verdict   action
├─ deploy-fake-data-live.test.ts                KILL      delete (requires create-worker + bun run deploy shell path)
├─ sandbox-write-file-live.test.ts              KILL      replace with project-write-file-live (prompt says "Use bash")
├─ browser-automation-live.test.ts              RESCUE    hard gate can never pass in eval env → restructure
├─ dashboard-fake-data-live.test.ts             FIX       prompt contradiction + vm-backed seed + keyword-soup gates
├─ space-matching-game-live.test.ts             FIX       unstated-requirement hard gates + scoreLatestPreview bug
├─ shadcn-components-live.test.ts               FIX       response-wording hard gate; scorecard punishes invited path
├─ notebook-deploy-live.test.ts                 FIX       events-JSON substring hard gate (near-guaranteed false pass)
├─ data-analysis-report-live.test.ts            FIX       same substring check; untargeted set_preview check
├─ project-revert-redeploy-live.test.ts         FIX       duplicate scorecard; order-as-hard-gate
├─ project-update-redeploy-state-live.test.ts   FIX       duplicate scorecard
├─ project-snapshot-revert-live.test.ts         FIX-lite  missing final-response marker gate (sibling parity)
├─ notebook-fix-rerun-live.test.ts              FIX-lite  "450" substring; criterion label overstates
├─ custom-prompt-live.test.ts                   FIX       required-substrings gate matches echoed prompt; vm-backed seed
├─ scheduled-prompt-live.test.ts                FIX-lite  nonempty check where prompt demanded exact text
├─ workflow-live.test.ts                        FIX-lite  entrypoint check too loose
├─ integration-create-live.test.ts              FIX-lite  never-fails criterion; server_url/auth unchecked
├─ custom-domain-live.test.ts                   FIX-lite  text-presence tool detection
├─ warehouse-list-live.test.ts                  FIX-lite  same + alias/label mismatch
├─ do-backed-project-deploy-live.test.ts        FIX-lite  duplicate scorecard criterion
│
├─ (new) project-write-file-live.test.ts        NEW unit  replaces sandbox-write-file-live, DO-backed
├─ (new) orders-analytics-api-live.test.ts      NEW hard  build-from-requirements + API math verified live
├─ (new) broken-app-rescue-live.test.ts         NEW hard  seeded 3-defect app; diagnose, fix, redeploy
└─ (new) metrics-ground-truth-notebook-live     NEW hard  analysis correctness vs harness-computed ground truth
```

Shared machinery fixed once, used everywhere: `eval-criteria.ts` (§4.1), `project-eval-helpers.ts` (§4.1, §6.4), timeouts (§4.1-d).

**Do not rename eval ids that are being fixed** — the viewer keys history by `evalTarget`, and keeping ids makes before/after comparable. Only the two killed evals lose their ids.

---

## 3. Phase 1 — Kill the dead legacy evals

### 3.1 Delete `deploy-fake-data-live`

The eval cannot pass and contradicts itself:
- Prompt mandates shell execution: "use the bundled **create-worker** command", "run the generated app's exact deploy script with **bun run deploy**". Hard criteria require regex evidence of both commands, which only bash/`vm_exec` on a legacy VM can produce.
- It hard-requires reading `developing-software/SKILL.md` (`read_deploy_skill`), and that skill now **forbids** exactly those commands. A compliant agent cannot satisfy both criteria.
- It seeds a `vm`-backed project (no `backend` arg) and inspects source through the legacy runtime host.

Its DO-native successor already exists and is healthy: `do-backed-project-deploy-live`.

Checklist:
1. Delete `workers/main/tests/evals/deploy-fake-data-live.test.ts`.
2. Remove the `deploy-fake-data-live` entry from `workers/main/tests/evals/manifest.json`.
3. **Preserve the two shared-helper unit tests** from the top of the deleted file (lines 593-602: "does not treat bare tool-name mentions as tool calls", "accepts explicit tool call expressions" — they test `jsExecCodeMentionsTool` from `project-eval-helpers.ts`). Move them into a new `workers/main/tests/evals/project-eval-helpers.test.ts` (plain vitest, no `RUN_AGENT_EVALS` gate — same style as `eval-criteria.test.ts`). The other two unit tests in that block test file-private helpers (`commandEvidenceText`, `buildPostDeployToolCriteria`) and die with the file. `space-matching-game-live.test.ts` has its own private copies of those helpers; nothing imports across eval files (verified).
4. `scripts/run-agent-eval.mjs:115` uses `deploy-fake-data-live` as the default eval when no argument is given. Change the default to `project-write-file-live` (the new cheap unit eval, §3.2).
5. Update the doc-comment example in `scripts/report-eval-run.mjs:9-10` to reference a live eval id (use `dashboard-fake-data-live`).
6. `tests/…/code-mode-runner.test.ts` uses the string `'deploy-fake-data'` as an arbitrary project name in unrelated unit tests — leave it alone.
7. Grep for remaining references: `grep -rn "deploy-fake-data-live" .` should return nothing outside git history.

### 3.2 Replace `sandbox-write-file-live` with `project-write-file-live`

The old eval's prompt is literally "Use bash in the sandbox-write-app project to create /workspace/eval-output.txt …", on a vm-backed seed, read back through the legacy runtime FS endpoint. The *mechanism* worth keeping is a fast unit smoke of the project file write/read path. Replace it:

1. Delete `workers/main/tests/evals/sandbox-write-file-live.test.ts`.
2. Create `workers/main/tests/evals/project-write-file-live.test.ts`, same harness skeleton, with these changes:
   - Seed: `workspaceFs.createProject({ id: "file-write-app", name: "file-write-app", description: "File write eval project.", workspaceId, backend: "do-r2" })`.
   - Prompt (exact):
     ```
     In the file-write-app project, create a file at the project root named eval-output.txt containing exactly this text (everything between the quotes, including the final period): "project write eval ok."
     Then read the file back and reply with the file contents only.
     ```
   - Read-back via `new ProjectFilesystemClient(testEnv, project.id).readFile("/eval-output.txt")` — not `PROJECT_RUNTIME_HOST`.
   - Pass/fail: `agent_session_completed`, `expected_file_written` (readFile succeeds), `file_contents_exact` (trimmed equality with `"project write eval ok."`), `final_response_includes_file_contents` (final result contains the exact string — keep hard; the prompt demands the token), plus the standard `no_assistant_error` / `runtime_events_exist` / `final_result_event_exists`.
   - The old `finalResultExtra.length <= 80` conciseness rule moves to a **scorecard** criterion `reply_conciseness` (1 pt: 1 if extra ≤ 80 chars, 0 otherwise). It was a quality judgment posing as a hard gate.
   - Keep the efficiency scorecard tiers (4/6/10 turns, 4 pts) unchanged — total 5 pts, within the unit-eval 1-5 budget.
3. Manifest entry: `{ "id": "project-write-file-live", "description": "Write and verify a file in a DO-backed project", "kind": "unit" }` (replaces the old entry).

### 3.3 Re-seed remaining vm-backed fixtures

Rule: every eval fixture project passes `backend: "do-r2"` explicitly, and file assertions go through `ProjectFilesystemClient`.

- `dashboard-fake-data-live.test.ts` — seeded without backend (line ~178); fixed as part of §5.1.
- `custom-prompt-live.test.ts` — seeded without backend (line ~158); add `backend: "do-r2"`. Nothing else in that harness reads files, so no read-path change.

### 3.4 Legacy leftovers in shared machinery

- **`scoreLatestPreview` (`eval-criteria.ts:254-293`)** detects "the final deploy" only via `/\b(?:bun\s+run\s+deploy|wrangler\s+deploy)\b/`, so a correct DO-path agent (`deploy_project` then `set_preview`) is permanently capped at 2/5. Fix: also treat a `deploy_project` invocation as a deploy event. Match per event text with `/\bdeploy_project\b/` in addition to the existing command regex (the events are already lower-cased JSON strings in that function). Add a unit test in `eval-criteria.test.ts`: events = [js_exec item whose code calls `tools.deploy_project(...)`, then a `set_preview` item] → 5/5. After §3.1 the only consumer is `space-matching-game-live`.
- **`legacyDeployPathEvidence` labels**: the helper flags `vm_exec`/`clone_project`/legacy scaffold+deploy commands but **not** plain `bash`. Criteria labeled "avoided legacy VM paths" overstate it. Do not expand detection (a rejected bash attempt already degrades the efficiency scorecard as a bad tool call; hard-failing exploration would be over-punishment). Instead relabel the criteria that use it to "Avoided legacy scaffold/deploy paths" (`notebook-fix-rerun-live` `avoided_web_deploy_path`, `data-analysis-report-live` `avoided_web_deploy_path`, `do-backed-project-deploy-live` `avoided_legacy_deploy_path`, `project-revert-redeploy-live` `avoided_wrong_rollback_paths`, `space-matching-game-live`, `browser-automation-live`, `project-update-redeploy-state-live` equivalents).
- **`space-matching-game-live` stale legacy fixtures**: the always-run helper unit tests still bless `create-worker` + `bun run deploy` sequences as zero-failure evidence and exercise a top-level `deploy_project` runtime item that cannot occur (it is js_exec-only). Update those fixtures to DO-path shapes (js_exec code blocks calling `tools.deploy_project`) as part of §5.2.

---

## 4. Phase 0 — Cross-cutting shared fixes (do these first)

### 4.1 `eval-criteria.ts`

**a) `buildNoAssistantErrorCriterion` — replace the transcript-wide substring.**
Today it hard-fails when the lowercased JSON of `result + events + messages` contains `"assistant error"` anywhere — including inside the echoed user prompt or any tool output. The string's actual source is the exported message error block: `{ type: "error", title: "Assistant error", error: ... }` built in `workers/main/src/pi-message-export.ts:185-199` when a message has an `errorMessage`.

Fix: change the signature to take the session result and detect the structure, not the substring:

```ts
export function buildNoAssistantErrorCriterion(
  result: Pick<AgentEvalSessionResult, "messages">,
): EvalPassFailCriterion {
  // Exported assistant messages surface harness/model failures as
  // { type: "error", title: "Assistant error", error } content blocks
  // (pi-message-export.ts). Detect the block, not a transcript substring.
  const errors = result.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter(
          (block) =>
            asRecord(block)?.type === "error" &&
            asRecord(block)?.title === "Assistant error",
        )
      : [],
  );
  return passFailCriterion({
    id: "no_assistant_error",
    label: "No assistant error",
    passed: errors.length === 0,
    reason: errors.length
      ? `Transcript contains ${errors.length} assistant error block(s): ${excerptFirst(errors)}`
      : undefined,
    details: errors.length ? { errors } : undefined,
  });
}
```

Update every call site (all evals pass `transcriptText` today — pass `result` instead). Add unit tests in `eval-criteria.test.ts`: a message with an error block fails; a message whose *text* merely contains the words "assistant error" passes.

**b) `scoreLatestPreview`** — §3.4.

**c) Redundant-scorecard rule.** Delete scorecard criteria that are keyed to the identical boolean as a hard gate (they can never vary independently):
- `do-backed-project-deploy-live`: `api_persistence_roundtrip` (5 pts, same condition as hard `deployed_app_smoke_passed`). Replace with nothing; fold its 5 points into the efficiency criterion's `maxPoints` or simply reduce the eval's scorecard total.
- `project-revert-redeploy-live`: `live_restore_smoke` (5 pts, same `liveRestored` bool as hard `live_app_restored`). Delete.
- `project-update-redeploy-state-live`: `state_preserved_after_redeploy` (5 pts, duplicates the hard smoke gate). Replace with a criterion the hard gate does not cover: `state_count_delta_correct` — 5 pts when the post-redeploy `count` equals exactly seeded 1 (not merely ≥ 1), 0 otherwise.

**d) Computed outer timeouts.** Every eval currently passes a hard-coded literal as the vitest `it` timeout while the inner session timeout is env-overridable via `EVAL_TIMEOUT_MS` with no clamp — an operator override larger than the literal makes vitest kill the test before the harness can emit a transcript. Fix mechanically in every eval file:

```ts
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);
// ... runAgentEvalSession({ timeoutMs: SESSION_TIMEOUT_MS, ... })
maybeIt("...", async () => { ... }, SESSION_TIMEOUT_MS + 60_000);
```

For `project-update-redeploy-state-live` (two sessions) the outer timeout is `2 * SESSION_TIMEOUT_MS + 180_000`. For real-deploy evals with post-session smoke retries (`project-revert-redeploy-live`, `notebook-deploy-live`, the new hard evals) use `SESSION_TIMEOUT_MS + 120_000` — the `fetchWithRetry` backoff chains can take ~30s each.

### 4.2 `project-eval-helpers.ts` — tool-call detection for the unit evals

`custom-domain-live` and `warehouse-list-live` each define a local `agentInvokedTool` that regex-scans js_exec code with both prefix and suffix optional — it matches a bare `get_custom_domain(` in a comment and misses indirect calls. Replace both local helpers with the shared `usedTool(events, name)` from `project-eval-helpers.ts` (comment-stripped, anchored on `tools.<name>(` / `tools["<name>"](` / `callTool("<name>"`), which the other evals already use. Keep accepting the hidden alias in `warehouse-list-live` (`usedTool(events, "analysis_list_connections") || usedTool(events, "warehouse_list_connections")`).

### 4.3 New shared helpers (used by Phase 3; add tests in `project-eval-helpers.test.ts`)

**a) `seedDoProjectFiles` in `project-eval-helpers.ts`** — the seeded-fixture pattern that `notebook-fix-rerun-live` and `project-revert-redeploy-live` each hand-roll:

```ts
export async function seedDoProjectFiles(
  workspaceFs: WorkspaceFilesystemStub,
  testEnv: TestEnv,
  input: {
    workspaceId: string;
    name: string;
    description: string;
    template?: "react-router" | "data-analysis";
    files: Record<string, string>; // path -> content, written after the scaffold
  },
): Promise<{ project: { id: string }; files: ProjectFilesystemClient }>
```

Creates the project with `backend: "do-r2"`, writes `defaultProjectScaffoldFiles(template)` (mirror how `notebook-fix-rerun-live.test.ts:138-156` does it), then overwrites/adds `input.files`. Existing evals may migrate to it opportunistically; do not force.

**b) `fetchJsonWithRetry` + `assertJsonSubset` in `eval-deploy-assert.ts`** — live-API round-trip helpers for the hard evals:

```ts
export async function fetchJsonWithRetry(
  url: string,
  init?: RequestInit,
  attempts?: number,
): Promise<{ status: number; json: unknown }>;  // wraps project-eval-helpers.fetchWithRetry

export function assertJsonSubset(
  actual: unknown,
  expected: Record<string, unknown>, // deep-compares only the keys present in expected
  label: string,
): string[]; // returns human-readable mismatch strings, [] when clean
```

`assertJsonSubset` returns failure strings (not throws) so evals can aggregate them into one criterion's `details`.

---

## 5. Phase 2 — Per-eval fixes

Each entry: what is wrong → exact change. Items marked **(cuttable)** are quality improvements that can be dropped under time pressure; everything else is required.

### 5.1 `dashboard-fake-data-live` (the flagship contradiction)

Bugs:
- Prompt names two different targets: "In the **dashboard-app project**, create … Write the dashboard to **/workspace/index.html**" — a project location and a legacy VM absolute path. Criteria then grade both (`used_dashboard_project` scans transcript text for either string; `wrote_index_html` reads the legacy runtime FS path).
- Fixture seeds a vm-backed project (no `backend`); read-back uses `PROJECT_RUNTIME_HOST /fs/read` with `/workspace/index.html`.
- `used_dashboard_project` is a transcript-substring hard gate (banned by contract) and is redundant once the file check reads the right project.
- `verified_or_summarized_file` hard gate is the regex `(verified|confirm(?:ed)?|file exists|successfully wrote|built|created|summar)` over transcript+result — matches nearly any completion ("created" appears in the prompt echo). Communication-quality → scorecard.
- Content checks are keyword-soup: `hasTable` passes on the *word* "table"/"row"/"column" anywhere; `hasChart` on "bar"/"line"; both feed the hard `required_dashboard_content`.

Changes:
1. Seed with `backend: "do-r2"`. Read back with `ProjectFilesystemClient(testEnv, project.id).readFile("/index.html")`.
2. New prompt (exact; one location, requirements only):
   ```
   In the dashboard-app project, create a polished static HTML dashboard using fake business data, as a single file named index.html at the project root.
   Include at least three metric cards with labeled values, a data table with at least four rows, and a small chart rendered with inline SVG or a <canvas> element.
   Use only HTML, CSS, and vanilla JavaScript in that one file so it can be opened directly.
   After creating it, read the file back to verify it exists, then briefly summarize what you built.
   ```
3. Pass/fail set becomes: `agent_session_completed`, `wrote_index_html` (readFile via ProjectFilesystemClient succeeds), `valid_static_html` (keep: doctype/html tag + style evidence + non-placeholder), `required_dashboard_content` **tightened to markup evidence**: ≥3 metric terms (keep the term list) AND (`<table` present OR ≥4 `<tr`) AND (`<svg` OR `<canvas` present) AND numeric fake data (`/\$[0-9][0-9,]+|[0-9]+%/`), `no_assistant_error`, `runtime_events_exist`, `final_result_event_exists`. Delete `used_dashboard_project` and `verified_or_summarized_file` as hard gates.
4. Scorecard: keep `dashboard_richness` (6) and efficiency (4); add `verified_and_summarized` (2 pts) — 1 pt if the agent re-read the file after writing (`usedTool(events, "read")` after the last write, or simply any `read` of `/index.html` in js_exec/tool items), 1 pt if the final response summarizes (non-empty `result.result` mentioning "dashboard"). This preserves the old intent as a graded signal.

### 5.2 `space-matching-game-live`

Bugs: terse prompt ("Create a web app that is a space themed matching game with a leaderboard where users can enter their credentials for their high score.") but hard gates require unstated implementation choices — reading `developing-software/SKILL.md` (`read_deploy_skill`), calling `set_preview`, shadcn `components.json`, React Router SSR, Durable Objects + `new_sqlite_classes`, and keyword-count thresholds (matching ≥ 4, leaderboard ≥ 2, credentials ≥ 1, space ≥ 3) with a documented history of false-fail patches. `important_pages_load_without_server_error` markers include `"not found"` and `"stack"` (a "tech stack" tagline false-fails). Plus the `scoreLatestPreview` bug (§3.4) and stale legacy unit fixtures (§3.4).

Keep the eval's identity (terse, from-scratch full-stack vibe test) but make the hard contract checkable behavior:

1. Prompt: append one sentence that states the minimum verifiable contract without dictating stack:
   ```
   Create a web app that is a space themed matching game with a leaderboard where users can enter their name with their high score.
   The deployed app must expose a leaderboard API: GET /api/leaderboard returns JSON { entries: [{ name, score }, ...] } and POST /api/leaderboard accepts JSON { name, score } and persists the entry so it survives across requests.
   This eval runtime injects CLOUDFLARE_API_BASE_URL and CLOUDFLARE_API_TOKEN, so do not ask for login or real Cloudflare credentials.
   ```
   (Also change "credentials for their high score" → "their name with their high score"; "credentials" invited password fields nobody grades.)
2. Hard gates become: `agent_session_completed`, deployed-app assertions (keep `workspace_app_created` / `assertDeployedApp` / live fetch), `leaderboard_roundtrip_correct` — harness POSTs `{ name: "EvalPilot", score: 4200 }` then GETs and requires the entry present (use `fetchJsonWithRetry` + `assertJsonSubset`), `game_page_loads` (root 200 + non-empty; **remove `"not found"` and `"stack"` from the error-marker list**, keep explicit markers like `"internal server error"`, `"exception"`, `"cannot GET"`), `no_assistant_error`, standard events criteria.
3. Demote to scorecard: `read_deploy_skill` → delete entirely (process check with no user-visible value); `called_set_preview` → 2 pts; the source keyword-soup (`matchingGame/leaderboard/credentials/spaceTheme` counts, shadcn/DO/SSR detection) → fold into a `game_source_richness` scorecard criterion (6 pts, reuse the existing inspection details); keep efficiency tiers.
4. Update the always-run helper unit tests for the new criterion builders and DO-path fixtures (§3.4).

### 5.3 `browser-automation-live` (structural rescue)

Bug: the hard gate `browser_automation_passed` requires the agent's `env.BROWSER` session to print `"browserE2E":"passed"`, but the eval env has no BROWSER binding, so `env.BROWSER.launch` **always** throws `"Browser sessions require the BROWSER binding"` — which the eval itself detects as `browserLaunchInfrastructureFailure`. One hard gate (`browser_automation_attempted`) forces the attempt; the other can then never pass. The eval fails every run by construction.

Restructure (keep id and intent — "build an interactive app and verify it"):
1. Keep the prompt's build/deploy portion; **replace** the browser-check instructions with:
   ```
   After deploying, attempt an interactive browser automation check in js_exec using env.BROWSER.launch({ scriptName: "browser-automation-lab", path: "/" }): click #lab-counter-button twice, wait for the text "Clicked 2 times", read logs(), and console.log JSON containing exactly "browserE2E":"passed" if every step succeeded.
   If env.BROWSER is unavailable in this environment, say so explicitly in your reply instead of pretending the check ran.
   Always close the browser session in a finally block. When done, reply with the deployed URL and the browser automation result.
   ```
2. Hard gates: `agent_session_completed`, deploy assertions, **harness-side interactivity checks** replacing the impossible gate — fetch the live root and require HTTP 200, the exact strings `id="lab-counter-button"`, `Increment lab counter`, and `Clicked 0 times` in the served HTML (SSR scaffold renders the initial state), `browser_automation_attempted` (keep: `usedTool`-style evidence of `env.BROWSER.launch` in js_exec code — the attempt is always possible), `no_assistant_error`, standard events criteria.
3. Scorecard: `browser_workflow_quality` (keep, includes the pass-marker as a graded signal — it can score in a future env that has the binding), `honest_env_reporting` (2 pts: final response either reports the pass marker or explicitly states the browser binding was unavailable; 0 if it claims success without marker evidence), efficiency tiers.
4. Wire the existing unused `usedScreenshot` detection into the scorecard (−0: fold into `browser_workflow_quality` as one of its boolean components) or delete the dead computation. **(cuttable)**
5. The env-limitation filter in `eval-signal.ts` already exempts the BROWSER failure from bad-tool-call counts; no change there.

### 5.4 `notebook-deploy-live` and `data-analysis-report-live`

Bug (both): `usedDataAnalysisTemplate = JSON.stringify(result.events).includes("data-analysis")` feeds a **hard** gate. The prompt itself says "data-analysis", the agent echoes it in reasoning, reasoning is in the events blob → near-guaranteed false pass.

- `notebook-deploy-live`: delete the substring check from `discovered_notebook_deploy_flow`; the criterion keeps its other components (tool evidence). The persisted-notebook hard gate already proves the template (a react-router scaffold has no `analysis.ipynb`). **(cuttable)** add scorecard `product_lines_covered` (2 pts) — persisted notebook source mentions ≥3 distinct product-line names.
- `data-analysis-report-live`: same deletion. Additionally: `set_preview` criterion must check the call targeted `analysis.ipynb` (inspect the runtime item's arguments, not just tool presence); the required-finding check should require the finding inside a **markdown** cell (`cell.cell_type === "markdown"`), matching the prompt's "in markdown".

### 5.5 `project-revert-redeploy-live`

- Delete `live_restore_smoke` scorecard duplicate (§4.1-c).
- `used_restore_then_deploy_tools` currently hard-fails unless `list_commits < revert_project < deploy_project` in strict mention order. The outcome gates (`source_restored`, `live_app_restored`) already prove correctness. Split it: hard gate `used_snapshot_tools` = all three tools were used (any order, via `usedTool`); scorecard `restore_flow_order` (2 pts) = the strict order held (`runtimeToolMentionOrder`).
- Outer timeout → computed (§4.1-d).

### 5.6 `project-update-redeploy-state-live`

- Replace `state_preserved_after_redeploy` scorecard (§4.1-c) with `state_count_delta_correct`.
- Relabel `state_seeded_before_redeploy` → "Harness seeded live check-in via the session-1 API" so the label says what it is (the agent's session-1 API accepting the harness POST). Keep it hard — it is evidence the built API worked.

### 5.7 `project-snapshot-revert-live`

Add the missing hard gate for the prompt's explicit ask ("reply with the restored marker"), mirroring its sibling: `final_response_mentions_restored_marker` — `result.result` contains `RESTORED_VERSIONED_NOTES_BASELINE`.

### 5.8 `notebook-fix-rerun-live`

- `final_response_has_total` matches the bare substring `"450"` (false-passes on "1450", timestamps). Require `/(^|[^0-9])450([^0-9]|$)/` against `result.result`, or the exact token `REFRESHED_TOTAL_REVENUE=450`.
- Relabel `avoided_web_deploy_path` per §3.4.

### 5.9 `custom-prompt-live`

- **False-pass:** `required_transcript_substrings_present` (hard) matches against the whole transcript JSON — which contains the echoed operator prompt, so any required substring that appears in the prompt is auto-satisfied. Fix: build the haystack from agent-authored content only — `result.result` + assistant-role messages + runtime tool items — explicitly excluding `role === "user"` messages. Keep the criterion hard (it is the harness's entire contract).
- Delete the tautological `custom_prompt_present` criterion (hard-coded `passed: true` in the success branch).
- Seed `backend: "do-r2"` (§3.3).

### 5.10 Unit evals (small, mechanical)

- `scheduled-prompt-live`: prompt demands exact prompt text; `schedule_prompt_nonempty` only checks non-empty. Change to equality with `"Summarize the latest commits from yesterday."` (id → `schedule_prompt_exact`). Also reword that scheduled prompt body to something the product can actually do post-bash, e.g. `"Reply with a one-line workspace status summary."` — the body is never executed in the eval, but eval prompts should not model dead workflows.
- `workflow-live`: `workflow_source_has_entrypoint` only checks `includes("WorkflowEntrypoint")`. Tighten to `/class\s+AutomationWorkflow\s+extends\s+WorkflowEntrypoint/.test(source)` plus `imports_only_cloudflare_workers`: every `from "..."`/`import "..."` specifier in the persisted source equals `cloudflare:workers`.
- `integration-create-live`: (a) delete `integration_type_correct` — the match is found by name AND type, so the criterion can never fail independently; instead find the match **by name only** and assert type as its own criterion (now it can genuinely fail); (b) add `integration_config_correct` (hard): persisted config's `server_url === "https://mcp.example.com/sse"` and `auth_type === "none"` (both prompt-stated; verify the exact persisted field names against `getWorkspaceIntegrations` output before writing the assertion).
- `custom-domain-live` / `warehouse-list-live`: swap local `agentInvokedTool` for `usedTool` (§4.2); in `warehouse-list-live`, make the `runtimeAssertions.failures` message name the same canonical tool as the criterion label (`analysis_list_connections`, alias accepted).
- `do-backed-project-deploy-live`: delete the redundant `api_persistence_roundtrip` scorecard (§4.1-c); remove the two false parentheticals in the prompt if confirmed wrong — the prompt claims "add_dependency is not a top-level tool" / "deploy_project is not a top-level tool", which is **correct** per the current tool wiring, so leave the prompt alone; only the scorecard change applies here.

---

## 6. Phase 3 — Three new hard skill evals

Design rules (§1 contract, plus): prompts are **product requirements, not tool walkthroughs** — the existing skill evals tell the agent which tools to call in which order; the hard evals measure whether the agent can find the path itself. Verification is 100% harness-side and deterministic. Scorecard budgets follow the manifest guidance (skill = 6-20 pts).

```
            orders-analytics-api-live          broken-app-rescue-live            metrics-ground-truth-notebook-live
            (build from requirements)          (diagnose & repair)               (analysis correctness)

  seed ───────── (none) ─────────────┐   3-defect app in DO project        deterministic sales.csv + scaffold
                                     │   (build error, logic bug,          (ground truth computed in-test
  agent    requirements-only prompt  │    display bug)                      from the same literal rows)
   turn    create → implement API    │   symptom-only bug report            analyze → notebook → exact-format
           + UI → deploy             │   find defects → fix → redeploy      Key Findings → run → set_preview
                                     │
  harness  POST/GET workload against │   fetch live API + page:            parse persisted executed notebook:
  verify   live app: exact totals,   │   exact corrected values,           4 findings == ground truth,
           filters, 400s, DO config  │   seeded data untouched,            executed outputs, markdown cells
                                     │   minimal-diff scorecard
```

All three end with `emitEvalTranscript({...})` and the standard criteria (`agent_session_completed`, `no_assistant_error`, `runtime_events_exist`, `final_result_event_exists`) in addition to what is listed. Efficiency scorecards use `scoreSignalEfficiency` with the tiers given. "Avoided legacy paths" is **scorecard** (2 pts via `legacyDeployPathEvidence().length === 0`) in all three — hard evals grade outcomes hard, paths soft.

### 6.1 `orders-analytics-api-live` — build-from-requirements with verifiable math

`workers/main/tests/evals/orders-analytics-api-live.test.ts` · manifest: `{ "id": "orders-analytics-api-live", "description": "Build and deploy an order-tracking app whose API math the harness verifies live", "kind": "skill", "realDeploy": true, "tier": "hard" }`

**Fixture:** none (from scratch). Gate on `isRealEvalDeployEnabled` like `do-backed-project-deploy-live`.

**Prompt (exact):**
```
Build and deploy a small order-tracking app as a project named exactly "orders-analytics", deployed with script_name "orders-analytics".
Requirements for the deployed app:
- POST /api/orders accepts JSON { item: string, category: string, amountCents: number }, persists the order durably, and returns the stored order as JSON. Reject invalid bodies (missing or empty item or category, or amountCents that is not a positive integer) with HTTP 400 and a JSON error body.
- GET /api/orders returns JSON { orders: [...] } of all persisted orders, and supports an optional ?category= query parameter that filters by exact category.
- GET /api/summary returns JSON { totalCents, orderCount, byCategory } where byCategory maps each category to { totalCents, orderCount }, all computed from the persisted orders.
- Orders must survive across separate requests using Durable Object storage, not in-memory state.
- The root page is a small HTML UI titled "Orders Analytics" that lists the orders and shows the summary.
When done, reply with the live URL.
```

**Harness verification (after the session):** `assertDeployedApp(result, { name: "orders-analytics", hostSuffix: ".evals.camelai.app" })`, `assertDeployedAppLive`, then drive a fixed workload with `fetchJsonWithRetry`:

```ts
const WORKLOAD = [
  { item: "star chart",  category: "gear",   amountCents: 1999 },
  { item: "fuel cell",   category: "gear",   amountCents: 5501 },
  { item: "ration pack", category: "supply", amountCents: 850 },
  { item: "ration pack", category: "supply", amountCents: 850 },
  { item: "nav module",  category: "avionics", amountCents: 12000 },
  { item: "patch kit",   category: "supply", amountCents: 300 },
];
// totals: overall 21500/6; gear 7500/2; supply 2000/3; avionics 12000/1
const INVALID = [
  { category: "gear", amountCents: 100 },              // missing item
  { item: "ghost", category: "gear", amountCents: -5 } // non-positive amount
];
```

**Pass/fail:** `deployed_app_live`; `orders_accepted` (all six POSTs return 2xx); `invalid_orders_rejected` (both invalid POSTs return exactly 400 with a JSON body); `orders_listing_correct` (GET /api/orders has 6 orders); `category_filter_correct` (`?category=supply` returns exactly 3); `summary_math_correct` (`assertJsonSubset` against `{ totalCents: 21500, orderCount: 6, byCategory: { gear: { totalCents: 7500, orderCount: 2 }, supply: { totalCents: 2000, orderCount: 3 }, avionics: { totalCents: 12000, orderCount: 1 } } }` — issue the GET **twice** and require identical results across requests); `durable_object_persistence_configured` (persisted source has a DO binding + a `new_sqlite_classes`/`new_classes` migration — reuse the `inspectDoBackedProjectSource` pattern from `do-backed-project-deploy-live`; prompt-stated, so fair as hard); `ui_page_served` (root 200, body contains "Orders Analytics").

**Scorecard (max 15):** efficiency 4 pts (tiers 24/4 → 4, 32/6 → 3, 44/8 → 2, fallback 1); `error_response_quality` 3 (400 bodies parse as JSON with a non-empty `error` message); `ui_shows_data` 4 (root HTML contains at least one workload item name and a rendered total after the workload — fetch root again post-workload); `avoided_legacy_paths` 2; `reply_includes_url` 2 (final response contains the deployed URL).

**Timeouts:** session default `900_000`; outer `SESSION_TIMEOUT_MS + 120_000`.

### 6.2 `broken-app-rescue-live` — diagnose and repair a seeded 3-defect app

`workers/main/tests/evals/broken-app-rescue-live.test.ts` · manifest: `{ "id": "broken-app-rescue-live", "description": "Diagnose and fix a seeded broken app (build, logic, display defects) and redeploy it", "kind": "skill", "realDeploy": true, "tier": "hard" }`

**Fixture:** `seedDoProjectFiles` with the react-router template plus these files (write the seeded map to a const so the scorecard can diff against it). The defects — exactly three, independent, each with a distinct symptom:

1. **Build breaker** — `workers/app.ts` imports `"../app/lib/expense"` (file is `expenses.ts`) → `build_project` fails until fixed.
2. **Logic bug** — `app/lib/expenses.ts` exports the literal `EXPENSES` array (6 entries, `amountCents` values `4200, 1850, 12500, 3100, 900, 4900` with categories `travel, meals, equipment, travel, meals, equipment`; ground truth: total `27450`, travel `7300/2`, meals `2750/2`, equipment `17400/2`) and a `summarizeExpenses()` whose accumulator uses `total = expense.amountCents` instead of `total += expense.amountCents`, and keys `byCategory` on `expense.item` instead of `expense.category`. `/api/expenses/summary` in `workers/app.ts` returns its result.
3. **Display bug** — `app/routes/home.tsx` SSR-renders `Total spent: {formatCents(summary.totalCents)}` next to the marker `EXPENSE_PORTAL_TOTAL`, but the seeded `formatCents` divides by 10 instead of 100 (shows `$2745.00` instead of `$274.50`).

Write the seed so each file compiles on its own except for the planted defect (implementer: verify the seeded app actually builds+deploys and shows the wrong values once defects are fixed one at a time — the defects must be the *only* problems).

**Prompt (exact, symptom-only — never names the defects):**
```
My expense report app in the existing project "expense-portal" is broken and I need it working today.
Deploying it currently fails with a build error. The last time it did deploy, the summary API returned obviously wrong numbers, and the page showed the wrong total dollars.
Find and fix the problems in the existing project without rewriting it and without changing the expense data, then deploy it with script_name "expense-portal".
Reply with the live URL and the correct total dollars shown on the page.
```

**Pass/fail:** `deployed_app_live`; `summary_api_correct` (`assertJsonSubset` of GET `/api/expenses/summary` against `{ totalCents: 27450, byCategory: { travel: {...7300/2}, meals: {...2750/2}, equipment: {...17400/2} } }`); `page_shows_correct_total` (root HTML contains `EXPENSE_PORTAL_TOTAL` and the exact string `$274.50`, and does **not** contain `$2745.00` or `NaN`); `expense_data_unchanged` (persisted `app/lib/expenses.ts` still contains all six `amountCents` literals — check each of the 6 numbers appears; tolerant of reformatting); `final_response_has_total` (`result.result` contains `$274.50` — prompt-demanded token).

**Scorecard (max 14):** `minimal_diff` 4 (read back every seeded file via `ProjectFilesystemClient` and count files whose content differs from the seed map: ≤3 changed → 4, 4-5 → 2, else 0; put the changed-path list in `details`); efficiency 4 (tiers 20/3 → 4, 28/5 → 3, 38/8 → 2, fallback 1); `diagnosed_before_editing` 2 (runtime evidence shows a `read`/`ls` of project files before the first project `write`/`edit` — derive from `collectRuntimeEvidence` item order); `avoided_legacy_paths` 2; `reply_quality` 2 (URL + total both present).

**Timeouts:** session default `900_000`; outer `+120_000`.

### 6.3 `metrics-ground-truth-notebook-live` — analysis correctness against ground truth

`workers/main/tests/evals/metrics-ground-truth-notebook-live.test.ts` · manifest: `{ "id": "metrics-ground-truth-notebook-live", "description": "Analyze a seeded CSV in a notebook and report four findings the harness checks against computed ground truth", "kind": "skill", "tier": "hard" }` — **no `realDeploy`**, so this hard eval runs everywhere (needs the analysis sandbox like the other notebook evals).

**Fixture:** define the dataset as a literal TS array in the test — 36 rows: `{ month: "2025-01".."2025-12", region: "North"|"South"|"West", units, unitPriceCents }` — pick values so ground truth is unambiguous with clear margins (one region and one month are decisive winners; no ties). Compute ground truth **in the test from the same array** (single source of truth): `TOTAL_REVENUE_CENTS`, `TOP_REGION`, `TOP_MONTH`, `REVENUE_PER_UNIT_CENTS` (= total revenue ÷ total units, rounded to nearest integer; pick numbers that don't land on `.5`). Serialize the array to CSV (`month,region,units,unit_price_cents` header) and seed with `seedDoProjectFiles`: template `data-analysis`, project name `sales-insights`, file `/data/sales.csv`.

**Prompt (exact):**
```
The existing data-analysis project "sales-insights" contains /data/sales.csv with columns month, region, units, unit_price_cents. Revenue for a row is units * unit_price_cents.
Edit analysis.ipynb into a report titled exactly "Sales Insights Report" that analyzes this file and includes at least one chart of revenue over time.
The report must contain a markdown section headed exactly "## Key Findings" with these four lines, using exact integer values computed from the data (no thousands separators):
- TOTAL_REVENUE_CENTS=<total revenue in cents>
- TOP_REGION=<region with the highest total revenue>
- TOP_MONTH=<YYYY-MM month with the highest total revenue>
- REVENUE_PER_UNIT_CENTS=<total revenue divided by total units, rounded to the nearest integer>
Run the notebook with run_notebook until it executes cleanly, then set_preview for analysis.ipynb.
Do not use build_project, deploy_project, or wrangler for this notebook-only project. Reply with the four Key Findings lines.
```

**Pass/fail:** `notebook_persisted_and_executed` (read `/analysis.ipynb` via `ProjectFilesystemClient`; parse; ≥1 code cell has `execution_count` or outputs — reuse the `inspectNotebook` pattern from `data-analysis-report-live`); `key_findings_present` (a markdown cell contains `## Key Findings` and all four `NAME=` lines); `findings_match_ground_truth` — extract each `NAME=value` with `/^-\s*TOTAL_REVENUE_CENTS=(\d+)\s*$/m` etc. from the markdown-cell text and require exact equality with the harness-computed values (report each mismatch in `details`); `set_preview_targeted_notebook` (set_preview runtime item whose arguments reference `analysis.ipynb`); `avoided_web_deploy_path` (prompt-stated prohibition; hard, matching the sibling notebook evals); `final_response_has_findings` (all four `NAME=value` tokens appear in `result.result` — prompt-demanded).

**Scorecard (max 11):** `chart_output_present` 3 (any executed cell output has an image or vega mimetype — `image/png`, `image/svg+xml`, or `application/vnd.vegalite*` in `outputs[].data`); `report_narrative` 2 (title markdown cell equals "Sales Insights Report" and ≥2 markdown cells total); efficiency 4 (tiers 10/2 → 4, 14/4 → 3, 20/8 → 2, fallback 1); `avoided_legacy_paths` 2.

**Timeouts:** session default `480_000`; outer `+60_000`.

---

## 7. Phase 4 — Scannability: manifest tier, criteria conventions, viewer UI

### 7.1 Manifest `tier` + suite selection

1. `workers/main/tests/evals/manifest.json`: add optional `"tier": "hard"` to the three new evals. Absent = standard. Update the `$comment` to document `tier` and the new-eval checklist line.
2. `scripts/run-eval-suite.sh` `run_evals()`: extend `EVAL_TARGET` handling — `hard` selects manifest entries with `tier === "hard"`, `standard` selects entries without it, `all` unchanged (comma-separated ids unchanged). Same `node -e` filter pattern already used for `all`.
3. `scripts/run-agent-eval.mjs`: it already reads the manifest entry for `--kind`/`--description`; also forward `--tier <tier>` when present.
4. `scripts/report-eval-run.mjs`: accept `--tier`, include `tier` in the `POST /upload/:id/complete` body.
5. `workers/eval-reports/src/types.ts`: `Run.tier?: "hard"`, `CompleteRequest.tier?: string` (validate to the literal `"hard"` on ingest); copy the field in the complete handler next to `kind` (`workers/eval-reports/src/index.ts` complete route).

### 7.2 Criteria conventions (mechanical sweep during Phases 1-3)

- Criterion `id`s are snake_case and **stable across runs of the same eval** — never derived from run data. Shared ids (`agent_session_completed`, `no_assistant_error`, `runtime_events_exist`, `final_result_event_exists`, `agent_efficiency`) keep their exact names in every eval so a future per-criterion pivot can align them.
- Every failed criterion must carry a human-readable `reason`; every hard gate that judges content must put its evidence in `details` (the viewer renders both).
- Scorecard labels state what earns points, not what the criterion is about ("set_preview called after the final deploy" not "Preview quality").

### 7.3 Eval-reports viewer changes (`workers/eval-reports/app/`)

The viewer is a React SPA using the main app's shadcn primitives (`@/components/ui`: `Table`, `Badge`, `Card`, `Select`, `ToggleGroup`, `HoverCard`, `Tabs`). Four changes, each independent. Verified gaps they close: failure reasons are hover-only in the Runs view and first-criterion-only in the batch peek; matrix batches render as a flat runs table with no model comparison; there is no per-criterion aggregation; there is no model filter and no tier surfacing.

**a) Runs view — visible failure reason + model filter** (`app/components/runs-table.tsx`, `app/routes/runs-list.tsx`)

Add a "Failure" column to `RunsTable` between Score and Batch: for failed runs, the first failed criterion's `label`, and when a `reason` exists append ` — <reason>` (single line, `truncate max-w-[28rem] text-muted-foreground text-sm`, full text in `title=`); em-dash placeholder for passing runs. Keep the existing `ResultCell` HoverCard (it shows *all* failed criteria). Add a Model `Select` in the Runs-view filter row (`runs-list.tsx`, next to the existing eval `Select`), options = "All models" + distinct `run.model` values from loaded runs, filtering client-side like the eval filter.

```
│ Result │ Eval                        │ Score │ Failure                                      │ Batch    │ …
│  ✗     │ orders-analytics-api-live   │ 41%   │ Summary math correct — byCategory.gear.tot…  │ batch-…  │
│  ✓     │ dashboard-fake-data-live    │ 90%   │ —                                            │ batch-…  │
```

**b) Batch detail — model × eval matrix** (`app/routes/batch-detail.tsx`, new `app/components/batch-matrix.tsx`)

Render only when the batch has ≥ 2 distinct models. Place in a `Card` titled "Model × eval" between the stat tiles and the failed-criteria card. Build from the already-loaded member runs: group by `evalTarget` (rows, sorted alphabetically) × `model` (columns, sorted). Cell = that run's verdict icon + score % (reuse the existing verdict icon + `ScoreValue`/score-band colors); whole cell links to `/runs/:runId`. Multiple runs of the same (eval, model): show the latest, with a small `×N` count. Empty cell (combination not run): centered `–` muted.

```
┌ Model × eval ──────────────────────────────────────────────────────────────┐
│ Eval                              claude-sonnet-5   gpt-5-codex   gemini…  │
│ dashboard-fake-data-live          ✓ 90%             ✓ 75%         ✗ 30%    │
│ orders-analytics-api-live         ✓ 87%             ✗ 41%         ✗ 12%    │
│ broken-app-rescue-live            ✓ 71%             ✓ 64%         –        │
│ metrics-ground-truth-notebook…    ✓ 100%            ✗ 55%         ✗ 55%    │
└─────────────────────────────────────────────────────────────────────────────┘
```

Implementation: shadcn `Table` with `sticky left-0` first column (`whitespace-nowrap`), horizontal scroll wrapper (`overflow-x-auto`) for many models. No new API — the loader already fetches all member runs.

**c) Batch detail — failed criteria grouped by criterion** (`app/components/batch-detail.tsx` / `FailedCriteriaCard`)

Change the card's grouping from per-run to per-criterion: group failed criteria across member runs by `evalTarget + criterion.id`. Each group row: criterion `label` (bold) + eval id (muted), right-aligned `Badge variant="destructive"` with `N runs`, below it the first non-empty `reason` (muted, truncated), then the affected runs as inline model links (`sonnet-5`, `gpt-5-codex` → `/runs/:id`). Sort groups by N desc. This turns "which criterion regressed across the batch" into a one-glance read; per-run detail remains one click away on the run pages.

```
┌ Failed criteria ───────────────────────────────────────────────────────────┐
│ Summary math correct · orders-analytics-api-live              [ 2 runs ]  │
│   byCategory.gear.totalCents expected 7500, got 5501                       │
│   gpt-5-codex · gemini-3-5-flash                                           │
│ ───────────────────────────────────────────────────────────────────────── │
│ Findings match ground truth · metrics-ground-truth-notebook…  [ 2 runs ]  │
│   TOP_MONTH expected 2025-11, got 2025-12                                  │
│   gpt-5-codex · gemini-3-5-flash                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

**d) Tier badge**

Wherever the kind badge (`unit`/`skill`) renders — `RunsTable` eval cell, run-detail header, batch peek rows — also render `tier === "hard"` as `<Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">hard</Badge>`. Data flows from §7.1.

**(cuttable)** items a-d are ordered by value; if trimming, keep (a) and (b).

---

## 8. Rollout order & verification

Work in five commits/PRs, each independently green:

1. **Phase 0** (§4): shared fixes + `project-eval-helpers.test.ts` + new helpers.
   Verify: `bun run typecheck`; `bun run test:workers -- tests/evals/eval-criteria.test.ts tests/evals/eval-signal.test.ts tests/evals/eval-deploy-assert.test.ts tests/evals/project-eval-helpers.test.ts` (these run without `RUN_AGENT_EVALS`).
2. **Phase 1** (§3): kills + `project-write-file-live` + manifest + script defaults.
   Verify: typecheck; `grep -rn "deploy-fake-data-live\|sandbox-write-file-live"` clean (scripts/docs); if Docker + `.dev.vars` are available, `bun run test:eval project-write-file-live`.
3. **Phase 2** (§5): per-eval fixes.
   Verify: typecheck; the always-run helper `describe` blocks (`space-matching-game`, criteria tests) via `bun run test:workers`; spot-run the two cheapest changed evals if the env allows: `bun run test:eval scheduled-prompt-live` and `bun run test:eval dashboard-fake-data-live`. Real-deploy evals skip cleanly when `EVAL_REAL_DEPLOY=0`.
4. **Phase 3** (§6): the three hard evals + manifest entries.
   Verify: typecheck; for `broken-app-rescue-live`, first assert the fixture's own consistency in a plain (non-gated) unit test in the same file: ground-truth constants match the seeded `EXPENSES` literals, and the seeded `summarizeExpenses` source *contains* the planted bugs (guards against a future "fix" of the fixture). Run each hard eval once locally before merging (`EVAL_REPORT=1` optional): `bun run test:eval metrics-ground-truth-notebook-live` runs without CF_API_TOKEN; the other two need real deploy enabled.
5. **Phase 4** (§7): tier plumbing + viewer.
   Verify: typecheck; run the viewer locally (`workers/eval-reports/README.md`, `CF_ACCESS_ENABLED=0` dev bypass) against reported runs; deploy with `bun run deploy:eval-reports` after review.

Agent evals are judgment calls at run time — a hard eval failing on a weak model is expected; what must not happen is a hard eval failing on **harness** grounds (fixture doesn't build, ground truth mismatched, criteria false-fail). Treat any `harness_error`-shaped failure in the Phase 3/4 runs as a bug in this plan's specs and fix the harness, not the prompt.

## 9. Out of scope (deliberate)

- Per-criterion history across batches and batch-over-batch regression deltas in the viewer (natural follow-up once §7.2's stable criterion ids have accumulated data).
- Server-side filtering/pagination beyond the 200-run cap in the viewer API.
- An LLM-judge scoring path; every criterion in this plan is deterministic.
- Seeded live data connections for warehouse-query evals (no mock connection path exists in the eval env today; revisit if one is built).
- Migrating existing evals onto `seedDoProjectFiles` (new evals use it; migration is opportunistic).
