# Deployed App Durable Object Usage Guard

## Status

Implemented on 2026-07-13 and deployed to staging with enforcement enabled after
a live quarantine/recovery smoke. New
deploys are enrolled going forward; existing apps remain unmonitored until they
are redeployed. Production must remain observe-only until staging has verified
trace coverage and reversible quarantine across real Workers for Platforms
apps. Production is configured for enforcement in source but must not be
deployed as part of this work. Operational commands and rollout gates live in
`workers/app-usage-guard/README.md`.

## Goal

Bound the amount one deployed user app can spend through Durable Objects,
especially SQLite row writes/reads caused by runaway alarms, while:

- attributing usage to the correct org, workspace, and app;
- stopping both public traffic and background Durable Object alarms;
- preserving the app's source, last deploy artifact, and Durable Object data;
- avoiding false suspensions when Cloudflare analytics is late or incomplete;
- giving operators an auditable, reversible recovery path.

This is an account-level guard, not a billing feature. Initial thresholds are
platform safety limits shared by all plans. Plan-specific allowances and user
charges can be added later without changing the collection/enforcement model.

## Why a dispatcher-only block is insufficient

The dispatcher can stop new HTTP traffic, but a Durable Object alarm invokes the
user Worker independently. An app blocked only at the dispatcher can therefore
continue spending indefinitely.

Cloudflare does not expose an account API that cancels every alarm in a Durable
Object namespace. Deleting a dispatch script can also delete its associated
Durable Object namespaces when forced, which destroys user data. The normal
enforcement action should consequently be a two-layer suspension:

1. **Control-plane block:** mark the app suspended. The dispatcher immediately
   returns a platform-owned 503 page. Deploys remain available so the owner can
   publish a fix.
2. **Runtime quarantine:** upload a generated replacement version under the same
   dispatch script name. It exports safe replacements for every user-owned
   Durable Object class, makes `alarm()` a no-op, and returns 503 from request
   entrypoints. Existing namespaces and their storage are retained. An already
   queued alarm may fire once against the quarantine version, but cannot re-arm
   itself.

Forced script deletion is an emergency fallback only. It must require an admin
action, state that Durable Object data can be lost, and record whether
`force=true` was used.

## Placement

Create a small independent Worker under `workers/app-usage-guard/` rather than
adding this to the main application Worker.

- Cron: every five minutes in production and staging; no schedule in local dev.
  This runs one account-wide aggregate query (or a small bounded number when
  pagination is necessary), not one Cloudflare API request per app.
- Bindings: the existing `APP_DB` D1 database, `R2_BUCKET` for reading the deploy
  artifact cache, `OBSERVABILITY_EVENTS` / `ERROR_ANALYTICS`, and an optional
  alarm-storm queue consumer fed by `workers/user-logs-tail/`.
- Secrets: a dedicated Cloudflare API token with Workers Observability access
  and Workers Scripts Write for the relevant account. Cloudflare currently
  documents the telemetry endpoint under `Workers Observability Write`; verify
  the least privilege accepted by the live API before rollout. Do not reuse a
  general token if a narrower token is available.
- Configuration: account id, dispatch namespace, environment, policy version,
  and observe/enforce mode.

Keeping the guard separate gives it a small failure domain, a narrow token, and
an independently disableable cron. It must use D1 leases, not its own Durable
Object alarms.

## Existing sources of truth

The current repo already provides most identity data:

- `apps` in `APP_DB` contains `app_id`, `script_name`, `org_id`, `workspace_id`,
  and joins to `orgs.slug`.
- The deployed Workers for Platforms script name is
  `{script_name}--{org_slug}`.
- `worker_scripts.artifact_cache_key` in `OrgDO`, with append-only
  `worker_script_deploys`, identifies restorable artifacts.
- The deploy artifact cache in R2 stores the original modules, metadata,
  bindings, assets, and identity needed for rollback.
- `APP_KV` is the dispatcher's current access registry.

The guard should enumerate apps from D1 in pages. It should not wake every
`OrgDO` on every run. Missing org slugs or stale index rows are reconciliation
errors: refresh the individual org/app, record an error, and do not enforce that
app from an ambiguous identity.

## Usage collection

