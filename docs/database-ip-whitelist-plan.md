# Surfacing the Sandbox IP for Firewall Whitelisting

**Status:** historical — the "how connections work today" audit below predates the
DbQuerySandbox cutover. SQL queries/exports no longer flow through the
`SANDBOX_HOST` VPC binding + VM Go data-proxy (both retired); they run in the
`DbQuerySandbox` Cloudflare container and egress the same static IP via the
on-host gost SOCKS relay (`docs/db-egress-relay.md`). The static IP to surface
is unchanged (`20.46.233.68` prod), constant in `src/lib/sandbox-network.ts`.
**Owner:** illiana
**IP to surface:** `20.46.233.68` (sandbox-host VM, from `AGENTS.md`)

## Problem

When users connect a self-hosted database (PostgreSQL, MySQL, etc.), their database often sits behind a firewall or in a VPC that only accepts traffic from allowlisted source IPs. Today nothing in the camelAI UI or agent context tells them *which* IP to allowlist, so connection attempts silently time out and the agent has no way to diagnose it correctly.

We want to make `20.46.233.68` discoverable in the right places — for the user setting up a connection, and for the agent helping them debug one.

## How connections work today (audit summary)

There are two entry points where a user creates a database connection:

1. **User-driven UI flow** — the Connections page (`src/routes/_app.connections.tsx`) opens `AddConnectionDialog` (`src/components/pages/connections/AddConnectionDialog.tsx`). The dialog renders fields from `INTEGRATION_REGISTRY` (`src/lib/integration-registry.ts`).
2. **Agent-driven flow** — the agent calls the `prompt_connection_setup` MCP tool (`workers/main/src/mcp-handler.ts:1183-1430`), which broadcasts a `connection_setup_prompt` event to the chat WebSocket. The browser renders `ConnectionSetupPrompt` (`src/components/connection-setup-prompt.tsx`), which already supports a markdown `instructions` block (`connection-setup-prompt.tsx:268-271`).

Both surfaces hit the same `createIntegration` action and end up storing encrypted credentials on `WorkspaceDO`.

At runtime, queries from the agent's container and from any deployed user worker route through the **data proxy**:

```
container / deployed worker
  → DataProxyService (workers/main/src/data-proxy-service.ts)
  → SANDBOX_HOST VPC binding
  → chiridion-data-proxy Go process (on the sandbox VM)
  → user database
```

The sandbox VM is the actual TCP source, so its public IP (`20.46.233.68`, `AGENTS.md` "Sandbox Host Deployment") is what the user must allowlist. This is true for `postgresQuery`, `mysqlQuery`, and `mssqlQuery` paths.

The agent system prompt is built in `sandbox/control-plane.mjs` (`buildSystemPromptAppend`, around line 310+). The environment-variables table at line 339 documents `DATA_PROXY_URL` but says nothing about firewall requirements. There are zero existing mentions of `whitelist`, `allowlist`, `firewall`, or `20.46.233.68` in product UI or skills.

### Which integrations actually need this?

I went back through the full `INTEGRATION_REGISTRY` (`databases` category):

| Integration | Show notice? | Why |
|---|---|---|
| **postgres** | **Yes** | Direct TCP to host:port |
| **mysql** | **Yes** | Direct TCP to host:port |
| **mssql** *(not yet in registry, but `DataProxyService.mssqlQuery` exists)* | **Yes** when added | Direct TCP |
| **clickhouse** | **Yes** | Self-hosted: TCP. ClickHouse Cloud also supports IP access lists. |
| **mongodb** | **Yes** | MongoDB Atlas requires IP allowlists by default; self-hosted is TCP. |
| **redis** | **Yes** | Redis Cloud / self-hosted both gate by source IP. |
| **snowflake** | **Yes** | Customers commonly enable network policies; harmless to surface. |
| **neon** | Maybe (v2) | Mostly token-based, but the form exposes a direct `connection_string`. Default off; the per-integration flag makes it a one-line flip. |
| **planetscale** | Maybe (v2) | Same shape as neon — has a direct `connection_string` field. Default off. |
| **turso** | No | libsql edge protocol; auth is bearer token. |
| **supabase** | No | REST/PostgREST + API key. |
| **databricks** | No | HTTPS + PAT. |
| **bigquery** | No | Google service account JSON. |
| **aws / gcp / azure** | No | API-based with service credentials. |

So v1 turns the notice on for **postgres, mysql, clickhouse, mongodb, redis, snowflake** (and `mssql` once added). `neon` and `planetscale` stay off by default and can be enabled later by setting the flag — no code change beyond the registry.

## Proposal

