# App Version Control Audit (Codebase-Verified)

## Scope
This audit verifies how "version control" currently works for deployed apps, based on the live code paths in this repo, and documents what you can rely on when building a versions UI + revert action.

## Executive Summary
- There is no first-class app version history model in Durable Objects today.
- App deployment metadata is stored as one row per `script_name` and overwritten on redeploy.
- Filesystem snapshots are not created automatically by the build command anymore.
- Revert is currently a manual/agent workflow (`juicefs clone ...`), not an API-backed operation.

## Verification of Your High-Level Statement

### 1) "We make a clone every time the agent deploys"
False today.

What is implemented:
- Deploy command still runs `yarn build && wrangler deploy ...` in starter projects.
- Build now uses `react-router build` and does not create snapshots by itself.

Important caveat:
- Any snapshot behavior is now manual (`juicefs clone ...`) unless a separate automation path is added.

Code:
- `sandbox/skills/developing-software/templates/chiridion-starter/package.json` (`"deploy": "yarn build && wrangler deploy ..."`)

### 2) "We store the 50 latest clones"
False today.

What is implemented:
- There is no automatic retention policy in code for snapshots now.

Nuance:
- Snapshots persist until manually removed.

### 3) "We can roll back by cloning a snapshot back into source"
Functionally true as an agent workflow.

What is implemented:
- The documented rollback approach is `juicefs clone snapshot -> project dir`.
- There is no dedicated backend endpoint or UI action for rollback yet.

Code/docs:
- `sandbox/skills/developing-software/SKILL.md`
- No rollback route under `src/routes/api/`

## How Deploy Metadata Works Today

### Deploy flow
- Deploy requests go through CF API proxy:
  - `workers/main/src/cf-api-proxy.ts`
- On successful script upload (`PUT .../scripts/{name}`), side effects run via `waitUntil`:
  - register/update script in OrgDO
  - update script access KV
  - queue preview screenshot

Code:
- `workers/main/src/cf-api-proxy.ts`
- `workers/main/src/services/deploy.ts`

### App record persistence
`worker_scripts` table (OrgDO) stores one record per script:
- `script_name` (PK)
- `workspace_id`
- `created_by`, `created_at`, `updated_at`
- `is_public`
- `preview_key`, `preview_updated_at`, `preview_status`, `preview_error`
- `config_path`

Code:
- schema/migrations: `workers/main/src/auth.ts`
- methods: `registerWorkerScript`, `listWorkerScripts`, etc. in `workers/main/src/auth.ts`

Critical implication:
- On redeploy, existing row is updated in-place (not appended as a new version record).
- So `updated_at` is "latest deploy/update timestamp", not a historical timeline.

## Fields Available for UI Right Now

## From Apps page loader
The `_app.apps` loader maps each app as:
- `script_name`
- `workspace_id`
- `created_by`
- `created_at`
- `updated_at`
- `is_public`
- `preview_key`
- `preview_updated_at`
- `preview_status`
- `preview_error`
- `config_path`
- `creator`:
  - `id`
  - `name`
  - `email`
  - `avatar`

Also loader-level context:
- `orgId`
- `orgSlug`
- `hostname`
- `renderedAt`

Code:
- `src/routes/_app.apps.tsx`
- `src/types.ts` (`WorkerScript`, `WorkerScriptWithCreator`)

## From filesystem APIs (usable for snapshot listing)
You can list snapshot directories via existing workspace FS APIs:
- `GET /api/workspaces/:id/fs/list?path=...&recursive=...&includeHidden=...`

For entries, you get:
- `path`
- `name`
- `type`
- `size`
- `modifiedAt`

Code:
- `src/routes/api/workspaces.$id.fs.list.ts`
- `src/routes/api/workspaces.utils.ts`
- `sandbox/control-plane.mjs`

## From audit log (admin only currently)
Org audit includes worker script events:
- `worker_script_registered`
- `worker_script_updated`
- `worker_script_touched`
- `worker_script_visibility_changed`
- `worker_script_deleted`

Details may include:
- `workspace_id`
- `config_path`

Code:
- events/logging: `workers/main/src/auth.ts`
- admin audit routes: `src/routes/_admin.orgs.$id.audit-log.tsx`, `src/routes/_admin.workspaces.$id.audit-log.tsx`

## Gaps You Should Plan For

1. No canonical version entity
- No `app_versions` table.
- No stable version id for "revert to version X".

