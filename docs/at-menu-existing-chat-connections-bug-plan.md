# Existing Chat @ Menu Connections Bug Plan

**Date:** 2026-06-15
**Primary files:**
- [src/routes/_app.chat._index.tsx](../src/routes/_app.chat._index.tsx) - new-chat loader and `welcomeData`
- [src/routes/_app.chat.$id.tsx](../src/routes/_app.chat.$id.tsx) - existing-thread loader
- [src/components/Chat.tsx](../src/components/Chat.tsx) - existing-thread composer mention source resolution
- [src/components/welcome-screen/index.tsx](../src/components/welcome-screen/index.tsx) - new-chat composer mention source resolution
- [src/components/prompt-input.tsx](../src/components/prompt-input.tsx) - shared @ menu trigger, ranking, and selection
- [src/lib/mentions.ts](../src/lib/mentions.ts) - shared slug, ranking, parsing, and annotation utilities
- [src/routes/api/workspaces.$id.projects.ts](../src/routes/api/workspaces.$id.projects.ts) - current projects-only mention refresh endpoint

## Objective

The @ menu should behave the same in new chats and existing chats:

1. Show both workspace projects and workspace connections in one flat ranked list.
2. Search connections by connection name, raw `integration_type`, and registry display name. Example: a BigQuery connection named `Prod` should match both `Prod` and `Big query` / `BigQuery`.
3. Refresh mention sources in existing chat composers without dropping either kind.
4. Keep the server-side mention expansion contract unchanged.

## What Is Already Working

The shared ranking code already supports connection type search. In [src/lib/mentions.ts](../src/lib/mentions.ts), `rankMentionables()` ranks connection matches by:

- connection name
- generated mention slug
- raw `integration_type`
- registry display name from `getIntegrationDefinition()`

So the bug is not primarily the search algorithm. The bug is that the existing chat composer can be given a mention source list that contains projects but not connections.

## Why New Chat And Existing Chat Diverged

This happened because the @ menu was built in two layers that never got consolidated into one mention-source contract.

1. The original connection @ menu was fed from route loader data.
   - New chat loads `connectionsPromise` in [src/routes/_app.chat._index.tsx](../src/routes/_app.chat._index.tsx).
   - Normal existing chat also has a `connectionsPromise` in [src/routes/_app.chat.$id.tsx](../src/routes/_app.chat.$id.tsx).

2. Project @ mentions were added later with a freshness path for running chats.
   - [src/components/Chat.tsx](../src/components/Chat.tsx) owns `mentionProjectsFetcher`.
   - When the @ trigger opens, `Chat` fetches `/api/workspaces/:id/projects`.
   - That endpoint returns only projects.

3. There is no equivalent connection refresh path.
   - If an existing-thread `Chat` instance starts with empty/stale connections, it can recover projects on @ menu open, but it cannot recover connections.
   - The current `/chat/:id?newThread=1` loader branch also returns `connections: []` and `projects: []` for its optimized bootstrap response. Projects can later repopulate through the projects fetcher; connections cannot.

The result is an asymmetric data flow:

```text
New chat (/chat)
  loader connections + loader projects
        |
        v
  WelcomeScreen -> PromptInput

Existing chat (/chat/:id)
  loader connections + loader projects
        |
        v
  Chat -> PromptInput
        ^
        |
  projects-only refresh on @ menu open
```

That projects-only refresh made sense for the project feature because projects can be created during a conversation. But once the menu contains more than projects, refreshing only one kind creates exactly this failure mode: the existing chat menu can show fresh projects while connections remain absent.

## Fix Strategy

Use a single mention-source read path for both connections and projects, then use it everywhere the composer needs mention data.

### 1. Add A Shared Server Helper

Create a small app-side helper, for example `src/lib/mention-sources.server.ts`, with these functions:

```ts
export async function loadWorkspaceMentionConnections(
  authEnv: AuthEnv,
  workspaceId: string,
): Promise<Integration[]>;

export async function loadWorkspaceMentionProjects(
  env: CloudflareEnv,
  workspaceId: string,
): Promise<MentionableProject[]>;

export async function loadWorkspaceMentionSources(
  env: CloudflareEnv,
  workspaceId: string,
): Promise<{
  connections: Integration[];
  projects: MentionableProject[];
}>;
```

Implementation notes:

- `loadWorkspaceMentionConnections()` should use `listWorkspaceIntegrationRecords(getAuthEnv(env), workspaceId)` and `integrationRecordToIntegration`, matching current chat loaders.
- `loadWorkspaceMentionProjects()` should use `WorkspaceFilesystemClient.listProjects()` and `projectsToMentionables()`, matching the current projects route.
- Keep independent failure handling at call sites or inside the combined helper so a projects failure does not hide connections and a connections failure does not hide projects.
- Do not move this helper into `src/lib/mentions.ts`; that file is browser-safe and currently imported by client-rendered code.

