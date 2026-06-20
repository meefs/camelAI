# AWS eval runner

Live agent evals run on a stopped EC2 pool instead of your laptop. The **control plane** that
drives the pool (dashboard + API + dispatch, on AWS) lives in its own repo,
**[`qaml-ai/camelai-eval-runner`](https://github.com/qaml-ai/camelai-eval-runner)**. It clones
*this* repo at a chosen branch/commit per run and executes the evals defined here. This page
covers only the parts that live in `chiridion-app`.

## What lives here

- **The evals**: `workers/main/tests/evals/*` — including the generic `custom-prompt-live.test.ts`
  (driven by `CUSTOM_EVAL_PROMPT` / `CUSTOM_EVAL_PROJECT` / `CUSTOM_EVAL_EXPECT_SUBSTRINGS`, plus
  the usual `EVAL_MODEL` / `EVAL_MAX_*` / `EVAL_REAL_DEPLOY` knobs).
- **In-tree single-eval runner**: `scripts/run-agent-eval.mjs <eval-name>` (used locally and by
  the on-instance runner). `bun run test:eval:dashboard` / `:deploy` / `:sandbox` wrap it.
- **On-instance suite runner**: `scripts/run-eval-suite.sh` — the control plane clones this repo
  onto a pool instance and runs this script, which builds the sandbox image and runs the eval(s),
  writing `status.json` + artifacts to a local dir. It is **cloud-agnostic** — it assumes `.dev.vars`
  is already present and never calls AWS. Secrets delivery and result upload are the control plane's
  job (see below).

## How a control-plane run reaches these

`camelai-eval-runner` (always-on EC2 host) → picks a stopped pool instance → SSM preflight clones
`chiridion-app` at the requested ref, writes `.dev.vars` (from Secrets Manager), and runs
`scripts/run-eval-suite.sh` → the preflight then uploads `runs/<id>/…` to S3 → the control plane
ingests the result. All AWS calls (Secrets Manager, S3, instance start/stop) live in the control
plane, not here. See that repo's README for deploy + Cloudflare setup. The pool
(`camelai:eval-pool=true`) and results bucket are provisioned by its Terraform.

`camelai-eval-sandbox:latest` is rebuilt on each run so changes to
`workers/main/eval-sandbox.Dockerfile` or `sandbox/create-worker` are picked up; Docker layer cache
keeps it fast.

## Running an eval locally

```bash
RUN_AGENT_EVALS=1 bun run test:eval:dashboard   # or :deploy / :sandbox
# custom prompt:
RUN_AGENT_EVALS=1 CUSTOM_EVAL_PROMPT="Build a dashboard from fake data." \
  bun scripts/run-agent-eval.mjs custom-prompt-live
```