Surface the IP in three places, in priority order. The goal is that the user sees it once at setup time without it being noisy, and the agent can quote it accurately when troubleshooting.

### 1. UI: inline notice in the connection dialogs (primary)

Show a small, non-blocking info alert *inside* the form, right above the credentials section, on every DB type from the table above. The component is shared between `AddConnectionDialog` (manual setup) and `ConnectionSetupPrompt` (agent-triggered) — both share the same form scaffold today, so a single `<SandboxIpNotice />` is enough.

**Where (driven by a flag, not a hardcoded type list):**
- `AddConnectionDialog.tsx` — render `<SandboxIpNotice />` when `typeDef.requiresOutboundIpAllowlist === true`.
- `ConnectionSetupPrompt.tsx` — same condition. This is the more important surface because it's the one the agent triggers when guiding a user.

#### ASCII mockup — `AddConnectionDialog` (postgres)

```
┌──────────────────────────────────────────────────────────────┐
│ Add PostgreSQL                                            ✕  │
│ Connect to a PostgreSQL database                             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Name                                                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ PostgreSQL                                             │  │
│  └────────────────────────────────────────────────────────┘  │
│  A friendly name to identify this connection                 │
│                                                              │
│  Host                                                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ localhost                                              │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Port              Database              Schema              │
│  ┌──────────┐      ┌──────────────┐      ┌──────────────┐    │
│  │ 5432     │      │ analytics    │      │ public       │    │
│  └──────────┘      └──────────────┘      └──────────────┘    │
│                                                              │
│  SSL Mode                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Require                                            ▼   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ╭──── 🛈 Network access ────────────────────────────────╮   │  ← NEW
│  │ If your database sits behind a firewall or VPC,      │   │
│  │ allowlist camelAI's outbound IP:                     │   │
│  │                                                      │   │
│  │   20.46.233.68     [ Copy ]                          │   │
│  │                                                      │   │
│  │ Managed services (Supabase, BigQuery, etc.) don't    │   │
│  │ need this.                                           │   │
│  ╰──────────────────────────────────────────────────────╯   │
│                                                              │
│  Username                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Password                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ••••••••                                               │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                          [ Cancel ] [ Save ] │
└──────────────────────────────────────────────────────────────┘
```

The notice sits between the **config fields** block (host/port/database/schema/ssl) and the **credential fields** block — that's the natural break in the form, and conceptually the IP rule is part of "can I reach this database" rather than "who am I logging in as."

#### ASCII mockup — `ConnectionSetupPrompt` (agent-triggered)

```
┌──────────────────────────────────────────────────────────────┐
│ 🔌 Connect PostgreSQL                                     ✕  │
│ The agent needs access to set this up for you                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌── (agent's `message` field, if provided) ─────────────┐   │
│  │ I'll need credentials for your analytics database to  │   │
│  │ run the report.                                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌── (agent's `instructions`, markdown) ──────────────────┐  │
│  │ • Use a read-only role if possible                    │   │
│  │ • SSL is required                                     │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  Name:  [ Analytics DB                              ]        │
│  Host:  [ db.internal.acme.com                      ]        │
│  Port:  [ 5432 ]   Database: [ analytics            ]        │
│                                                              │
│  ╭──── 🛈 Network access ────────────────────────────────╮   │  ← NEW (same component)
│  │ Allowlist camelAI's outbound IP on your DB firewall: │   │
│  │   20.46.233.68     [ Copy ]                          │   │
│  ╰──────────────────────────────────────────────────────╯   │
│                                                              │
│  Username: [                                        ]        │
│  Password: [                                        ]        │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                       [ Cancel ] [ Connect ] │
└──────────────────────────────────────────────────────────────┘
```

Notice we keep the agent's `message` and `instructions` blocks intact (those are agent-authored copy that may already mention the IP via the system-prompt change in §2). The `<SandboxIpNotice />` is a deterministic UI guarantee that the IP is *always* visible regardless of what the agent did or didn't say.

**Implementation notes:**
- New shared component `src/components/connections/sandbox-ip-notice.tsx` — Alert + monospace IP + copy-to-clipboard button. Reused by both dialogs.
- IP lives in a new `src/lib/sandbox-network.ts` as `export const SANDBOX_OUTBOUND_IP = '20.46.233.68'`. Keeps `integration-registry.ts` focused on integration shapes.
- Add an optional flag on `IntegrationDefinition`:
  ```ts
  requiresOutboundIpAllowlist?: boolean;
  ```
  Set `true` on: `postgres`, `mysql`, `clickhouse`, `mongodb`, `redis`, `snowflake` (and `mssql` once it lands). Leaving the flag off means no notice — that's the right default for non-DB and managed integrations.