### 2. Add A Combined Mention Sources Endpoint

Add `GET /api/workspaces/:id/mentions`, registered in [src/routes.ts](../src/routes.ts), returning:

```json
{
  "connections": [],
  "projects": []
}
```

Route behavior:

- Validate access with `requireWorkspaceAccess(request, context, workspaceId)`.
- Call the shared helper.
- Return only the mention DTOs needed by the composer.
- Set `Cache-Control: private, no-store`.
- Let auth/access `Response` errors pass through unchanged.

Keep `/api/workspaces/:id/projects` for any existing callers, but have it reuse the project helper.

### 3. Refresh Both Kinds In Existing Chat

In [src/components/Chat.tsx](../src/components/Chat.tsx):

- Replace `mentionProjectsFetcher` with a mention-sources fetcher typed as `{ connections?: Integration[]; projects?: MentionableProject[]; error?: string }`.
- Keep the existing "fetch when @ trigger opens" behavior and 15 second throttle.
- Load `/api/workspaces/:id/mentions` instead of `/api/workspaces/:id/projects`.
- When data arrives:
  - call `setResolvedMentionConnections(data.connections)` if present
  - call `setResolvedMentionProjects(data.projects)` if present
- Keep stale-while-revalidate behavior; do not add loading UI to the menu.

This is the key bug fix. It means an existing chat can recover both projects and connections from the same source whenever the user opens the @ menu.

### 4. Populate Optimized Existing-Thread Branches

In [src/routes/_app.chat.$id.tsx](../src/routes/_app.chat.$id.tsx), revisit every branch that currently returns explicit empty mention sources:

- admin read-only can stay empty if mentions are intentionally disabled there.
- no-workspace can stay empty.
- `/chat/:id?newThread=1` should not return empty mention sources if the composer is editable.

For the `newThread=1` branch, after `requireSessionWorkspaceAccess()` provides `orgId` and `workspaceId`, start deferred mention-source promises using the shared helper and return them as `connections` and `projects`. This keeps the bootstrap route fast while avoiding an empty composer source list.

### 5. Keep New Chat On The Same Contract

Update [src/routes/_app.chat._index.tsx](../src/routes/_app.chat._index.tsx) to use the same helper rather than duplicating connection/project loading inline.

Update [src/components/welcome-screen/index.tsx](../src/components/welcome-screen/index.tsx) only if needed for type names. It already combines resolved connections and projects into one `mentionEntities` list before passing them to `PromptInput`.

### 6. Search Behavior Guardrails

Do not add a second filter in UI code. Keep search behavior centralized in `rankMentionables()`.

Add or verify tests for:

- `rankMentionables()` matches connection display names such as `BigQuery`, `Big Query`, and compact queries like `bigquery`.
- The menu includes a BigQuery connection named `Prod` when the query is `prod`.
- The menu includes that same connection when the query is `big query`.
- Projects and connections remain one flat interleaved list, not separate groups.

## Test Plan

Unit and component tests:

- Add a `Chat`/composer-level regression test where initial `connections` is empty, initial `projects` has a project, opening the @ menu fetches `/api/workspaces/:id/mentions`, and the menu updates to show both the fetched connection and project.
- Add a route/API test for `GET /api/workspaces/:id/mentions`.
- Extend `tests/prompt-input-mentions.test.tsx` with connection type display-name matching if it is not already covered through `tests/mentions.test.ts`.
- Add a loader test for `/chat/:id?newThread=1` proving editable new-thread bootstrap data no longer returns empty mention sources.

Commands:

```bash
bun run test:run -- tests/mentions.test.ts tests/prompt-input-mentions.test.tsx
bun run test:run -- tests/workspace-projects-api.test.ts
bun run typecheck
```

If a new API test file is added for `/api/workspaces/:id/mentions`, include it in the focused `bun run test:run` command.

## Acceptance Criteria

- In `/chat`, typing `@` shows both connections and projects.
- In `/chat/:id`, typing `@` shows both connections and projects.
- In `/chat/:id?newThread=1`, typing `@` in the editable composer shows both connections and projects.
- A BigQuery connection named `Prod` appears for `@Prod`, `@big query`, and `@bigquery`.
- Refreshing mention sources on @ menu open updates both projects and connections.
- Mention slug generation and server-side `⟦ref: ...⟧` expansion remain compatible with existing transcripts.