Use Cloudflare's Workers Observability telemetry query API as the primary
source. Automatic Durable Object SQL spans expose the exact numeric fields
`cloudflare.durable_object.response.rows_read` and
`cloudflare.durable_object.response.rows_written`. Group by both
`cloudflare.script_name` and `cloudflare.script_version.id`, then match the exact
version enrolled by the deploy pipeline. This prevents equal dispatch script
names in staging and production from being combined. Every five minutes, query an
overlapping window with `view=calculations`, `sum` both fields, group by
`cloudflare.script_name`, and set `ignoreSeries=true`. Map returned script names
to the D1 app inventory; discard known platform Workers and alert on every
unattributed non-zero group.

The telemetry endpoint accepts at most 2,000 group rows. Normally one query is
enough. If the result reaches the limit, continue with `offsetBy`, and also issue
independent top-rows-read and top-rows-written queries so a write-heavy app
cannot be displaced by read-heavy groups. This remains a bounded number of
account-wide calls rather than per-app polling.

Cloudflare's documented global REST limit is 1,200 requests per five minutes per
user/account token, plus 200 requests per second per IP. A normal guard cycle
uses one request, so this is comfortably below the limit even with pagination.
Still read the `Ratelimit`/`Ratelimit-Policy` headers, honor `Retry-After`, add
jitter, and fail the window closed for enforcement rather than retrying in a
tight loop.

Do not rely on `$workers.dispatchNamespace` in the metric query. The field is
present on invocation log events, but the staging API returned an internal
error when it was combined with the Durable Object child-span counters. Script
name plus the canonical D1 inventory is the working attribution seam. Adding a
stable Cloudflare script tag containing `app_id` remains desirable once the
query backend supports grouping that field reliably.

Tracing must be a platform-owned deploy invariant. `direct-dispatch-deploy.ts`
currently passes through a project's `observability` metadata, so a project can
omit or disable the spans. Change direct deploy and rollback to merge the user's
log preferences while forcing `observability.traces.enabled=true` and a
platform-selected head sampling rate. After Cloudflare confirms a successful
upload, record that deployment's script version, effective sampling rate, and
`usage_guard_eligible_at` timestamp.

Do not backfill or mutate existing dispatch scripts. Apps deployed before this
change are `unmonitored` and exempt from automatic enforcement until their next
successful deploy or rollback goes through the updated pipeline. The app/admin
UI should show that state explicitly. Telemetry from an unmonitored app may be
retained for observe-only analysis, but it cannot trigger a warning or
suspension. This intentionally leaves legacy runaway apps outside the automatic
guard until they are redeployed.

Start enforcement with `head_sampling_rate=1`. In the staging sampling spike, a
script configured at `0.1` produced no persisted row-counter spans after 200
successful SQL invocations and the same wait used for the full-sampling probe.
That behavior may be an implementation detail or beta limitation, but it makes
sampled traces unsuitable for this safety decision. Revisit sampling only after
Cloudflare documents the semantics and another controlled test proves a
conservative confidence bound. Trace event volume and its Cloudflare cost are
rollout metrics.

The existing `workers/user-logs-tail/` remains useful but is not the row-counter
source. A staging probe showed that its classic `tail()` payload contains the
script name, Durable Object id/entrypoint, handler type (including `alarm`), CPU,
wall time, logs, and exceptions, but `diagnosticsChannelEvents` was empty and no
automatic SQL spans or row counters were delivered. It can cheaply emit an
alarm-storm signal by script name, prompting an immediate telemetry query; it
must not write those signals through `WorkerLogsDO`.

This guard intentionally focuses on SQLite SQL row reads/writes. Hidden-KV and
`kv.list()` accuracy are out of scope for the first version. They can be added
later from GraphQL billing reconciliation without delaying the runaway-alarm
guard.

### Verified staging spike (2026-07-13)

A disposable Workers for Platforms script in
`chiridion-platform-staging` created 1,000 SQLite rows, scanned them, and ran an
alarm. The account-wide telemetry query returned that script as its own group
with 4,002 rows read and 1,002 rows written, matching the controlled workload.
The same trace attributes were absent from the attached classic Tail Worker
payload. The script, Tail Worker, and test Durable Object storage were deleted
after the test. A second disposable script tested 200 SQL invocations with a
10% trace rate; the telemetry aggregate remained empty, so the design requires
100% tracing for enforcement.

### GraphQL reconciliation

