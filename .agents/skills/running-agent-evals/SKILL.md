---
name: running-agent-evals
description: Run camelAI agent evals via the eval-runner control plane API and authenticate past Cloudflare Access from the CLI. Use when asked to start, list, or check eval runs against a branch or commit, run a custom-prompt eval, hit the evals API (evals.camelai.dev), or get a Cloudflare Access service/user token for curl. Covers the POST /api/runs request shape and CF-Access-Client-Id/Secret + `cloudflared access` auth.
---

# Running agent evals

The eval runner is a standalone control plane (repo `qaml-ai/camelai-eval-runner`) on AWS that
clones `chiridion-app` at a chosen branch/commit and runs the evals defined here
(`workers/main/tests/evals/*`) on an EC2 pool. You drive it over an HTTP API at
**`https://evals.camelai.dev`**, fronted by a Cloudflare Tunnel + **Cloudflare Access** — so every
request needs an Access credential.

## Getting past Cloudflare Access in the CLI

Pick one of two credential types. The origin re-validates the Access JWT, so there is no way in
without one.

### Service token (scripts / CI — preferred)

A non-interactive token (the `evals-ci` service token in Cloudflare Zero Trust → Access → Service
Auth). Pass it as two headers. **Never commit these values** — source them from your secret store.

```bash
export CF_ACCESS_CLIENT_ID=...      # <id>.access
export CF_ACCESS_CLIENT_SECRET=...
curl -s https://evals.camelai.dev/api/runs \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

### Interactive user login (humans, `@camelai.com`)

```bash
# Browser login once, then mint a short-lived token for the app:
cloudflared access login https://evals.camelai.dev
curl -s https://evals.camelai.dev/api/runs \
  -H "cf-access-token: $(cloudflared access token -app=https://evals.camelai.dev)"

# Or let cloudflared wrap curl and handle auth automatically:
cloudflared access curl https://evals.camelai.dev/api/runs
```

## API

Base URL `https://evals.camelai.dev`. Send the Access headers above on every call.

| Method & path | Purpose |
|---|---|
| `POST /api/runs` | Start a run (returns the run record with `runId`) |
| `GET /api/runs?status=&ref=&limit=` | List runs (recent first) |
| `GET /api/runs/:id` | Run detail (status, signal, token usage, deployed apps) |
| `GET /api/runs/:id/log` | 302 → presigned `output.log` |
| `GET /api/runs/:id/artifact/:name` | 302 → presigned transcript JSON (`:name` = `<eval>.json`) |
| `POST /api/runs/:id/cancel` | Best-effort cancel (stops the instance) |
| `GET /api/refs` | Branches + recent commits of `chiridion-app` |

### `POST /api/runs` body

```jsonc
{
  "ref": "main",                 // required: branch or commit SHA of chiridion-app to evaluate
  // EITHER committed evals:
  "evals": ["deploy-fake-data-live"],   // or ["all"]; ids from workers/main/tests/evals/*
  // OR a custom prompt (not committed to the tree):
  "custom": {
    "prompt": "Build a dashboard from fake data and summarize it.",
    "project": "custom-eval",            // optional
    "expectSubstrings": ["dashboard"]    // optional, lowercase; must appear in the transcript
  },
  "model": "sonnet",             // optional EVAL_MODEL
  "realDeploy": false,           // optional; omitting defaults to ON when CF_API_TOKEN is set
  "maxAssistantTurns": 8,        // optional thresholds
  "maxBadToolCalls": 0,
  "enforceSignal": true,         // fail the run on signal violations
  "timeoutMs": 600000
}
```

Provide exactly one of `evals` or `custom`. Custom prompts run through
`workers/main/tests/evals/custom-prompt-live.test.ts`.

### Examples

```bash
H=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
B=https://evals.camelai.dev

# Custom-prompt eval against a branch
curl -s "${H[@]}" -H 'content-type: application/json' "$B/api/runs" -d '{
  "ref":"my-branch",
  "custom":{"prompt":"Build a dashboard from fake data.","expectSubstrings":["dashboard"]},
  "model":"sonnet","realDeploy":false }'

# Committed eval against a commit, real deploy on
curl -s "${H[@]}" -H 'content-type: application/json' "$B/api/runs" \
  -d '{"ref":"<sha>","evals":["deploy-fake-data-live"],"realDeploy":true}'

curl -s "${H[@]}" "$B/api/runs?limit=20"      # list
curl -s "${H[@]}" "$B/api/runs/<id>"          # detail
curl -sL "${H[@]}" "$B/api/runs/<id>/log"     # output.log (follow the redirect)
```

A run goes `queued → dispatching → running → completed | failed` (poll `GET /api/runs/:id`).
There is also a dashboard at `https://evals.camelai.dev/` (log in with an `@camelai.com` email).

## Notes

- The convenience client `scripts/eval-run.mjs` (`bun run eval ...`) lives in the
  `camelai-eval-runner` repo and reads `EVAL_API_BASE` + `CF_ACCESS_CLIENT_ID/SECRET`.
- To run an eval locally instead (no control plane): `RUN_AGENT_EVALS=1 bun run test:eval:dashboard`
  (or `:deploy` / `:sandbox`), or `bun scripts/run-agent-eval.mjs custom-prompt-live` with
  `CUSTOM_EVAL_PROMPT` set.
- Adding a new committed eval = add a test under `workers/main/tests/evals/` and register it in
  `scripts/run-agent-eval.mjs`; it then becomes selectable via `evals: ["<name>"]`.
