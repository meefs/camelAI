# App usage guard

This Worker queries account-wide Workers Observability spans every five minutes
and evaluates Durable Object SQLite rows read/written by dispatch script. Only
apps successfully deployed through the updated deploy pipeline are eligible;
there is intentionally no backfill.

Production and staging are committed to `enforce`; production configuration is
not deployed as part of this work. Staging was enabled after the 2026-07-13
quarantine/recovery smoke passed. In `enforce` mode, a suspension replaces
the dispatch script with a generated quarantine Worker whose Durable Object
`alarm()` handlers are no-ops. Durable Object namespaces and stored user data
are not deleted. A successful user redeploy is always allowed and starts a
one-hour probation period. Dispatcher registry updates mirror the canonical
D1/runtime state but are best-effort, so a KV outage cannot prevent quarantine.

## Deploy

Deploy the main Worker, dispatcher, and guard from the same revision:

```bash
bun run deploy:main:staging
bun run deploy:dispatcher:staging
bun run deploy:usage-guard:staging
```

Set the guard's `CF_API_TOKEN` as a Wrangler encrypted secret in each
environment. The token needs Workers telemetry query access and permission to
read/update scripts in the configured dispatch namespace.

Do not deploy production from this task. The production flag is prepared in
source control only; staging remains the proving ground.

The staging smoke used a one-second self-rearming SQLite alarm. Its counter
reached 117 before quarantine, remained exactly 117 after recovery, and its
sentinel row remained `preserved`. The replacement contained the same Durable
Object class binding and no migration. Staging KV propagation lagged the runtime
replacement, so the quarantine Worker itself serves the full suspension notice
and headers instead of relying solely on the dispatcher registry.

## Verification

```bash
bunx wrangler deploy -c workers/app-usage-guard/wrangler.jsonc --env staging --dry-run
bun run test:workers -- app-usage-guard direct-dispatch-deploy
bun run check:db-query-runner-source
```

The D1 tables are created idempotently by each cron run and are also described
in `migrations/0002_app_usage_guard.sql`. `app_usage_guard_events` is the audit
log; `app_usage_guard_evaluations` stores the non-zero windows used by policy;
`app_usage_guard_state` is the current per-app state, and
`app_usage_guard_health` records cron success and failure.