The GraphQL Analytics API is optional slower billing reconciliation, not a
dependency of the SQLite safety guard. Query the entire dispatch namespace in
one grouped request hourly (and a full prior-day reconciliation daily); never
issue one query per app.

Relevant datasets are expected to be:

- `durableObjectsStorageGroups` for stored bytes and SQLite storage operations;
- `durableObjectsInvocationsAdaptiveGroups` for requests/alarm invocations;
- `durableObjectsPeriodicGroups` for duration/CPU-related signals;
- `workersInvocationsAdaptive` for app request diagnostics and cross-checking
  dispatch script attribution.

Cloudflare explicitly documents these Durable Object datasets but directs
clients to GraphQL introspection for their current fields. Before implementing
the reconciliation query, check the live schema and save a fixture containing
the exact dimensions and aggregate fields. In particular, verify the names and
semantics of rows-read, rows-written, billable duration, namespace id, class
name, script name, and dispatch namespace dimensions.

Preferred attribution is the defining dispatch `scriptName` plus
`dispatchNamespaceName`. If the storage dataset exposes only Durable Object
namespace ids, build a mapping by reading each dispatch script's bindings and
map only namespaces defined by that user script. Do not charge shared platform
bindings such as virtual data, connections, or R2 services to a user app.

Add a stable Cloudflare script tag containing the D1 `app_id` on every future
deploy. Tags are useful for reconciliation, but deterministic script name plus
the D1 inventory remains the source of truth for old deploys.

### Incremental windows and completeness

Store five-minute UTC buckets and upsert them by `(app_id, bucket_start,
policy_version)`. Each run queries `[now - 25m, now - 5m]`; the overlap absorbs
telemetry ingestion delay and idempotently re-evaluates prior buckets. Tune the
five-minute watermark downward only from staging measurements, never by
assuming a missing result is current. Optional hourly GraphQL reconciliation
queries
`[last_reconciled_bucket - 15m, now - ingestion_lag]` and replaces provisional
counters when that source is complete.

Only mark a bucket complete when:

- the telemetry query returned successfully, every aggregate page was consumed,
  the window ended behind the measured ingestion watermark, and every deployed
  app being evaluated has a recorded eligible script version whose effective
  trace configuration was audited at deployment; require query
  `statistics.abr_level=1` until higher Adaptive Bit Rate levels are tested and
  conservatively weighted;
- GraphQL returned without top-level or partial-field errors, every page was
  consumed, and the result stayed below API row/group limits, for reconciled
  decisions;
- every non-zero usage group was attributed or explicitly classified as a
  platform namespace.

Never treat a missing, partial, sampled-without-a-bound, or stale query as zero.
A positive exact counter can trigger enforcement even if unrelated events were
lost; absence of usage cannot prove zero until the eligible deployment's trace
coverage audit passes.
Compare Tail alarm/invocation totals with telemetry totals and alert on sustained
coverage drift.

## Cost model and initial policy

Evaluate both raw counters and estimated gross marginal cost. Gross cost uses
Cloudflare's published overage rates and deliberately ignores the account's
shared included pool, so one app cannot consume the pool invisibly:

```text
estimated_cost_usd =
    rows_written / 1,000,000 * 1.00
  + rows_read    / 1,000,000 * 0.001
  + do_requests  / 1,000,000 * 0.15
  + do_gb_seconds / 1,000,000 * 12.50
```

Rates are versioned configuration, not hard-coded facts. The July 2026 paid
rates and included amounts are documented in Cloudflare's
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#durable-objects).

Start with the following conservative safety policy in observe-only mode:

| Window | Warn | Suspend candidate | Catastrophic immediate candidate |
| --- | ---: | ---: | ---: |
| 15 minutes | $0.50 | $1.00 | $5.00 |
| 1 hour | $1.00 | $2.00 | $10.00 |
| 24 hours | $2.50 | $5.00 | $25.00 |

Also create a suspend candidate at `1,000,000` rows written in 15 minutes even
if a future pricing configuration is missing. This directly catches the most
expensive and common failure mode.

These are initial platform-risk numbers, not promises to customers. Run the
guard observe-only for at least two weeks, plot p50/p95/p99/max by metric and app,
then set the final defaults using real usage and an explicit maximum-loss
budget. Exempt internal/eval apps explicitly with an expiry; never exempt by a
name prefix hidden in code.

