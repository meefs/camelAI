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

Captured artifacts include an advisory `llmJudge` block by default when Cloudflare AI Gateway
credentials are available. The default judge is fixed to `openai/gpt-5.5` on the `compat` route
with high reasoning. It is blind to deterministic pass/fail, then records agreement after judging;
it never changes deterministic pass/fail. Set `EVAL_LLM_JUDGE=0` to disable it, or override with
`EVAL_JUDGE_MODEL`, `EVAL_JUDGE_GATEWAY_PROVIDER`, or `EVAL_JUDGE_REASONING_EFFORT`.

## Run a matrix

```bash
bun run test:eval:matrix -- --models sonnet,deepseek-v4-flash --evals do-backed-project-deploy-live --repeat 3
```

The matrix runner writes `<artifact-dir>/matrix-summary.json` with per-run status, artifact path,
report URLs, score, signal, and judge agreement/usage metadata.

## Report the run to the shared viewer

Set `EVAL_REPORT=1` and the run (artifact, log, scorecard) is uploaded when it finishes:

```bash
EVAL_REPORT=1 bun run test:eval <eval-id>
```

Auth for the upload (and for reading the API): everything on `evals.camelai.dev` is behind
Cloudflare Access. Either export a service token (`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`,
the `evals-ci` token in Zero Trust → Access → Service Auth), or log in once with
`cloudflared access login https://evals.camelai.dev` — the reporter picks up either automatically.

Re-report an existing artifact by hand: `node scripts/report-eval-run.mjs --eval <id> --artifact <file>`.

## Read results from the CLI

```bash
curl -s https://evals.camelai.dev/api/runs?limit=20 \
  -H "cf-access-token: $(cloudflared access token -app=https://evals.camelai.dev)"
# or with a service token:
#   -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

`GET /skill` documents the rest (`/api/runs/:id`, `/log`, `/artifacts`, `/artifact/:name`).
The dashboard is at `https://evals.camelai.dev/` (log in with an `@camelai.com` email).
