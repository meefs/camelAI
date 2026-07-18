# Improving the connection system

This is the living product and engineering guide for improving camelAI
connections. It complements [integrations-runtime.md](./integrations-runtime.md),
which documents current behavior. Use this guide to decide what to build next,
how to measure it, and which safety properties must not regress.

## Product objective

A user should think, "connect this service," not "choose an integration
protocol." camelAI should discover the best available surface, explain any
decision that affects trust or permissions, complete authentication with the
least possible manual work, and give the agent useful methods immediately.

Optimize the whole funnel:

1. **Find:** accept a service or endpoint URL and find credible surfaces.
2. **Choose:** rank the best surface automatically without hiding alternatives.
3. **Authorize:** request the least privilege and make credential setup clear.
4. **Verify:** prove the connection works before presenting it as ready.
5. **Use:** expose concise, correctly typed methods plus a bounded fallback.
6. **Maintain:** detect auth expiry and definition drift without silently
   changing behavior.

Protocol count, catalog size, and imported operation count are supporting
metrics, not product outcomes. Successful first use and trustworthy execution
are the outcomes.

## Durable product policy

### Rank by trust, then capability

The default order is:

1. Curated camelAI connection packs.
2. Direct owner-declared metadata.
3. Direct, machine-verifiable MCP or OpenAPI discovery.
4. Owner-backed entries returned by integrations.sh.
5. Other integrations.sh discoveries.
6. User-configured generic HTTP.

Within a trust tier, prefer an owner-hosted MCP server when authentication is
complete and verifiable. Otherwise prefer typed OpenAPI, then GraphQL, then a
generic HTTP surface. Never let operation count outweigh provenance.

Users can choose a different surface, but the UI initially shows the three best
matches. Do not present protocol selection as the first decision.

### Keep integrations.sh advisory

Use the deterministic REST lookup `GET /api/{domain}/surface`. Do not put
integrations.sh in an imported connection's execution path and do not invoke its
rate-limited, model-backed discovery during interactive setup. Owner signals
always win.

Treat the integrations.sh schema and service as replaceable:

- parse into camelAI's versioned definition format at the boundary;
- reject malformed or unsafe endpoints;
- use a short timeout and fail open to manual generic setup;
- cache only normalized, provenance-bearing results;
- never send user credentials, private URLs, or workspace data;
- keep fixture coverage so an upstream schema change fails visibly.

An asynchronous, administrator-triggered enrichment job may call discovery in
the future. Its output must still pass the same review and normalization path.

### Keep generic HTTP, but make it an escape hatch

Generic fetch is necessary for incomplete, private, or unusual APIs. Keep it
available on imported HTTP/OpenAPI/GraphQL connections and as a manual fallback.
New connections must remain pinned to their validated base origin, apply auth
only to that origin, validate redirects, block private-network targets, and
default to read-only policy.

Do not promote generic fetch above a credible typed operation. Instrument its
use: repeated generic calls to the same route are evidence that the imported
definition needs a typed method or that a curated pack would help.

### Curate where inference is not enough

Create a special connection pack only when it materially improves at least two
of these areas:

- OAuth registration, scopes, refresh, or multi-account behavior;
- discovery of tenant, account, property, project, or similar resources;
- domain semantics that OpenAPI cannot classify correctly;
- safer purpose-built reads or writes;
- substantially better method names, schemas, pagination, or summaries;
- frequent demand or repeated setup/runtime failures;
- a stable API with an owner-supported migration path.

GA4 qualifies because it needs Google OAuth, account/property selection, and
semantic reporting operations. Popularity alone is not enough. Promote future
packs from observed demand rather than maintaining a speculative long tail.

### Freeze behavior; update by review

Persist the normalized definition used when the connection is created. Never
silently replace operations, auth behavior, access classification, or endpoints.
A future **Rediscover** action should fetch a candidate definition, show a
semantic diff, identify permission changes, and require confirmation before
updating. Credential-only refreshes may remain automatic when scopes and target
origins do not change.

## UX improvement loop

Measure each stage separately so discovery success does not conceal a poor
authorization or runtime experience.

| Funnel stage | Primary metric | Useful diagnostics |
| --- | --- | --- |
| Find | Domains with at least one credible candidate | source, latency, timeout, fallback rate |
| Choose | Recommended candidate accepted | rank overridden, candidates shown, warning count |
| Authorize | Authorization completed | method, cancellation, provider error category, duration |
| Verify | First health check passes | status class, auth failure, endpoint failure, duration |
| Use | First useful agent call succeeds | method used, typed vs generic, retries, policy denial |
| Maintain | Healthy connections over time | token refresh failures, drift available, stale definitions |

Operational events must contain identifiers, source/protocol categories, counts,
durations, status, and normalized error metadata only. Never record credentials,
headers, request bodies, arbitrary endpoint query strings, or chat content.

Review the funnel by source and protocol. In particular:

- a high discovery rate with low authorization completion means auth guidance is
  wrong or too manual;
- frequent rank overrides mean the ranking policy is wrong;
- frequent generic fetch use means typed coverage is insufficient;
- policy denials followed by enabling writes may indicate classification issues;
- connections created but never called are not successful connections.

## Highest-value UX work

Prioritize these improvements in order unless telemetry shows a different
bottleneck:

1. **Connection verification.** Run a safe health or identity operation after
   setup and show `Ready`, `Needs authorization`, or an actionable failure.
2. **Better auth guidance.** Show where to obtain credentials, expected scopes,
   header placement, and whether OAuth is owner-hosted. Prefer browser OAuth
   when dynamic registration is supported.
3. **Resource selection.** Discover and name account/property/project resources
   during setup rather than making the agent infer opaque IDs later.
