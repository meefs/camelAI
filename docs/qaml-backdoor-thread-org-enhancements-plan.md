# QAML Backdoor Enhancements Plan: Thread View-As-User + Org Recent Threads/Apps

## Objective
Add two superuser-only capabilities in `/qaml-backdoor`:

1. **View Thread as User** from thread list and thread detail, opening `/chat/<threadId>` in a **read-only** mode for quality control.
2. On org detail (`/qaml-backdoor/orgs/:id`), add:
   - **Recent threads** (most recent 10)
   - **Recent apps** (most recent 10)
   - Show total counts only when they are cheap to compute; otherwise show only recent lists

## Non-Negotiables
- Must remain **fast and snappy**.
- Must not trigger N+1 or large full scans on page load.
- Must remain **superuser-only** (consistent with existing qaml-backdoor access model).
- Read-only thread view must **not allow sending messages**.
- Do **not** parse Claude JSONL in Worker/UI code; use sandbox-host message parsing endpoint.

## Current State (Relevant)
- Thread list: [src/routes/_admin.threads.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_admin.threads.tsx)
- Thread detail: [src/routes/_admin.threads.$id.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_admin.threads.$id.tsx)
- Org detail: [src/routes/_admin.orgs.$id.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_admin.orgs.$id.tsx)
- Chat route: [src/routes/_app.chat.$id.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_app.chat.$id.tsx)
- Chat UI: [src/components/Chat.tsx](/Users/illiana/Projects/chiridion-app/src/components/Chat.tsx)
- Admin index DO: [workers/main/src/admin-index-do.ts](/Users/illiana/Projects/chiridion-app/workers/main/src/admin-index-do.ts)
- Admin data helpers: [src/lib/auth-do.server.ts](/Users/illiana/Projects/chiridion-app/src/lib/auth-do.server.ts)
- Existing message parser path in sandbox-host:
  - Worker calls `WorkspaceContainer.readThreadMessagesStream(threadId)`
  - which requests `GET /v1/workspaces/{orgId}/{workspaceId}/chat/messages?threadId={threadId}`
  - sandbox-host parses JSONL and returns `messages[]` JSON

## Proposed Solution

### A) View Thread as User (Read-Only Chat)
Use `/chat/:id` with a query flag (example: `?adminReadonly=1`) and a superuser-only loader branch.

#### Behavior
- Add **"View as User"** button in:
  - Thread list rows
  - Thread detail page
- Button URL: `/chat/<threadId>?adminReadonly=1`
- Open this URL in a **new tab**.
- In `adminReadonly` mode:
  - Render thread in chat UI (message bubbles and layout)
  - **Disable composer/send**
  - **Do not open chat websocket**
  - Keep preview panel enabled for QC (file/app preview remains viewable)
  - Load history through a superuser-only admin endpoint that proxies sandbox-host parsed-message response

#### Why this design
- Avoids mutating session org/workspace.
- Avoids membership/access pitfalls for superusers not in target org.
- Enforces read-only at UI flow level by removing sending path entirely.

### B) Org Detail: Recent Threads + Recent Apps
Add two sections on org detail page with top 10 each, newest first.

#### Data strategy
- Use AdminIndexDO org-scoped SQL queries (single DO call path, indexed).
- Return only required fields + optional counts.
- No per-row follow-up requests.

## Performance Plan

### Query constraints
- Hard cap: `LIMIT 10` for recent threads/apps.
- Use org-scoped indexed queries:
  - `threads WHERE org_id = ? ORDER BY updated_at DESC LIMIT 10`
  - `apps WHERE org_id = ? ORDER BY updated_at DESC LIMIT 10`
- Show counts only if cheap indexed `COUNT(*) WHERE org_id = ?` queries stay fast; otherwise omit counts.

### AdminIndexDO improvements
In [workers/main/src/admin-index-do.ts](/Users/illiana/Projects/chiridion-app/workers/main/src/admin-index-do.ts):
- Add indexes in `migrate()`:
  - `idx_threads_org_updated_at` on `(org_id, updated_at DESC)`
  - `idx_apps_org_updated_at` on `(org_id, updated_at DESC)`
  - Optional: `idx_workspaces_org_created_at` on `(org_id, created_at DESC)`
- Add org/thread lookup methods:
  - `getThreadContextById(threadId)`
  - `getOrgRecentThreads(orgId, limit)`
  - `getOrgRecentApps(orgId, limit)`
  - `getOrgThreadCount(orgId)` and `getOrgAppCount(orgId)` (optional)

### Request budget (target)
For org detail loader additions:
- **+1 AdminIndexDO RPC** max for recent threads/apps (+counts if included in same RPC method)
- **0 extra per-row requests**

For read-only chat:
- **No websocket connection**
- **1 messages fetch** to admin endpoint (which forwards to sandbox-host `/chat/messages` parser endpoint)

## Detailed Implementation Steps

## 1. Admin data layer updates
1. Update [workers/main/src/admin-index-do.ts](/Users/illiana/Projects/chiridion-app/workers/main/src/admin-index-do.ts):
   - Add indexes in migration.
   - Add org-scoped recent threads/apps methods and thread context lookup by id.
2. Add wrappers in [src/lib/auth-do.server.ts](/Users/illiana/Projects/chiridion-app/src/lib/auth-do.server.ts):
   - `adminGetThreadContextById(context, threadId)`
   - `adminGetOrgRecentActivity(context, orgId, { threadLimit: 10, appLimit: 10, includeCounts?: boolean })`