### Decision rules

- Warn at the warning threshold and send at most one notification per app per
  24 hours for the same policy/version.
- A normal suspension requires two consecutive complete evaluations above a
  suspend threshold. This filters late corrections and transient spikes.
- A catastrophic threshold can suspend after one complete evaluation.
- If the account-wide total crosses an independently configured emergency
  budget, stop automatic per-app decisions and page an operator unless one app
  is unambiguously responsible. This avoids mass suspension after an attribution
  or pricing bug.
- Quiet usage after suspension never auto-resumes the app; a quarantined app is
  quiet by construction.

The decision record must contain the raw counters, window boundaries, estimated
cost components, analytics query id/time, policy version, and the exact rule
that fired.

### Operational timelines

- **Collection cadence:** every 5 minutes, with a 5-minute ingestion watermark
  and 25-minute overlapping query. Expected visibility is therefore 5–10 minutes
  after the costly invocation; alert if the newest complete window is over 20
  minutes old.
- **Warning:** sent on the first complete window above a warn threshold, normally
  within 10 minutes. Repeat at most once per 24 hours for the same policy.
- **Normal suspension:** two consecutive complete evaluations above threshold,
  normally 10–15 minutes after sustained abuse. The dispatcher block is written
  first; runtime quarantine should complete within 60 seconds or page an
  operator.
- **Catastrophic suspension:** one complete telemetry evaluation, normally 5–10
  minutes. A Tail Worker alarm-storm signal may trigger an extra telemetry query
  between cron ticks, but cannot suspend from invocation count alone.
- **Suspended:** indefinite until a successful user deploy or an admin action.
  Users may build, upload, redeploy, and roll back throughout suspension.
- **Probation:** 1 hour after every successful recovery deploy. Traffic is live;
  the first new complete suspend-level breach re-quarantines immediately. A
  clean hour returns the app to `active`.
- **Rollout probation:** at least 2 weeks metering-only, then at least 1 week of
  warning/manual-quarantine operation before automatic catastrophic enforcement.
  Normal automatic enforcement follows only after the staging recovery matrix
  and false-positive review pass.

## D1 model

Keep metering and enforcement out of `OrgDO`; this is account-wide analytical
state.

```sql
CREATE TABLE app_usage_buckets (
  app_id TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  bucket_end INTEGER NOT NULL,
  rows_read INTEGER NOT NULL,
  rows_written INTEGER NOT NULL,
  do_requests INTEGER NOT NULL,
  alarm_invocations INTEGER NOT NULL,
  do_gb_seconds REAL NOT NULL,
  worker_requests INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  source_complete INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  PRIMARY KEY (app_id, bucket_start, policy_version)
);

CREATE TABLE app_enforcement_state (
  app_id TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- unmonitored|active|warned|suspending|suspended|release_pending|probation|error|exempt
  revision INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  eligible_script_version TEXT,
  usage_guard_eligible_at INTEGER,
  trace_audited_at INTEGER,
  reason_code TEXT,
  decision_json TEXT,
  first_exceeded_at INTEGER,
  warned_at INTEGER,
  suspended_at INTEGER,
  suspended_dispatch_modified_on TEXT,
  suspended_from_artifact_cache_key TEXT,
  quarantine_attempts INTEGER NOT NULL DEFAULT 0,
  quarantine_verified_at INTEGER,
  exemption_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE app_enforcement_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL, -- cron|admin|user|deploy
  actor_id TEXT,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE app_usage_guard_leases (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
```

Add indexes for bucket retention scans and enforcement status. Retain detailed
five-minute buckets for 45 days, then daily rollups for at least 13 months.

Mirror only the user-facing suspension summary into the existing app surfaces:
extend the D1 app summary and the `OrgDO` worker-script record with status,
reason, and timestamp, or expose a single batched D1 join. Do not duplicate
meter buckets into every `OrgDO`.

## Suspension state machine

```text
unmonitored --successful deploy--> active

active -> warned -> suspending -> suspended -> release_pending -> probation -> active
                         |             |              |              |
                         +-----------> error <---------+--------------+
```

1. Acquire a D1 lease for the cron run and use a conditional update on the app
   state's `revision` to claim `suspending`.
2. Persist the full decision and original artifact cache key before changing
   external state.
