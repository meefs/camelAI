# Documentation

Start here for current docs. Many files in this directory are completed feature
plans, feedback rounds, or design handoffs — treat those as historical unless
listed below. Prefer [`../AGENTS.md`](../AGENTS.md) for architecture and
conventions. Active cross-cutting architecture work also lives in
[`../plans/`](../plans/).

## Canonical docs

| Doc | Purpose |
| --- | --- |
| [self-hosting.md](./self-hosting.md) | Docker Compose / self-host operator guide |
| [pomerium-auth.md](./pomerium-auth.md) | Pomerium reverse-proxy auth |
| [cloudflare-access-auth.md](./cloudflare-access-auth.md) | Cloudflare Access reverse-proxy auth |
| [enterprise-oidc-sso.md](./enterprise-oidc-sso.md) | Direct multi-tenant enterprise OIDC SSO |
| [admin-api-reference.md](./admin-api-reference.md) | Admin REST API reference |
| [admin-api-migration-guide.md](./admin-api-migration-guide.md) | Admin API migration notes |
| [admin-js-exec.md](./admin-js-exec.md) | Generic remote JavaScript console for staging and production |
| [staging-onboarding-billing-e2e.md](./staging-onboarding-billing-e2e.md) | Manual staging onboarding, agent fallback, and Stripe browser tests |
| [chat-transcript-simplification.md](./chat-transcript-simplification.md) | Chat transcript / UIMessage invariants |
| [shadcn-components.md](./shadcn-components.md) | shadcn component catalog notes |
| [pi-system-prompt.md](./pi-system-prompt.md) | Generated / exported Pi system prompt snapshot |
| [exedev-admin-mcp.md](./exedev-admin-mcp.md) | exe.dev admin MCP + mcporter setup |
| [slack-staging-app.md](./slack-staging-app.md) | Staging Slack app configuration |
| [integrations-runtime.md](./integrations-runtime.md) | Connection definitions, OpenAPI import, policies, generic fetch, and GA4 |
| [connections-improvement-guide.md](./connections-improvement-guide.md) | Living product, UX, quality, safety, and evaluation strategy for connections |
| [warehouse-binding-design.md](./warehouse-binding-design.md) | Warehouse binding design (active) |
| [workspace-git-service-design.md](./workspace-git-service-design.md) | Workspace git service design (active) |
| [deployed-app-usage-guard-design.md](./deployed-app-usage-guard-design.md) | Durable Object usage monitoring and runaway-app suspension design |
| [channels-architecture.html](./channels-architecture.html) | Channels architecture overview |
| [deterministic-automations-architecture.html](./deterministic-automations-architecture.html) | Deterministic automations architecture |

## Historical docs

Files matching `*-plan.md`, `*-feedback*.md`, `*-review*.md`, and similar
one-off design notes are usually completed work. They often describe pre-Pi or
pre-`project-runtime-service` architecture (including the removed in-repo
`services/sandbox-host` Go tree). Do not treat them as source of truth for
current behavior.

When adding a new living doc, link it in the table above. When a plan is fully
shipped, leave it in place for history (or move it under an `archive/` folder in
a follow-up) and extract any still-true invariants into a canonical doc or
`AGENTS.md`.

## Related scripts

One-off migration helpers that are not part of the normal workflow:

- `scripts/migrate-to-workspaces.ts` — workspace schema backfill worker
- `scripts/import-legacy-emails.ts` — legacy email CSV import

Keep for break-glass re-runs; they are intentionally not wired into
`package.json` scripts.

Reusable remote-console smoke suites live under `scripts/admin-js-exec/`; see
[admin-js-exec.md](./admin-js-exec.md) for invocation and runtime globals.