### 2. Agent context: system prompt note (secondary)

Extend the environment-variables block in `sandbox/control-plane.mjs:331-346` so the agent knows the answer when a user asks "why can't you connect" or "what IP do I whitelist."

**Where:** add a single bullet immediately below the existing env-var table inside the `<environment_variables>` section. Keep it terse — system prompt tokens are precious.

#### ASCII mockup — system-prompt insert

```
<environment_variables>
| Variable | Purpose |
|----------|---------|
| `WORKSPACE_ID`    | Current workspace identifier                                                          |
| `ORG_ID`          | Organization the workspace belongs to                                                 |
| `THREAD_ID`       | Current chat thread                                                                   |
| `ANTHROPIC_API_KEY` | Proxy token for LLM calls                                                           |
| `CLOUDFLARE_API_TOKEN` | Deploy token (workspace-scoped)                                                  |
| `DATA_PROXY_URL`  | Thread-scoped SQL proxy base URL (SQL Server/PostgreSQL/MySQL; sandbox-authenticated) |
| `OPENAI_PROXY_URL`| Thread-scoped OpenAI-compatible proxy base URL                                        |
| ...                                                                                                       |

Integration credentials are accessed through the virtual connections binding.

╭──── NEW (1 line, drop in right here) ─────────────────────────────╮
│ Outbound DB traffic from `DATA_PROXY_URL` (and any other          │
│ user-provided DB connection: postgres, mysql, mssql, clickhouse,  │
│ mongodb, redis, snowflake) egresses from `20.46.233.68`. If a     │
│ connection times out or refuses, tell the user to allowlist       │
│ `20.46.233.68` on their database firewall / VPC security group.   │
╰───────────────────────────────────────────────────────────────────╯


Do **not** repeat this in every skill file — one mention in the always-on system append is enough and keeps the guidance authoritative.

### 3. MCP tool description (tertiary, low cost)

Update the `prompt_connection_setup` tool description in `workers/main/src/mcp-handler.ts` so the agent gets reminded to mention the IP in the `instructions` field when it's setting up a `postgres` or `mysql` connection. One sentence in the tool description, e.g.:

> When prompting the user for postgres or mysql credentials, include a note in `instructions` reminding them to allowlist `20.46.233.68` on their database firewall.

This is belt-and-suspenders next to the system prompt change — feel free to skip if we want to keep the change set small. The UI alert in step 1 already covers the `prompt_connection_setup` flow visually.

## Out of scope for this change

- **Per-environment / per-region IP.** Today we have one VM. If we add more sandbox hosts or move regions, the constant has to update; that's a one-line change but we should not pretend to support multi-IP egress until we actually do.
- **A standalone "Network" or "Firewall" docs page.** Possible follow-up if support requests pile up; not needed for a first pass.
- **Edit dialogs.** The notice is most useful at *create* time. We can add it to edit later if users ask.
- **Non-DB integrations.** Stripe, Notion, etc. don't egress from our VM in a way that requires allowlisting on the user's side.

## Files that will change (preview)

- `src/lib/integration-registry.ts` — add `requiresOutboundIpAllowlist?: boolean` to interface; set on `postgres` + `mysql`.
- `src/lib/sandbox-network.ts` *(new)* — exports `SANDBOX_OUTBOUND_IP`.
- `src/components/connections/sandbox-ip-notice.tsx` *(new)* — small alert + copy button.
- `src/components/pages/connections/AddConnectionDialog.tsx` — render notice when `typeDef.requiresOutboundIpAllowlist`.
- `src/components/connection-setup-prompt.tsx` — same.
- `sandbox/control-plane.mjs` — one new line in `<environment_variables>` block.
- `workers/main/src/mcp-handler.ts` — *(optional)* extend `prompt_connection_setup` tool description.
- `AGENTS.md` — append a one-liner under "Data Proxy" noting the outbound IP is surfaced in the postgres/mysql connection UIs.

No API contract, DO, or storage changes. No migrations.

## Decisions (resolved with illiana)

1. **IP is a hardcoded constant.** Even though the VM provider could change in the future, the user-facing requirement is "give me a single IP I can allowlist" — wrapping it in a config value would only push the same value through one extra layer. Hardcode `20.46.233.68` in `src/lib/sandbox-network.ts`. If we ever change VMs, we update that constant in one place.
2. **Always-on system-prompt note.** One line in the `<environment_variables>` block of `buildSystemPromptAppend` (every session sees it). Not gated to data-analysis-only contexts.
3. **External docs page — handled separately.** illiana will add a page to the public docs site (lives in a separate repo) that goes deeper than the in-app notice. The implementing agent **does not need to write or update those docs**, but the in-app notice must include a link to that page so users can click through. See **§4 below** for the URL contract and the docs-page draft (informational only — illiana owns the docs repo).

## 4. Docs link contract + draft (illiana writes the actual docs page)

### Link contract for the implementing agent

The `<SandboxIpNotice />` component should render a "Learn more" link that points to:

```
https://docs.camelai.com/connections/network-access
```

If illiana ends up using a different URL when she publishes the docs page, she will swap the constant — keep the URL in **one place**, e.g. as `SANDBOX_NETWORK_DOCS_URL` next to `SANDBOX_OUTBOUND_IP` in `src/lib/sandbox-network.ts`.

**Important note for the implementing agent:** the copy and structure of the in-app notice in §1 (mockups above) is the source of truth for what the *app* shows. If your implementation diverges from the mockup (e.g., different wording, different placement of the "Learn more" link, you decide to drop the "managed services don't need this" sentence), update **this docs draft below** so it stays consistent with whatever the in-app notice actually says. illiana will copy this draft into the docs repo separately, so the two need to match.

### Docs page draft — `docs.camelai.com/connections/network-access`

> # Network access for database connections
>
> When you connect a database to camelAI, queries run from our sandbox infrastructure — not from your browser. If your database is behind a firewall, in a VPC, or has IP-based access controls, you'll need to allow traffic from our outbound IP.
>
> ## Allowlist this IP
>
> ```
> 20.46.233.68
> ```
>
> Add this IP to your database's inbound rules (or your cloud provider's network access list). Below are quick pointers for common setups.
>
> ## Which databases need this?
>
> You need to allowlist `20.46.233.68` for:
>
> - **PostgreSQL** (self-hosted or managed)
> - **MySQL** (self-hosted or managed)
> - **SQL Server**
> - **ClickHouse** (self-hosted and ClickHouse Cloud)
> - **MongoDB** (Atlas and self-hosted)
> - **Redis** (Redis Cloud and self-hosted)
> - **Snowflake** (only if your account has a network policy configured)
>
> You **don't** need to allowlist for:
>
> - **Supabase, Databricks, BigQuery, Turso** — these use API tokens over HTTPS, not direct database connections.
>
> ## Cloud provider quick reference
>
> ### AWS RDS / Aurora
>
> 1. Open the RDS console → your instance → **Connectivity & security**.
> 2. Click the security group under **VPC security groups**.
> 3. Edit **Inbound rules** → **Add rule**:
>    - Type: PostgreSQL / MySQL / your DB engine
>    - Source: Custom → `20.46.233.68/32`
>    - Description: `camelAI`
> 4. Save.
>
> ### Google Cloud SQL
>
> 1. Open the Cloud SQL instance → **Connections** → **Networking**.
> 2. Under **Authorized networks**, click **Add network**:
>    - Name: `camelAI`
>    - Network: `20.46.233.68/32`
> 3. Save.
>
> ### Azure Database for PostgreSQL / MySQL / SQL Server
>
> 1. Open the database resource → **Networking** (or **Connection security**).
> 2. Under **Firewall rules**, add a new rule:
>    - Rule name: `camelAI`
>    - Start IP / End IP: `20.46.233.68`
> 3. Save.
>
> ### MongoDB Atlas
>
> 1. Open your project → **Network Access** → **IP Access List**.
> 2. **Add IP Address** → enter `20.46.233.68`, comment `camelAI`.
> 3. Confirm.
>
> ### Snowflake (only if you use network policies)
>
> ```sql
> CREATE NETWORK POLICY camelai_policy
>   ALLOWED_IP_LIST = ('20.46.233.68');
>
> ALTER USER <your_user> SET NETWORK_POLICY = camelai_policy;
> ```
>
> If you already have a network policy, add `20.46.233.68` to its `ALLOWED_IP_LIST`.
>
> ### Self-hosted databases
>
> For self-hosted PostgreSQL, MySQL, SQL Server, ClickHouse, MongoDB, or Redis behind a firewall (iptables, ufw, cloud security group, or hardware firewall), open inbound TCP from `20.46.233.68` on your database's port.
>
> ## Troubleshooting
>
> If the agent reports a connection timeout or "connection refused" after you've added the rule:
>
> - Double-check the IP is exactly `20.46.233.68` (no typos, no `/32` if your provider already implies single-host).
> - Confirm the rule is on the **inbound** side of the firewall, not outbound.
> - Make sure your DB is bound to a network interface reachable from the public internet (not just `127.0.0.1`).
> - For RDS / Cloud SQL, confirm the instance has **Public access** enabled (or set up a private VPC peering — out of scope for this guide).
