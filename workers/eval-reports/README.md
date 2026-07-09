# chiridion-eval-reports

Shared results store + viewer for **camelAI agent evals** at `evals.camelai.dev`. Evals themselves
run **locally** in a chiridion-app checkout (`bun run test:eval <id>` — they need Docker and a
`.dev.vars`); with `EVAL_REPORT=1` the reporter uploads each finished run here, so the team keeps
one history of scorecards, transcripts, and logs without any remote runner infrastructure.

This replaced the retired `qaml-ai/camelai-eval-runner` VM control plane (queue + dispatcher +
tunnel + SQLite). There is no queue and nothing executes remotely — runs arrive here only after
they finish.

```
bun run test:eval <id>  (locally: docker build + Miniflare eval)
   └─ EVAL_REPORT=1 → scripts/report-eval-run.mjs
        PUT  /upload/<runId>/artifacts/<eval>.json     (transcript)
        PUT  /upload/<runId>/log                       (captured output)
        POST /upload/<runId>/complete                  (metadata → run.json, scorecard ingest)
                     │
                     ▼
   chiridion-eval-reports Worker @ evals.camelai.dev  (behind Cloudflare Access)
        R2 (chiridion-eval-reports): runs/<runId>/{run.json, output.log, artifacts/}
        read-only dashboard + JSON API
```

## Layout

- `src/index.ts` — Worker: upload endpoints, read API, and static asset fallback. All routes re-validate the
  Cloudflare Access JWT (`src/access.ts`); there are **no worker secrets** — uploads authenticate
  with an Access service token, humans with their Access login.
- `src/ingest.ts` — folds transcript artifacts into the run record at report time (pass/fail
  criteria, scorecard, signal, deployed apps; synthesizes a contract failure when an artifact
  carries no valid evaluation).
- `index.html`, `app/`, `vite.config.ts` — Vite-built React SPA dashboard. It imports the main
  app's shadcn primitives from `src/components/ui` and shared theme tokens from
  `src/styles/shadcn-theme.css`.
- `SKILL.md` — usage doc, self-served at `GET /skill` (single source of truth).
- The reporter lives with the eval runner: `scripts/report-eval-run.mjs`, invoked automatically by
  `scripts/run-agent-eval.mjs` when `EVAL_REPORT=1`.

## Storage

One R2 prefix per run: `runs/<runId>/run.json` (the record the API serves), `output.log`,
`artifacts/<eval>.json`. Run ids embed a UTC timestamp, so listing the prefixes in reverse order
is newest-first — no database.

## Deploy

Pushes to `main` **auto-deploy** via a Cloudflare Workers Build (trigger "Deploy eval-reports on
main", deploy command `bun run deploy:eval-reports`) — the same Git integration the other chiridion
workers use. Deploy by hand when needed:

```bash
bun run deploy:eval-reports          # vite build, then deploy dist/chiridion_eval_reports/wrangler.json
```

One-time setup (already done for the production deployment; kept here for reference / re-setup):

1. Create the R2 bucket `chiridion-eval-reports`.
2. Cutover from the old VM control plane: delete the `evals.camelai.dev` Cloudflare **Tunnel DNS
   record** so the worker's custom domain can attach; keep the existing **Access application**
   (same hostname, same AUD — `CF_ACCESS_AUD` in `wrangler.jsonc`). The old VM services
   (`camelai-evals`, `cloudflared`) can be stopped and the box downsized/retired. Old runs stay in
   the VM's SQLite; they are not migrated.
3. Add a Workers Build trigger on `main` for auto-deploy (Cloudflare dashboard → the worker →
   Settings → Build, or via the account's existing `qaml-ai/chiridion-app` repo connection).

## Local dev

```bash
bun run dev:eval-reports             # Vite + Worker on http://localhost:8789
# report a run into it:
EVAL_REPORT_BASE=http://localhost:8789 node scripts/report-eval-run.mjs --eval <id> --artifact <file>
```

Keep `workers/eval-reports/.dev.vars` with `CF_ACCESS_ENABLED=0` for local development. Typecheck:
`cd workers/eval-reports && bun run typecheck`.
