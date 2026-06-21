---
name: running-agent-evals
description: Run camelAI agent evals via the eval-runner control plane API (evals.camelai.dev) and authenticate past Cloudflare Access from the CLI. Use when asked to start, list, or check eval runs against a branch/commit, run a custom-prompt eval, or hit the evals API. The full, always-current reference is served by the service itself at GET /skill.
---

# Running agent evals

Agent evals run via the eval control plane at **`https://evals.camelai.dev`** (behind Cloudflare
Access). The full, always-current usage + API reference is **served by the service itself** at
`GET /skill`, so it can never drift from the running API — get an Access credential, fetch that
endpoint, and follow what it says.

## 1. Get a Cloudflare Access credential

The service re-validates the Access JWT, so every request (including `/skill`) needs one. Pick one:

- **Service token (scripts / CI — preferred):** the `evals-ci` service token from Cloudflare Zero
  Trust → Access → Service Auth. Source from your secret store (never commit):
  ```bash
  export CF_ACCESS_CLIENT_ID=...        # <id>.access
  export CF_ACCESS_CLIENT_SECRET=...
  ```
- **Interactive user login (humans, `@camelai.com`):**
  ```bash
  cloudflared access login https://evals.camelai.dev
  export CF_ACCESS_TOKEN="$(cloudflared access token -app=https://evals.camelai.dev)"
  ```

## 2. Fetch the reference and follow it

```bash
# service token:
curl -s https://evals.camelai.dev/skill \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
# or user token:
curl -s https://evals.camelai.dev/skill -H "cf-access-token: $CF_ACCESS_TOKEN"
```

That document covers the API (`POST /api/runs`, listing runs, logs, artifacts, cancel, refs), the
request shape, and worked examples. Send the same Access header on every call.

## Local-only alternative (no control plane)

To run an eval directly in this repo without the service:
`RUN_AGENT_EVALS=1 bun run test:eval:dashboard` (or `:deploy` / `:sandbox`), or
`bun scripts/run-agent-eval.mjs custom-prompt-live` with `CUSTOM_EVAL_PROMPT` set.
