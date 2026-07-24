# Running agent evals

camelAI agent evals **run locally** in a `qaml-ai/camelAI` checkout — there is no remote
runner. This service (**`https://evals.camelai.dev`**, `workers/eval-reports`) is only the shared
results history: a read-only dashboard + JSON API plus an upload endpoint the local reporter uses.
Everything is behind **Cloudflare Access**.

> This document is served by the service itself at `GET /skill`, so it always matches the running
> API. (You're reading it because you fetched that endpoint.)

## Run an eval (locally, in chiridion-app)

Requirements: Docker, Bun, and a `.dev.vars` in the repo root (the eval secret bundle).

```bash
bun run test:eval <eval-id>          # ids from workers/main/tests/evals/manifest.json
bun run test:eval:dashboard          # or :deploy / :sandbox shortcuts

# Custom prompt (not committed to the tree) via the generic harness:
CUSTOM_EVAL_PROMPT="Build a dashboard from fake data." \
  bun scripts/run-agent-eval.mjs custom-prompt-live
```

Common knobs: `--model <id>`, `--timeout-ms <ms>`, `EVAL_REAL_DEPLOY=0/1` (publish apps to the
testing-grounds namespace for real), `CUSTOM_EVAL_PROJECT`,
`CUSTOM_EVAL_REQUIRED_TRANSCRIPT_SUBSTRINGS`. See `bun scripts/run-agent-eval.mjs --help`.

Suite and matrix invocations automatically mint a shared `EVAL_BATCH_ID` plus a default
`EVAL_BATCH_LABEL`, so their member runs group together on the dashboard. Pre-set either env var
when an orchestrator needs to join runs into an existing batch. Solo `bun run test:eval <id>` runs
stay batchless and render as singleton batches.

## Report a run here

Set `EVAL_REPORT=1` on the run and the reporter (`scripts/report-eval-run.mjs`) uploads the output
log and run metadata when the eval finishes — pass or fail. It also uploads the transcript
artifact, including its scorecard, when the eval emitted it:

```bash
EVAL_REPORT=1 bun run test:eval dashboard-fake-data-live
```

Reporting is best-effort and never fails the eval. Artifactless harness failures are still
reported; ingest synthesizes an `evaluation_contract` failure so they remain visible. Finalization
is retried up to three times with the same run id before the reporter gives up. Re-report an
artifact by hand:

```bash
node scripts/report-eval-run.mjs --eval <id> --artifact .eval-artifacts/<id>.json [--log <file>] \
  [--batch <id>] [--batch-label <text>] [--kind unit|skill] [--tier hard] \
  [--description <text>]
```

## Getting past Cloudflare Access in the CLI

Reads and uploads both need an Access credential (the worker re-validates the JWT):

- **Service token (scripts / CI):** the `evals-ci` token in Cloudflare Zero Trust → Access →
  Service Auth. `export CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=...` — the reporter and
  `curl -H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..."` both use these.
- **Interactive login (humans, `@camelai.com`):** `cloudflared access login https://evals.camelai.dev`,
  then the reporter mints tokens automatically; for curl use
  `-H "cf-access-token: $(cloudflared access token -app=https://evals.camelai.dev)"`.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/batches?limit=` | List complete batch summaries from the bounded recent index (newest first, capped at 200 batches) |
| `GET /api/batches/:id` | Batch summary plus indexed member runs |
| `GET /api/runs?limit=` | List reported runs (newest first, capped at 200) |
| `GET /api/runs?batch=` | List every run in a batch, uncapped; batchless singleton ids return that run |
| `GET /api/runs/:id` | Run record (status, exit/error context, evaluation criteria/scorecard, signal, deployed apps) |
| `GET /api/runs/:id/log` | The run's captured output log |
| `GET /api/runs/:id/artifacts` | Transcript artifact filenames |
| `GET /api/runs/:id/artifact/:name` | Transcript JSON |
| `PUT /upload/:id/log`, `PUT /upload/:id/artifacts/:name`, `POST /upload/:id/complete` | Used by the reporter |
| `GET /skill` | This document |

A run is `completed` or `failed`. When a primary rollout judge grade is present, that grade
determines task success and machine criteria remain diagnostic evidence. A nonzero exit from a
negative primary grade or a true harness/contract failure, and a missing or invalid evaluation
artifact, still fail the run. Without a primary judge grade, machine pass/fail criteria determine
success. When no criterion explains a failed run, the dashboard displays `run.error`, then
`signal.violations`, then the nonzero exit code, with a generic fallback if none is available. The
dashboard at
`https://evals.camelai.dev/` defaults to Batches, with Runs and Evals views plus batch detail pages
at `/batches/:batchId`.

Run records may include `batchId` and `batchLabel` (reporter-supplied suite/matrix grouping),
`kind` (`unit` or `skill`, from the manifest), `description` (manifest one-liner), and
`tier` (`hard` for high-difficulty evals), plus `exitCode`, `error`,
`signal.violations`, and `startPrompt` (ingest-derived from the uploaded artifact; prefer top-level
`prompt`, else first user message). `POST /upload/:id/complete` accepts `batchId`, `batchLabel`,
`kind`, `tier`, and `description`; `startPrompt` is never client-supplied.

## Adding a new committed eval

Add `workers/main/tests/evals/<id>.test.ts` (gated on `RUN_AGENT_EVALS === "1"`, ending in
`emitEvalTranscript({...})`) and register it in `workers/main/tests/evals/manifest.json` with
`id`, `description`, required `kind`, optional `tier: "hard"`, and optional `realDeploy`. Use
`kind: "unit"` for one mechanism check and `kind: "skill"` for end-to-end agent ability.
New evals should emit a task-specific 0-4 anchored rubric with 3-8 criteria whose positive weights
total 100. The rollout judge's `grading` result is primary when available; machine pass/fail and
scorecard criteria remain visible evidence. Harness and artifact-contract failures remain hard
gates.

Always catch post-session verification errors into diagnostic criteria and still emit the
transcript. Use structured successful tool evidence and path-associated helpers instead of raw
event-text matching. Clear seeded notebook execution state and require a clean successful
`run_notebook`. Live mutation requests default to one attempt; add idempotency before explicitly
retrying them, and use run-unique data or baseline deltas when agent self-tests can affect state.
The eval is then runnable via `bun run test:eval <id>`.