3. Refactor `adminGetThreadWithMessages` to use index-based thread context lookup instead of scanning every org.

## 2. API route for read-only message retrieval
1. Add route file:
   - [src/routes/api/admin.threads.$id.messages.ts](/Users/illiana/Projects/chiridion-app/src/routes/api/admin.threads.$id.messages.ts)
2. Register in [src/routes.ts](/Users/illiana/Projects/chiridion-app/src/routes.ts):
   - `api/admin/threads/:id/messages`
3. Route behavior:
   - `requireSuperuser`
   - Resolve thread org/workspace via `adminGetThreadContextById`
   - Validate thread exists in that org/workspace
   - Call `WorkspaceContainer.readThreadMessagesStream(threadId)` and return that parsed JSON response
   - This guarantees the Go sandbox-host parser endpoint is used; no Worker-side JSONL parsing

## 3. Read-only mode in chat route/UI
1. Update [src/routes/_app.chat.$id.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_app.chat.$id.tsx):
   - Parse `adminReadonly=1`
   - In that branch: require superuser, resolve thread context/title, return `readOnly` flag in loader data
   - Keep normal behavior unchanged when flag is absent
2. Update [src/components/Chat.tsx](/Users/illiana/Projects/chiridion-app/src/components/Chat.tsx):
   - Add prop `readOnly?: boolean`
   - If read-only:
     - fetch messages from `/api/admin/threads/:id/messages`
     - consume parsed `messages[]` payload from sandbox-host pipeline (no client JSONL parsing)
     - skip websocket connect/reconnect logic
     - keep preview panel behavior enabled so admins can inspect generated files/apps
     - hide or disable prompt composer and uploads
     - guard `sendMessage()` and related send paths
     - show small read-only banner/hint

## 4. Add "View as User" buttons
1. Thread list page [src/routes/_admin.threads.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_admin.threads.tsx):
   - Add Actions column with `View as User` button linking to `/chat/${thread.id}?adminReadonly=1`
   - Open link in a new tab (`target="_blank"`, `rel="noopener noreferrer"`).
2. Thread detail page [src/routes/_admin.threads.$id.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_admin.threads.$id.tsx):
   - Add same button in Thread Details card actions
   - Open link in a new tab (`target="_blank"`, `rel="noopener noreferrer"`).

## 5. Org detail: recent threads + recent apps
1. Update loader in [src/routes/_admin.orgs.$id.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_admin.orgs.$id.tsx):
   - Fetch `recentThreads` and `recentApps` via `adminGetOrgRecentActivity`
   - Include `threadCount`/`appCount` only when cheap; skip counts when query cost/latency is non-trivial
2. Update UI in same file:
   - Add **Recent Threads** card/table (max 10)
   - Add **Recent Apps** card/table (max 10)
   - Link rows to existing admin detail pages (`/qaml-backdoor/threads/:id`, `/qaml-backdoor/apps/:scriptName`)

## 6. Optional cleanup while touching org detail
Replace current global workspace fetch-and-filter (`adminGetWorkspacesPaginated(...limit:500).filter`) with org-scoped data retrieval to remove unnecessary scanning.

## Security and Access Control
- All new admin endpoints/routes must use existing `requireSuperuser`.
- No change to non-superuser behavior.
- Read-only mode should never submit chat messages via UI path.

## Testing Plan

## Unit/Integration
1. AdminIndexDO method tests:
   - org recent threads/apps ordering and limits
   - thread context lookup correctness
2. Route loader tests:
   - `/chat/:id?adminReadonly=1` requires superuser
   - `/api/admin/threads/:id/messages` requires superuser and returns expected payload
3. Regression tests:
   - normal `/chat/:id` still sends/streams as before

## E2E (or manual scripted checks)
1. Thread list has `View as User` action.
2. Thread detail has `View as User` action.
3. Clicking opens `/chat/<id>?adminReadonly=1` in a new tab.
4. Message history renders.
5. Composer/send is unavailable in read-only mode.
6. Preview panel remains enabled in read-only mode for file/app inspection.
7. Org detail shows at most 10 recent threads and 10 recent apps.
8. Sorting is newest-first by `updated_at`.

## Decisions Confirmed
1. "View as User" opens in a **new tab**.
2. Org counts are displayed **only when cheap**; otherwise the UI shows recent 10 lists without totals.
3. Read-only mode keeps the **preview panel enabled** for quality-control inspection.

## Acceptance Criteria
- Superuser can open read-only thread viewer from both thread list and detail.
- "View as User" opens in a new tab from both locations.
- Read-only viewer displays full thread messages and does not allow sending.
- Read-only viewer keeps preview panel functionality available for inspection.
- Org detail page shows recent 10 threads + recent 10 apps with links.
- Org counts are shown only when cheap to compute; otherwise omitted without fallback heavy computation.
- No N+1/per-row fetch pattern introduced.
- Query path is org-scoped and indexed for new lists.
- Thread message retrieval in read-only admin mode uses sandbox-host parsed-message endpoint (`/chat/messages`) and does not parse JSONL in Worker/UI.

## Rollout Notes
- No schema migration outside Durable Object SQL `migrate()` needed.
- Keep fallback behavior if counts are omitted (display "Recent 10" without totals).
- After implementation, update [AGENTS.md](/Users/illiana/Projects/chiridion-app/AGENTS.md) to document:
  - read-only admin chat mode
  - org detail recent threads/apps panels