2. App -> snapshot mapping is heuristic today
- Best available hint is `config_path` from deploy metadata.
- Snapshot folders are keyed by `basename(process.cwd())` at build time.
- Mapping can break if deploy/build CWD differs.

3. `config_path` can be missing or cleared
- On redeploy when metadata lacks `config_path`, DB update writes `config_path = null`.
- Version UI relying on `config_path` must handle null robustly.

4. Snapshot creation is best-effort
- Build/deploy can succeed without snapshot.

5. Snapshot retention is not app-aware
- 50 limit is per project snapshot dir, not per app or per deploy.

## Recommended Approaches for the Version UI

### Option A: Fast path (no new backend model)
Use filesystem snapshots as your version list source.

How:
1. For each app, derive project dir from `config_path`:
   - `projectDir = dirname(config_path)`
   - `projectName = basename(projectDir)`
2. List `/.chiridion/snapshots/{projectName}` through existing FS API.
3. Sort by `modifiedAt desc` in UI.
4. Treat folder name + mtime as display version.

Pros:
- Fastest to ship.

Cons:
- Heuristic mapping.
- No guaranteed one-to-one with deploys.
- Missing when `config_path` is null.

### Option B: Robust path (recommended for long-term)
Introduce a first-class `app_versions` model in OrgDO.

At deploy side effects, record a version row containing at least:
- `id` (uuid)
- `org_id`, `workspace_id`, `script_name`
- `deploy_ts`
- `created_by`
- `config_path`
- `project_dir`
- `snapshot_path` (if known)
- `snapshot_status` (`created|missing|failed|skipped`)
- optional `preview_image_key` (versioned screenshot key)

This gives reliable list/revert targeting and avoids path heuristics in UI.

## Revert Button: Agent Handoff Design

Your requested behavior (send a message to agent to perform revert) fits current architecture well.

## New-thread flow (already proven pattern)
Reuse existing apps-page "start chat" flow:
1. `POST /chat` with `intent=createThread`, `previewApps=script_name`.
2. Store a prepared message in `sessionStorage` under `pendingMessage:newThread`.
3. Navigate to `/chat/{threadId}?newThread=1`.
4. `Chat.tsx` auto-sends queued message on WS ready.

Code:
- `src/components/pages/apps/apps-client.tsx`
- `src/routes/_app.chat._index.tsx`
- `src/components/Chat.tsx`

## Existing-thread flow
Also possible:
1. Put payload into `pendingMessage:newThread` with the selected existing `threadId`.
2. Navigate to `/chat/{threadId}`.
3. `Chat.tsx` will send it when connection is ready.

## Message format recommendation
Use the same trusted wrapper used elsewhere:

```text
<chiridion system message>
Revert request:
- app_script: {script_name}
- workspace_id: {workspace_id}
- org_id: {org_id}
- target_snapshot_path: {absolute or workspace-relative snapshot path}
- target_project_path: {project dir path}
- app_url: {computed url}
- config_path: {config_path or "unknown"}
- requested_by_user: {user id/email if available}
- requested_at: {ISO timestamp}

Execution guidance:
1) Verify snapshot exists.
2) Create a safety snapshot of current project before restoring.
3) Restore snapshot into project directory.
4) Redeploy app.
5) Report exactly what changed and deploy result.
</chiridion system message>

Please revert this app to that version now.
```

## Why this works
- `ws-server` explicitly treats `<chiridion system message>...</chiridion system message>` as trusted operator context.
- You avoid exposing direct destructive file operations in the frontend API.
- Revert remains auditable through normal chat history.

## Practical UI Fields to Show in a Versions List
From currently available data (no new backend):
- `app.script_name`
- `app.workspace_id`
- `app.updated_at` (latest deploy-ish timestamp)
- `app.config_path`
- Snapshot entry:
  - `name` (timestamp folder or manual name)
  - `modifiedAt`
  - `path` (for revert payload)

If you add a version model, include:
- `version_id`
- `deploy_ts`
- `snapshot_status`
- `created_by`
- `preview image` (optional)

## Implementation Notes Before You Build
1. Decide source of truth first (filesystem snapshots vs new `app_versions` table).
2. If shipping fast with filesystem snapshots, design clear fallbacks for `config_path = null`.
3. Add a "safety snapshot before revert" step to the agent instruction to reduce risk.
4. Keep workspace-bound checks (existing app flows already do this).
5. Expect some versions to be missing snapshots and show explicit status in UI.
