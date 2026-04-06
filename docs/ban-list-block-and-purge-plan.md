# Ban List + Block-and-Purge Plan

## Objective

Add a real ban system for spam/fraud handling that lets superusers ban at both the **user** and **org** level, immediately shuts down affected sandboxes, permanently blocks future access, and deletes platform data for the banned entity.

This must be operable from both:

- **QAML Backdoor** (`/qaml-backdoor`)
- **Admin API** (`/api/admin/*`)

## Requested Outcomes

1. We can add users and orgs to a ban list easily.
2. A banned user or banned org is blocked from the platform going forward.
3. Their sandbox container is shut down and cannot come back.
4. If they try to log in again, they see a dedicated blocked/banned page.
5. Banning also deletes the account/org and all related data: containers, apps, files, threads, uploads, etc.

## Key Design Decision

**Ban state must live outside the UserDO / OrgDO being deleted.**

If we only store ban state inside `UserDO` or `OrgDO`, then deleting the user/org would also delete the ban record, which would let the same bad actor return.

So the feature should be split into two layers:

1. **Durable ban tombstone** — minimal long-lived record kept in global storage
2. **Data purge** — destructive cleanup of the user/org and all associated resources

The tombstone survives the purge.

## Current State

There is already good deletion groundwork in the codebase:

- `src/lib/auth-do.server.ts`
  - `hardDeleteAdminUser(...)`
  - `hardDeleteAdminOrg(...)`
- `workers/main/src/workspace.ts`
  - `hardDeleteWorkspace(...)`
- qaml-backdoor already supports superuser delete actions for users/orgs
- admin REST API already exists under `workers/main/src/routes/admin/`

What is missing is:

- a persistent ban list/tombstone model
- login/access enforcement against that ban list
- a dedicated banned page
- guaranteed sandbox destruction at the host filesystem/container level
- admin API + qaml-backdoor ban flows
- a unified ban + purge workflow instead of standalone test-reset deletion

## Proposed Model

## 1) Ban scopes

### User ban

Blocks an individual person from ever accessing the platform again.

Store ban lookups by:

- `user_id` (for existing sessions/internal checks)
- normalized `email` (for password login + OAuth return)
- optional OAuth provider identity if needed later

### Org ban

Blocks an organization and all of its workspaces/apps.

Store ban lookups by:

- `org_id`
- org `slug` (best-effort secondary lookup)

## 2) Global ban tombstones

Use global storage that survives account deletion.

Recommended initial storage:

- `APP_KV`

Suggested keys:

- `ban:user:id:{userId}`
- `ban:user:email:{normalizedEmail}`
- `ban:org:id:{orgId}`
- `ban:org:slug:{slug}`
- `ban:event:{uuid}` for audit/history (optional)
- `ban-purge-job:{jobId}` for background execution state

Suggested value shape:

```json
{
  "scope": "user",
  "targetId": "usr_123",
  "email": "fraud@example.com",
  "reason": "spam/fraud chargebacks",
  "createdAt": 1760000000000,
  "createdBy": "system-admin",
  "status": "active",
  "purgeStatus": "pending|running|completed|failed",
  "purgeCompletedAt": null
}
```

For org bans, store the same shape with `scope: "org"` and org identifiers.

## 3) Ban semantics

This should be an **irreversible ban-and-purge flow**, not a temporary suspension.

Once triggered:

- access is blocked immediately
- sessions are revoked
- purge starts
- the ban tombstone remains after data deletion

If we want softer moderation later, that should be a separate **suspend** feature.

## Enforcement Plan

## 1) Authentication and session gates

Ban checks should happen in all entry points where a banned actor could re-enter.

### Password login/signup

Check ban tombstones before:

- creating a new user in signup
- creating a new session in login

Files likely involved:

- `src/routes/api/auth.login.ts`
- `src/routes/api/auth.signup.ts`
- supporting auth helpers used by those routes

### OAuth login

Check normalized email immediately after OAuth identity resolution and before allowing session creation / onboarding continuation.

Files likely involved:

- `workers/main/src/routes/oauth.ts`
- `workers/main/src/services/oauth.ts`

### Existing session revalidation

Even if a user was already logged in, they should be kicked out as soon as the ban lands.

Add ban enforcement to the common auth gate:

- `src/lib/auth.server.ts`
  - `requireAuthContext()`

Behavior:

- if user is banned: clear/replace session cookie and redirect to `/banned`
- if current org is banned: clear active org/workspace selection and redirect to `/banned`

## 2) Real-time/chat/access paths

A banned user/org should not be able to keep using active sessions, websockets, or background flows.

Enforce checks in:

- Web chat websocket entry: `/ws/{workspace}`
- `ChatThreadDO` message ingestion paths
- external ingress that could target banned orgs/workspaces:
  - Slack
  - Email
  - scheduled prompts
  - external MCP