3. Write `suspended` into the dispatcher registry. The dispatcher checks this
   before public/private auth and returns a platform 503 with `Retry-After` and
   a request id. Do not overload `is_public=false`; private and suspended are
   different states.
4. All deploy entrypoints check the canonical enforcement state and participate
   in the same per-app operation lease as quarantine. This includes direct
   deploy, rollback, and the legacy Cloudflare proxy path. A suspended app is
   allowed to deploy; `suspending` only produces a short retryable response while
   the quarantine mutation is being finalized.
5. Read the live script settings/bindings and download the current script
   content before replacing it. Save that snapshot to R2 if it is not already
   represented by a verified artifact-cache record. Use the live user-owned
   Durable Object class names to generate a quarantine ES module that exports a
   safe class for each name, plus safe request/RPC entrypoints. Reuse compatible
   metadata and bindings, omit new destructive migrations, and upload under the
   same dispatch script name.
6. Do not call normal deploy side effects and do not replace the app's
   `artifact_cache_key`: the last user artifact is the recovery artifact, not
   the quarantine bundle.
7. Fetch script details/settings and verify the expected quarantine annotation
   or content hash. Then set `suspended` and notify the owner/admin.

Legacy apps may not have an artifact-cache key. A successful live download and
R2 snapshot is therefore a prerequisite to automatically replacing them. If the
guard cannot make and verify that snapshot, it leaves the dispatcher block in
place, marks the runtime quarantine as `error`, and pages an operator; it does
not force-delete the script.

### Deployment races

User deploys and quarantine uploads take the same short-lived per-app D1 lease
before calling Cloudflare. If a user deploy already holds the lease, the guard
does not suspend that version mid-upload; it re-evaluates the newly deployed
version on the next complete analytics window. If quarantine holds the lease,
the deploy endpoint returns a retryable conflict with `Retry-After` rather than
rejecting the deploy.

There is still a legacy/in-flight race for uploads that began before this lease
was introduced. Record Cloudflare's `modified_on`/version before suspension,
make quarantine the final upload, and verify afterward. If verification observes
a later unknown version, reconcile it as a user deploy: verify the deploy,
transition to probation, and do not overwrite it blindly. Every step is
idempotent from `app_id + state revision`.

### Quarantine validation gate

The quarantine approach is recommended but must be proven in staging before it
can enforce:

- an app with one and multiple SQLite DO classes;
- an already scheduled alarm, including an alarm that immediately re-arms;
- preservation of SQL and hidden KV data across quarantine and release;
- apps with assets, named entrypoints, service bindings, and no DOs;
- upload with the existing migration state but no destructive migration;
- successful restoration/redeploy without changing namespace ids;
- a deploy racing suspension.

If Cloudflare rejects a generated replacement without a destructive migration,
automatic enforcement must stop at dispatcher blocking and page an operator.
Do not silently fall through to forced deletion.

## Release and recovery

Suspension is not cleared merely because a user visits the app or retries the
same HTTP request. A successful deployment is the recovery action.

- The app UI shows the offending window and metrics, links to guidance on
  indexing/bounded queries/alarm cadence, and asks the owner to deploy a fix.
- Owners can use the normal deploy and rollback tools while suspended. The
  dispatcher continues serving the suspension page until Cloudflare confirms
  the upload and normal deploy side effects finish successfully; a failed build
  or upload leaves the quarantine in place.
- After a successful upload, the deploy pipeline places the app in `probation`
  for one hour and re-enables dispatcher traffic. No separate admin approval or
  release token is required.
- Probation uses lower warning thresholds and immediately re-suspends on a new
  complete threshold breach.
- Rolling back to the artifact that triggered suspension is allowed but shows a
  warning and still enters probation; the guard bounds the cost if it is still
  faulty.
- Admins can exempt with a reason and expiry, retry quarantine, or authorize an
  emergency force-delete.

## Failure behavior

- **Telemetry unavailable/stale/partial or trace audit stale:** record guard
  health as degraded; do not make new suspension decisions. Existing
  suspensions remain suspended. GraphQL failure only disables reconciliation.
- **D1 unavailable:** do not call Cloudflare mutation APIs.
- **Dispatcher registry update fails:** record an audit event and continue with
  runtime quarantine. The generated replacement also serves the suspension
  notice, and later registry writes reconcile the dispatcher view.
