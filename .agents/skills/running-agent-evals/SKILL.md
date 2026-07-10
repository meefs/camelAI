---
name: running-agent-evals
description: Run camelAI agent evals locally and report results to the shared viewer at evals.camelai.dev. Use when asked to run an eval, run a custom-prompt eval, check eval results/scorecards, or hit the evals API. The full, always-current reference is served by the viewer itself at GET /skill.
---

# Running agent evals

Evals **run locally in this repo** (they need Docker + a `.dev.vars`); the shared history lives at
**`https://evals.camelai.dev`** (read-only viewer + upload API, behind Cloudflare Access). The full,
always-current reference is **served by the viewer itself** at `GET /skill`.

## Run an eval

```bash
bun run test:eval <eval-id>            # ids: workers/main/tests/evals/manifest.json
bun run test:eval:dashboard            # or :deploy / :sandbox shortcuts

# custom prompt (the generic harness):
CUSTOM_EVAL_PROMPT="Build a dashboard from fake data." bun scripts/run-agent-eval.mjs custom-prompt-live
```

Knobs: `--model <id>`, `--timeout-ms <ms>`, `EVAL_REAL_DEPLOY=0/1`, `CUSTOM_EVAL_*` (see
`bun scripts/run-agent-eval.mjs --help`).
`CHIRIDION_DEV_VARS_PATH` / `.dev.vars` are read only for eval-relevant Cloudflare Access,
Cloudflare API, and judge gateway credentials/settings; ordinary eval knobs such as `EVAL_MODEL`
and `EVAL_REPORT` should be passed explicitly in the shell or CLI.

When `scripts/run-eval-suite.sh` runs a list or `all`, it automatically mints one
`EVAL_BATCH_ID` and default `EVAL_BATCH_LABEL` for the whole invocation. Pre-set those env vars to
join a run into an existing dashboard batch.

Captured artifacts include an advisory `llmJudge` block by default when Cloudflare AI Gateway
credentials are available. The default judge is fixed to `openai/gpt-5.5` on the `compat` route
with high reasoning. It is blind to deterministic pass/fail, then records agreement after judging;
it never changes deterministic pass/fail. Set `EVAL_LLM_JUDGE=0` to disable it, or override with
`EVAL_JUDGE_MODEL`, `EVAL_JUDGE_GATEWAY_PROVIDER`, or `EVAL_JUDGE_REASONING_EFFORT`.

## Add or update an eval

Committed evals are listed in `workers/main/tests/evals/manifest.json`. Each entry requires
`kind`: use `unit` for a one-mechanism check and `skill` for end-to-end agent ability. Keep
scorecard budgets aligned with the dashboard weighting convention: unit evals 1-5 pts, skill evals
6-20 pts scaled to task complexity. Pass/fail criteria are still the hard contract; scorecard
points never gate pass/fail by themselves. Use optional `tier: "hard"` for deterministic
high-difficulty evals and optional `realDeploy: true` when the eval requires the testing-grounds
deploy path.

Author evals with these guardrails:

- Always reach `emitEvalTranscript({...})`. Catch post-session/live-verification errors into
  diagnostic criteria and transcript details instead of throwing before emission.
- Use structured runtime evidence from `project-eval-helpers.ts`. Associate expected paths with
  the specific invocation (`toolCallReferences`), and require successful result evidence where
  outcome matters (`hasSuccessfulNotebookRun`); never hard-gate on serialized event substrings.
- Clear seeded notebook execution state, require a successful clean `run_notebook`, and reject
  persisted error outputs. Seed data-analysis fixtures with `resetNotebookExecution: true`.
- Use `fetchJsonWithRetry`/`fetchWithRetry` for live checks. Mutations default to one attempt to
  avoid replaying a committed request after a lost response; add idempotency before explicitly
  retrying them. Isolate harness-created data with run-unique values or baseline deltas when the
  agent may have tested the API itself.

## Run a matrix

```bash
bun run test:eval:matrix -- --models sonnet,deepseek-v4-flash --evals do-backed-project-deploy-live --repeat 3
```

The matrix runner writes `<artifact-dir>/matrix-summary.json` with per-run status, artifact path,
report URLs, score, signal, judge agreement/usage metadata, and the shared batch id. It includes
and prints the batch dashboard URL only when `EVAL_REPORT=1`, the invocation is not a dry run, and
at least one child report was uploaded successfully. It also sets one `EVAL_BATCH_ID` and default
label for every child run; pre-set `EVAL_BATCH_ID` / `EVAL_BATCH_LABEL` to override.

## Report the run to the shared viewer

Set `EVAL_REPORT=1` and the run's log and metadata are uploaded when it finishes; the transcript
artifact, including its scorecard, is included when the eval emitted it:

```bash
EVAL_REPORT=1 bun run test:eval <eval-id>
```

The final `POST /upload/:runId/complete` is retried up to three times with the same run id so a
transient index or canonical-write failure can finish its idempotent reconciliation.
Artifactless harness failures are still reported and ingest synthesizes an `evaluation_contract`
failure so they remain visible in the dashboard.

Auth for the upload (and for reading the API): everything on `evals.camelai.dev` is behind
Cloudflare Access. Either export a service token (`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`,
the `evals-ci` token in Zero Trust → Access → Service Auth), or log in once with
`cloudflared access login https://evals.camelai.dev` — the reporter picks up either automatically.

Re-report an existing artifact by hand:

```bash
node scripts/report-eval-run.mjs --eval <id> --artifact <file> \
  [--batch <id>] [--batch-label <text>] [--kind unit|skill] [--tier hard] \
  [--description <text>]
```

The extra flags map directly to `run.json`: `batchId`, `batchLabel`, `kind`, `tier`, and
`description`. The uploaded artifact is still the source of `startPrompt`.

## Read results from the CLI

```bash
curl -s https://evals.camelai.dev/api/runs?limit=20 \
  -H "cf-access-token: $(cloudflared access token -app=https://evals.camelai.dev)"
# or with a service token:
#   -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

`GET /skill` documents the rest (`/api/runs/:id`, `/log`, `/artifacts`, `/artifact/:name`).
Run JSON may include `batchId`, `batchLabel`, `kind`, `tier`, `description`, `exitCode`, `error`,
`signal.violations`, and ingest-derived `startPrompt`. A failed run without a failed criterion is
shown using `run.error`, then signal violations, then a nonzero-exit fallback. The dashboard is at
`https://evals.camelai.dev/` (log in with an `@camelai.com` email) and defaults to Batches, with
Runs and Evals switcher views plus batch pages at `/batches/:id`.