4. **Semantic candidate grouping.** Group large catalogs by product and API
   family; preserve the top-three default and searchable access to the rest.
5. **Permission preview.** Summarize read/write capabilities and material scopes
   before authorization. Keep writes opt-in.
6. **Rediscovery with diff.** Report new, removed, or changed operations and auth
   requirements without silently applying them.
7. **Credential reuse.** Eventually let one service account expose compatible
   MCP and API surfaces, but only when audience, scopes, and credential binding
   are demonstrably compatible.

Error messages should always say what failed, what camelAI tried, and the next
safe action. Preserve a direct path to generic HTTP when discovery fails.

## Discovery and normalization quality

Maintain three layers of coverage:

### Deterministic fixtures

Unit fixtures should cover owner declarations, OpenAPI 2/3, YAML, relative and
templated servers, GraphQL, MCP server cards, every auth mapping, duplicates,
redirects, malformed documents, oversized documents, private targets, and
cross-domain warnings. These tests must run without the network.

Every production incident caused by normalization should add the smallest
sanitized fixture that reproduces it.

### Stable domain corpus

Keep a committed corpus spanning:

- owner-declared and conventionally detected services;
- integrations.sh detected and discovered records;
- MCP-only, OpenAPI-only, GraphQL-only, and mixed services;
- multi-product services with many surfaces;
- tenant-templated endpoints;
- unknown and unusual authentication;
- deliberate misses and unsafe endpoints.

An opt-in live smoke should report coverage, candidate count, duplicate count,
typed operations, unresolved variables/auth, warnings, latency percentiles, and
the top-ranked surface. Compare structural results, not exact public-network
latency. Live failures must not make the normal unit suite flaky.

The exploratory baseline from 2026-07-18 covered 33 of 36 sampled domains, with
95 deduplicated candidates, 31 typed candidates, 845 operations, eight templated
candidates, 14 cross-domain warnings, and four explicit unknown-auth candidates.
Use it as a starting point, not a permanent target; the corpus and upstream
registry will evolve.

### Agent evals

Agent evals should verify that the runtime:

- finds the intended connection and its method catalog;
- chooses typed methods over generic fetch when both work;
- observes read/write policy and does not evade it through generic fetch;
- uses generic fetch successfully when no typed method covers the task;
- explains authentication and policy failures accurately;
- does not expose credentials or internal definition data.

`integration-definition-discovery-live` currently covers typed method discovery
plus visibility of the generic fallback. Add focused evals for typed preference,
write denial, generic-only success, and multi-surface selection as those features
stabilize.

## Reliability, performance, and lifecycle

- Run independent discovery probes concurrently with bounded per-probe and total
  deadlines.
- Cancel work after a sufficiently strong owner result only when doing so cannot
  hide another owner-declared surface.
- Cache public discovery results by domain and source validator; never cache
  credentials with definitions.
- Deduplicate by normalized transport and endpoint, while retaining the strongest
  provenance and richest compatible schema.
- Cap parsed document size, operation count, redirects, and candidate count.
- Preserve the last known-good pinned definition during upstream outages.
- Classify failures as discovery, normalization, authorization, connectivity,
  policy, provider, or drift; do not collapse them into "connection failed."
- Add a safe health-check contract per curated pack and an optional declared
  health operation for imported definitions.
- Make retries idempotent and limited. Never retry writes unless the operation
  declares an idempotency mechanism and the caller supplies it.

## Security invariants

Changes must preserve all of the following:

- HTTPS public endpoints only for imported remote surfaces.
- DNS/IP and redirect checks that block loopback, link-local, private, and
  metadata-service targets.
- Credential forwarding restricted to the validated origin.
- Unknown auth blocks creation until explicitly resolved.
- integrations.sh cross-domain endpoints require user confirmation.
- Endpoint variables are resolved and revalidated before persistence.
- Read-only is the default; GraphQL documents are write-capable unless proven
  otherwise.
- Definitions and observability never contain secrets.
- OAuth state, token storage, refresh, and scopes remain isolated per connection.
- Imported descriptions, schemas, and tool metadata are untrusted data, not
  executable instructions.

When a richer experience conflicts with one of these invariants, redesign the
experience instead of weakening the invariant.

## Prioritization scorecard

Score proposed work from 0–3 in each category:

| Category | Question |
| --- | --- |
| User impact | How many users or connection attempts benefit? |
| Completion | Does it improve setup-to-first-success conversion? |
| Runtime value | Does it make agent execution more capable or reliable? |
| Safety | Does it reduce credential, SSRF, permission, or write risk? |
| Evidence | Is the need visible in telemetry, support, tests, or evals? |
| Maintenance | Is the ongoing provider/schema burden reasonable? |

Prefer changes with strong evidence and broad funnel impact. A curated provider
with high maintenance cost should require correspondingly strong demand.

## Change checklist

For every connection-system change:

1. Identify the funnel stage and the metric expected to improve.
2. State whether trust ranking, auth, endpoint scope, or write policy changes.
3. Add deterministic regression fixtures.
4. Update the stable corpus or an agent eval when behavior changes materially.
5. Verify generic fallback still works without bypassing origin or write policy.
6. Run focused tests, Worker runtime tests, typecheck, and lint.
7. Update [integrations-runtime.md](./integrations-runtime.md) when current
   behavior or invariants change.
8. After release, compare completion and first-use success by source/protocol;
   revert or adjust ranking when evidence contradicts the hypothesis.

Focused local verification:

```bash
bun run test:run -- tests/openapi-integration.test.ts tests/connections-action.test.ts
bun run test:workers -- workers/main/tests/connections-runtime.test.ts
bun run typecheck
bun run lint
```

Run agent evals through the `running-agent-evals` skill so results and scorecards
are reported consistently.