- **Quarantine upload fails:** keep the dispatcher block, mark `error`, retry
  quickly three times, and page. Continue retrying every 30 minutes after
  escalation because alarms may still be running; only a confirmed quarantine
  or successful user deploy ends the mutation loop.
- **Notification fails:** suspension still succeeds; retry notification from the
  append-only event.
- **Unknown usage group:** count it in account totals, do not assign it to an app,
  and alert on attribution drift.

Emit structured events through `recordObservabilityEvent` conventions (or the
equivalent shared schema in the new Worker): collection duration, source lag,
bucket/group counts, unattributed totals, candidates, transitions, mutation
latency, and errors. Never include app code, request bodies, secrets, or logs.

## Admin and product surfaces

Minimum operational surface before enforcement:

- admin list/filter for unmonitored, warned, suspending, suspended, error,
  exempt, and probation;
- per-app usage graph and decision/audit history;
- retry quarantine, grant expiring exemption, and emergency delete actions;
- user app card/banner showing suspended state and a deploy-fix path;
- email to org owners on warning and suspension;
- account-level guard-health alert when the last complete collection is older
  than 20 minutes or unattributed usage is non-zero.

## Rollout

1. **Telemetry spike (complete):** a real staging dispatch script proved exact
   rows-read/written aggregation by `cloudflare.script_name`; classic Tail did
   not contain the row spans, and a 10%-sampled script produced no usable row
   counters. Record the ingestion-lag distribution during meter-only rollout.
2. **Trace coverage:** force tracing in direct deploy/rollback and add deployment
   tests. Mark only deployments made through that updated path as eligible; do
   not backfill existing production or staging scripts. Audit the effective
   setting before considering an eligible app's zero-usage interval complete.
3. **Meter only:** deploy the account-wide telemetry cron with no mutations. Run
   at least two weeks; measure ingestion lag, sampling behavior, query volume,
   observability cost, coverage drift, false candidates, percentiles, and
   unattributed usage. GraphQL comparison is useful but not a launch blocker.
4. **Warn only:** send internal alerts first, then owner warnings; validate
   deduplication and policy messaging.
5. **Manual quarantine:** operators approve candidates; complete the staging
   quarantine validation matrix and recovery drills.
6. **Automatic catastrophic enforcement:** enable the one-complete-window rule
   first; let alarm-storm Tail signals request an early aggregate query, never a
   suspension by themselves.
7. **Automatic normal enforcement:** enable two-strike 15m/1h/24h rules, with an
   environment kill switch that disables new mutations immediately.

## Tests

- Unit: telemetry query construction/parsing/pagination, sampling confidence
  bounds, deployment eligibility and trace-coverage audit, optional GraphQL
  parsing, late bucket upserts,
  cost calculation, complete-window rules, policy versioning,
  two-strike/catastrophic decisions, exemption expiry, and state transitions.
- Worker integration: D1 lease contention, idempotent retries, stale revisions,
  dispatcher response, deploy/quarantine serialization, queue deduplication,
  notification dedupe, and partial telemetry responses.
- Cloudflare API mocks: quarantine module generation for arbitrary valid class
  names, metadata preservation, no destructive migrations, verification, race
  retry, and emergency delete authorization.
- Staging smoke: real dispatch namespace + SQLite DO + re-arming alarm, followed
  by quarantine, data verification, fixed deploy, and probation.

## References

- [Cloudflare Durable Object metrics and GraphQL datasets](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- [Cloudflare automatic trace spans and Durable Object row counters](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/#durable-object-storage-sql-api)
- [Workers Observability telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
- [Cloudflare automatic tracing configuration and sampling](https://developers.cloudflare.com/workers/observability/traces/)
- [Cloudflare API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)
- [Cloudflare Tail Workers and Analytics Engine aggregation](https://developers.cloudflare.com/workers/observability/logs/tail-workers/#use-analytics-engine-for-aggregated-metrics)
- [Workers for Platforms observability and dispatch-namespace analytics](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/)
- [Cloudflare Workers/Durable Objects pricing](https://developers.cloudflare.com/workers/platform/pricing/#durable-objects)
- [Workers for Platforms script API](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/)
- [Workers for Platforms delete API and `force` behavior](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/delete/)
