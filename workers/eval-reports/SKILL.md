# Running agent evals

camelAI agent evals **run locally** in a `qaml-ai/chiridion-app` checkout — there is no remote
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

## Report a run here

Set `EVAL_REPORT=1` on the run and the reporter (`scripts/report-eval-run.mjs`) uploads the
transcript artifact, the output log, and the run metadata when the eval finishes — pass or fail:

```bash
EVAL_REPORT=1 bun run test:eval deploy-fake-data-live
```

Reporting is best-effort and never fails the eval. Re-report an artifact by hand:

```bash
node scripts/report-eval-run.mjs --eval <id> --artifact .eval-artifacts/<id>.json [--log <file>]
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
| `GET /api/runs?limit=` | List reported runs (newest first) |
| `GET /api/runs/:id` | Run record (status, evaluation criteria/scorecard, signal, deployed apps) |
| `GET /api/runs/:id/log` | The run's captured output log |
| `GET /api/runs/:id/artifacts` | Transcript artifact filenames |
| `GET /api/runs/:id/artifact/:name` | Transcript JSON |
| `PUT /upload/:id/log`, `PUT /upload/:id/artifacts/:name`, `POST /upload/:id/complete` | Used by the reporter |
| `GET /skill` | This document |

A run is `completed` or `failed` (exit code, or any failed pass/fail criterion). The dashboard at
`https://evals.camelai.dev/` renders scorecards, transcripts, and logs.

## Adding a new committed eval

Add `workers/main/tests/evals/<id>.test.ts` (gated on `RUN_AGENT_EVALS === "1"`, ending in
`emitEvalTranscript({...})`) and register it in `workers/main/tests/evals/manifest.json`. It is then
runnable via `bun run test:eval <id>`.
