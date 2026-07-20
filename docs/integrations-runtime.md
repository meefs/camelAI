# Integrations runtime

camelAI separates an integration **definition** (auth templates, operations,
provenance, and policy classification) from a workspace **connection** (account
configuration and encrypted credentials).

Every connection is projected through the universal contract in
`src/lib/connection-contract.ts`. The contract gives every consumer the same
driver, capabilities, verification strategy, permissions, and provenance, so
the UI and agent catalogs cannot advertise execution the runtime does not have.

## Storage

- Imported definitions live in OrgDO's `integration_definitions` table.
- `integrations.definition_id` links a credential-bearing connection to its
  definition. Built-in and legacy connections may leave this null.
- OrgDO list/get methods join the definition payload onto
  `WorkspaceIntegrationRecord.definition`; credentials never enter the payload.
- Normalized connection verification is stored separately from auth health in
  `verification_status`, `verification_message`, `verification_checked_at`,
  `verification_live`, and `verification_strategy`.

## Drivers, adapters, and verification

| Driver | Typical connections | Execution |
| --- | --- | --- |
| `sql` | Postgres, MySQL, BigQuery, ClickHouse, Snowflake | Read-only SQL and metadata tools |
| `channel` | Slack, Telegram | Channel actions and provider API where supported |
| `curated` | GA4 | Purpose-built semantic operations |
| `remote_mcp` | User or owner MCP server | Credentialed MCP proxy |
| `provider_mcp` | GitHub, Notion, hosted providers | Brokered MCP tools |
| `authenticated_http` | Other, Resend | Origin-scoped generic fetch and imported operations |
| `configuration` | OpenAI, AWS, GCP, credential-only types | Project credentials, with no invented API executor |

Hosted MCP implementations and safe verification probes are registered in
`workers/main/src/connection-adapters.ts` and consumed by the connections
runtime. Specialized SQL, GA4, channel, imported-operation, and generic HTTP
paths stay explicit because their policy and execution semantics differ.

`env.CONNECTIONS.verify(query)` and connections RPC action `verify` return a
normalized health result. `ready` means a bounded live provider check passed.
`configured` means local setup validation passed without a network request.
Failures map to `needs_authorization`, `misconfigured`, or `degraded`. The UI
shows the persisted result and check type rather than treating stored
credentials as proof of readiness.

Invocation and verification emit structured Analytics Engine events containing
tenant ids, operation or strategy, provider type where available, status, and
duration. They never include credentials, headers, bodies, endpoint query
strings, or response data.

## Discovery and execution

The connections UI checks owner-declared `/.well-known/integrations.json`,
probes direct or conventional JSON/YAML OpenAPI URLs and the MCP server card,
then consults the stored integrations.sh domain surface document as an advisory
source. One domain may offer multiple selectable HTTP/OpenAPI, GraphQL, and MCP
surfaces. integrations.sh results may include its deterministic probes plus
previously model-discovered documentation facts; camelAI does not trigger the
rate-limited integrations.sh discovery agent from the connection dialog.

OpenAPI imports include up to 150 typed operations. GET and HEAD default to
`read`; other verbs default to `write`. GraphQL imports expose a single document
operation conservatively classified as `write`, because arbitrary documents may
contain mutations. Remote MCP discoveries create the normal `remote_mcp`
connection and can continue into dynamic OAuth authorization. Owner and direct
signals take precedence over integrations.sh entries with the same endpoint.
A connection's `operation_policy` blocks typed write operations unless explicitly
set to `all`.

Discovery results remain advisory. HTTP and OpenAPI entries sharing an endpoint
collapse to the strongest typed/owner-backed definition. Tenant placeholders in
endpoint URLs become required setup fields and are resolved before public-URL
validation or persistence. The review step displays the exact endpoint and warns
when it is hosted outside the submitted domain. Unknown authentication remains an
explicit unresolved choice; the user must select and verify an authentication
method before creating the connection.

Discovery candidates are ranked by trust first, then capability: direct owner
declarations, direct MCP/OpenAPI detection, owner-backed catalog entries, and
finally advisory catalog discovery. Known-auth owner MCP is preferred when it is
available; otherwise typed OpenAPI is the predictable default. The UI initially
shows the three best matches for domains with many surfaces. Cross-domain
endpoints sourced through integrations.sh require explicit confirmation.

See [connections-improvement-guide.md](./connections-improvement-guide.md) for
the product policy, measurement framework, prioritization criteria, and roadmap.

Imported connections also expose `connections.<alias>.fetch(...)`. This is the
intentional fallback for APIs that are incomplete or cannot be described. New
imports pin credential-bearing requests and redirects to the discovered base
origin. Legacy `other` connections retain their existing cross-origin behavior
for compatibility.

GA4 is the first curated definition pack. It uses Google OAuth with the
`analytics.readonly` scope, discovers account/property summaries, health-checks
metadata, refreshes tokens in OrgDO, and exposes property, metadata,
compatibility, core report, realtime report, pivot report, and semantic summary
operations. Report POSTs are explicitly classified as reads.

Set `GOOGLE_ANALYTICS_CLIENT_ID` and `GOOGLE_ANALYTICS_CLIENT_SECRET` to use a
dedicated Google OAuth client. If omitted, the Worker falls back to the existing
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; tokens and scopes still remain in a
separate integration connection from login OAuth.

Relevant code:

- `src/lib/connection-contract.ts`
- `src/lib/integration-definition.ts`
- `src/lib/openapi-integration.server.ts`
- `workers/main/src/connections-runtime.ts`
- `workers/main/src/connection-adapters.ts`
- `workers/main/src/google-analytics-mcp.ts`
- `src/components/pages/connections/ImportConnectionDialog.tsx`

Focused verification:

```bash
bun run test:run -- tests/connection-contract.test.ts tests/openapi-integration.test.ts tests/connections-action.test.ts
bun run test:workers -- connection-adapters.test.ts connections-runtime.test.ts code-mode-integrations.test.ts
bun run typecheck
```