Behavior:

- reject new turns immediately
- close active sockets for affected workspaces/users
- do not enqueue new model work

## 3) Sandbox/container creation paths

The current platform eagerly/implicitly ensures workspace sandboxes. That means ban checks must exist before any path can recreate a workspace container.

Enforce checks in:

- worker-side workspace container bootstrap paths
- any sandbox-host ensure/proxy path that can lazily start a container

Behavior:

- banned user or banned org cannot recreate a workspace runtime
- requests should fail closed

## 4) Dedicated banned page

Add a public page such as:

- `/banned`

Behavior:

- shown after password login attempt, OAuth return, or stale-session revalidation
- clear messaging that the account/org is blocked
- do **not** expose internal moderation details
- optionally show support contact info

Recommended copy:

- “This account has been blocked from camelAI.”
- “If you believe this is a mistake, contact support@camelai.com.”

Important:

- always clear stale authenticated session cookies before rendering/redirecting
- keep the message generic for both deleted+banned and banned-only cases

## Purge Plan

## 1) Make ban synchronous, purge asynchronous

The admin action should do two things in order:

1. **Write the ban tombstone first**
2. **Start purge job second**

That guarantees the actor is blocked even if deletion is partially complete.

## 2) Background purge job

Do not try to do the entire purge only in the HTTP request.

Recommended approach:

- persist a purge job record in `APP_KV` (or another durable store)
- trigger background execution with `waitUntil()`
- make the purge functions idempotent so an admin can retry safely

Why:

- org deletion touches DOs, KV, R2, dispatch scripts, sessions, and sandbox-host
- sandbox teardown + storage deletion can fail midway
- we need visibility into `pending/running/completed/failed`

## 3) Sandbox destruction must be host-level, not just DO-level

Today `hardDeleteWorkspace(...)` clears DO state, but the ban requirement also needs the actual runtime destroyed.

We should add a sandbox-host control route for full workspace purge, not just `/terminate`.

Suggested new route:

- `DELETE /v1/workspaces/{orgId}/{workspaceId}` or
- `POST /v1/workspaces/{orgId}/{workspaceId}/purge`

Required behavior:

1. terminate running container
2. remove container metadata/state
3. delete workspace directory under `/srv/sandboxes/...`
4. remove any host-side mounted/R2-backed workspace artifacts as needed
5. be safe to retry when the container or directory is already gone

This is the only way to satisfy “their container is destroyed permanently.”

## 4) Reuse and extend existing delete flows

### Org ban purge should build on `hardDeleteAdminOrg(...)`

Extend it to also:

- write org ban tombstone first
- revoke all org sessions immediately
- purge every workspace sandbox from sandbox-host
- delete deployed dispatch scripts/apps
- delete R2 uploads/outputs/previews
- clear worker/session/auth KV indexes
- clear scheduled prompts, integration state, thread history, logs, tokens, email/slack mappings, and related references
- finally delete `OrgDO` state

### User ban purge should build on `hardDeleteAdminUser(...)`

Extend it to also:

- write user ban tombstone first
- revoke all user sessions immediately
- remove OAuth/email login mappings
- remove memberships
- delete user profile/UserDO
- purge user-owned resources that are safe to attribute directly

## Important policy edge case: user-owned orgs

User ban and org ban are different scopes, so user-ban behavior needs explicit rules.

Recommended policy:

1. **If the banned user is the sole owner/admin of an org**, automatically cascade to org ban + org purge.
2. **If the banned user belongs to a shared org with other legitimate members**, do **not** automatically delete that org.
   - remove the user from the org
   - revoke their access
   - require a separate explicit org-ban action if the org itself is fraudulent

This avoids deleting innocent teammates’ data while still purging the bad actor.

## Admin Surfaces

## 1) QAML Backdoor

Add ban actions to:

- `src/routes/_admin.users.$id.tsx`
- `src/routes/_admin.orgs.$id.tsx`
- optionally list pages for faster triage:
  - `src/routes/_admin.users.tsx`
  - `src/routes/_admin.orgs.tsx`

Recommended UI:

- **Ban user + purge data** button
- **Ban org + purge data** button
- required reason textarea
- confirmation dialog with explicit destructive language
- status badges:
  - `Active ban`
  - `Purge pending`
  - `Purge running`
  - `Purge failed`
  - `Purged`

Important: the existing delete dialogs can be adapted, but the messaging must emphasize that the ban survives deletion.

## 2) Admin API

Add endpoints such as:

- `POST /api/admin/users/:id/ban`
- `POST /api/admin/orgs/:id/ban`
- `GET /api/admin/bans`
- `GET /api/admin/bans/:scope/:key`
- optional retry endpoint:
  - `POST /api/admin/ban-purge-jobs/:id/retry`

