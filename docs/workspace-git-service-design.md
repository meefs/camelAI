# Workspace Git Service Design

## Goal

Allow coding agents and users inside a workspace container to use Git against one or more workspace-scoped repositories without putting provider credentials in the container.

The desired UX is effectively unauthenticated from inside the container:

```bash
git clone camelai:frontend.git
git clone camelai:api.git
git push
```

The service should still authenticate and authorize at the sandbox-host or Worker boundary. "Unauthenticated" should mean no credential prompts or provider tokens in the container, not that any container can access any workspace's repos.

## Proposed Shape

Use one sandbox-host Git service that serves all workspace repos, instead of one Git server process per workspace.

Responsibilities:

- `OrgDO` / `WorkspaceDO` owns repo metadata, workspace membership, provider connection references, and policy.
- The sandbox host owns Git pack operations and workspace-local bare repo storage.
- Workspace containers get a simple Git remote namespace that maps to only their workspace repos.
- Provider credentials stay outside the container and are used only by Worker/sandbox-host controlled sync paths.

Example storage layout on the host:

```text
<workspace-root>/
  git/
    frontend.git/
    api.git/
    docs.git/
```

Example container-facing remotes:

```text
camelai:frontend.git
camelai:api.git
http://camelai-git/repos/frontend.git
```

## Protocol

Prefer smart HTTP Git over `git daemon`.

Smart HTTP can map cleanly to:

- `git-upload-pack` for clone/fetch
- `git-receive-pack` for push

Avoid `git daemon` because it is awkward to authenticate, usually read-focused, and harder to isolate safely across tenants.

Implementation options:

- Wrap `git-http-backend` from Go with a workspace-aware router.
- Use a Go Git protocol library if it can match Git client behavior reliably.

The simplest first implementation is likely a Go HTTP endpoint that validates workspace access, sets the right `GIT_PROJECT_ROOT`, and delegates to `git-http-backend`.

## Container UX

The container should not need GitHub, GitLab, or other provider credentials.

Configure Git in the workspace container so a short remote prefix expands to an internal service URL:

```bash
git config --global url."http://camelai-git/internal/$WORKSPACE_GIT_TOKEN/".insteadOf "camelai:"
```

Then the model or user can run:

```bash
git clone camelai:frontend.git
```

The token should be a workspace-scoped capability minted by the host or Worker. It should be short-lived or rotate with container lifecycle. The user-facing command remains credentialless, but the service still has an authorization boundary.

If we can avoid exposing the token in common command output by using a local-only hostname plus sandbox-host request identity, that is preferable. The core requirement is that one workspace container cannot fetch or push another workspace's repos.

## Sync Model

There are two separate operations:

1. Container Git operations against workspace bare repos.
2. Controlled sync between workspace bare repos and upstream providers.

Initial behavior can be workspace-local only:

- Clone/fetch/push works against the workspace's bare repos.
- The repo can be initialized from an uploaded archive, generated app, or a provider import.
- Pushing updates the workspace bare repo, not necessarily GitHub/GitLab.

Later provider sync can support:

- Import from provider repo using a connection.
- Pull latest from upstream through a Worker/sandbox-host controlled path.
- Push branch/commit upstream through an explicit action with provider credentials outside the container.

## Security Requirements

- Never put provider OAuth tokens, SSH keys, or PATs in the container.
- Do not expose a truly unauthenticated Git service on the host network.
- Scope access by org, workspace, and repo key.
- Treat `git-receive-pack` as a write operation and gate it separately from clone/fetch.
- Validate repo names with a strict allowlist; no path traversal.
- Keep bare repo paths under workspace-owned storage.
- Log clone/fetch/push operations with workspace, repo, and actor/context.
- Prefer private network or container-only routing for the Git service.

## Open Questions

- Should every workspace have a default repo, or should repos be explicit records in `WorkspaceDO`?
- Do we want multi-repo workspaces to appear as independent repos, a monorepo, or both?
- Should pushes from the container auto-sync upstream, or should upstream sync be an explicit UI/tool action?
- How should branch protections or review flows work for provider-backed repos?
- Should repo data be backed up separately from normal workspace filesystem snapshots?

## First Milestone

Build a workspace-local Git service only:

1. Add workspace repo metadata records in the tenant-owned Durable Object.
2. Add a sandbox-host Git HTTP endpoint backed by workspace bare repos.
3. Inject a workspace-scoped Git capability and `camelai:` Git config into the container.
4. Support clone, fetch, and push for workspace-local repos.
5. Add tests for workspace isolation, repo-name validation, clone/fetch, and push.

Provider import/sync should be a second milestone after the local Git path is solid.