Example request:

```json
{
  "reason": "spam / fraud",
  "delete_data": true
}
```

Response should include:

```json
{
  "ok": true,
  "scope": "user",
  "target_id": "usr_123",
  "ban_status": "active",
  "purge_status": "running",
  "job_id": "job_123"
}
```

## Data Deletion Checklist

Org purge should cover:

- OrgDO state
- WorkspaceDO state for all workspaces
- workspace containers on sandbox-host
- workspace files on host disk
- deployed apps / dispatch scripts
- app previews
- uploads / outputs / user-uploads in R2
- threads and thread metadata
- scheduled prompts
- integrations + tokens
- worker auth state/tokens
- API tokens
- sessions
- screenshot sessions/tokens
- email/slack thread mappings and ingress references
- usage/spend records if policy says they are deletable
- worker logs / preview artifacts / derived indexes

User purge should cover:

- UserDO state
- password/OAuth mappings
- sessions
- memberships and ACL rows
- user-scoped tokens
- user-owned or directly attributable resources
- personal/owned workspaces and their sandboxes when applicable

## Files/Areas Likely Touched

### Frontend / React Router

- `src/routes/_admin.users.$id.tsx`
- `src/routes/_admin.orgs.$id.tsx`
- `src/routes/_admin.users.tsx`
- `src/routes/_admin.orgs.tsx`
- `src/routes.ts`
- new public route for `/banned`
- auth/login/signup routes under `src/routes/api/auth.*`
- `src/lib/auth.server.ts`
- `src/lib/auth-do.server.ts`

### Workers

- `workers/main/src/routes/admin/routes.ts`
- `workers/main/src/routes/oauth.ts`
- `workers/main/src/services/oauth.ts`
- `workers/main/src/index.ts`
- `workers/main/src/durable-objects.ts`
- `workers/main/src/workspace-container.ts`
- possibly `workers/main/src/auth.ts`, `workspace.ts`, and related helpers

### Sandbox host

- `services/sandbox-host/internal/app/server.go`
- `services/sandbox-host/internal/container/manager.go`
- `services/sandbox-host/internal/workspace/*`

## Rollout Phases

## Phase 1 — Tombstones + auth enforcement

- global ban tombstones in KV
- login/signup/OAuth checks
- stale session rejection
- `/banned` page
- admin API endpoints to create bans

## Phase 2 — Purge orchestration

- background purge jobs
- extend existing hard-delete flows
- session revocation + access cutoff
- qaml-backdoor ban UI

## Phase 3 — Sandbox-host hard purge

- host-level workspace purge route
- guaranteed container termination + disk deletion
- retry/idempotency handling

## Phase 4 — Full ingress lockdown and cleanup hardening

- websocket/chat enforcement
- Slack/email/external MCP/scheduled prompt rejection
- audit/history view for bans and purge outcomes

## Acceptance Criteria

1. Superuser can ban a user from qaml-backdoor and admin API.
2. Superuser can ban an org from qaml-backdoor and admin API.
3. Ban writes a durable tombstone that survives user/org deletion.
4. Banned users cannot log in via password or OAuth.
5. Existing sessions for banned users/orgs stop working quickly.
6. Visiting with a stale session redirects to a dedicated `/banned` page.
7. A banned org cannot recreate its workspace container.
8. Purge removes containers, apps, files, sessions, uploads, and related data.
9. Purge can be retried safely if a step fails.
10. Shared-org user bans do not silently delete innocent teammates’ orgs.

## Recommended PR Strategy

Because this feature is broad and security-sensitive, implement it in follow-up PRs:

1. **PR 1:** plan + tombstone model + `/banned` page + auth enforcement
2. **PR 2:** admin API + qaml-backdoor controls
3. **PR 3:** purge orchestration + sandbox-host workspace purge
4. **PR 4:** ingress hardening + tests + AGENTS.md updates

## Open Questions

1. Should org bans also ban all member emails automatically, or only the org itself?
   - Recommendation: **no automatic member ban**; keep org and user bans separate.
2. Should support be able to reverse a ban?
   - Recommendation: **not initially** for ban-and-purge. Deletion is irreversible.
3. Should usage/spend logs be deleted or retained for fraud/finance forensics?
   - Recommendation: keep this as an explicit policy decision before implementation.
4. For OAuth, is email-based tombstoning enough, or do we also need provider subject tombstones?
   - Recommendation: start with normalized email, add provider identity only if needed.
5. For user ban on shared orgs, should the action fail if they are still an owner?
   - Recommendation: auto-cascade only for sole-owner orgs; otherwise require ownership transfer or explicit org ban.
