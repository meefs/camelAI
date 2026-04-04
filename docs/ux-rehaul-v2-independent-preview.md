# UX Rehaul — Variant 2: Project-Scoped Independent Preview Panel

---

## Summary

Introduce **projects** (groups of related chats), **multi-chat tabs**, and a **workspace-accordion sidebar** to support parallel workloads. In this variant, the preview panel is **independent and project-scoped** — it persists across chat tab switches within a project, accumulates files from any chat, and resets when switching projects.

### What makes Variant 2 different from Variant 1

The single difference is the preview panel behavior:

| | Variant 1 | Variant 2 (this plan) |
|---|---|---|
| **Preview panel scope** | Owned by active chat tab | Owned by active project |
| **On chat tab switch** | Preview resets to that chat's files | Preview stays the same |
| **File accumulation** | Files only from current chat | Files from any chat in the project |
| **Tab bar layout** | Chat tabs above, preview tabs in preview panel | Chat tabs AND preview/file tabs share the same tab bar |

### Key concepts

- **Project**: A lightweight group of chats within a workspace. Created automatically when a user starts a new chat. Auto-named from the first chat's topic. Renameable.
- **Multi-chat tabs**: A top tab bar shows open chats within the active project, **plus** open file/preview tabs in the same bar. Users can have multiple chats running in parallel.
- **Unified tab bar**: Chat tabs and file preview tabs are peers in the same horizontal bar. Clicking a chat tab shows the chat. Clicking a file tab shows the file preview. The `+` button creates a new chat.
- **Forking**: At any message, a user can fork the conversation into a new chat within the same project.
- **Context pills**: When composing in one chat, users can optionally attach summaries from sibling chats in the same project.
- **Multi-workspace**: Users work across all workspaces in their org simultaneously. No "active workspace."

---

## Target Layout

```
┌──────────────┬──────────────────────────────────────────────────────────────────┐
│  Sidebar     │  ┌────────────────┬─────────────┬──────────┬──────────┬───┐     │
│              │  │ ● Build dashbrd│ API endpnts │ app.py × │ data.csv │ + │     │
│▼ WORKSPACE A │  └────────────────┴─────────────┴──────────┴──────────┴───┘     │
│  ● Build     │           ↑ chat tabs ↑            ↑ file tabs ↑                │
│    dashboard │  ┌──────────────────────────────────────────────────────────┐    │
│  ◉ Fix auth  │  │                                                          │    │
│    Analytics │  │  Active tab content:                                     │    │
│              │  │  - Chat tab selected → chat messages + composer           │    │
│▶ WORKSPACE B │  │  - File tab selected → file preview (code, notebook, etc)│    │
│  (● if busy  │  │                                                          │    │
│   & collapsed│  │                                                          │    │
│              │  │  ┌───────────────────────┐                               │    │
│  ────────────│  │  │Context: ☑ Build dshbrd│  (only visible on chat tabs)  │    │
│  History     │  │  ├───────────────────────┤                               │    │
│  Apps        │  │  │ Message...    [Send]  │                               │    │
│  Connections │  │  └───────────────────────┘                               │    │
│  ────────────│  └──────────────────────────────────────────────────────────┘    │
│  ⚙ Settings  │                                                                 │
│  ? Help      │                                                                 │
│  👤 User     │                                                                 │
└──────────────┴─────────────────────────────────────────────────────────────────┘
```

**Key visual detail:** There is no separate preview panel split. Chat and file content share the same content area, and the user picks what to view via the unified tab bar. This gives the full width to whichever tab is active.

Alternatively, the user could opt into a side-by-side split (chat on left, file on right) — but the default is single-pane with the tab bar. Implement the single-pane first; split can come later.

---

## Part 1: Data Model — Projects

### 1.1 New concept: Project

A project groups threads within a workspace. It lives in `OrgDO` alongside the existing thread records.

**Schema (OrgDO SQLite):**
```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
```

**Additional: project-level preview state**

Store which files are open in the preview for each project:

```sql
CREATE TABLE IF NOT EXISTS project_preview_tabs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_source TEXT NOT NULL DEFAULT 'workspace',  -- 'workspace' | 'upload' | 'output'
  label TEXT NOT NULL,  -- display name
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preview_tabs_project ON project_preview_tabs(project_id);
```

This is optional for v1 — you can start with preview tabs in client-side state and persist later.

**RPC methods on OrgDO:**
- `createProject(workspaceId: string, name?: string): Project`
- `getProject(projectId: string): Project | null`
- `listProjects(workspaceId: string): Project[]`
- `updateProjectName(projectId: string, name: string): void`
- `deleteProject(projectId: string): void`

### 1.2 Thread → Project association

Add `project_id` column to the existing threads table in OrgDO:

```sql
ALTER TABLE threads ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
```

Threads with `project_id = NULL` are standalone (legacy threads). The UI treats null-project threads as single-chat projects.

**Updated RPC methods:**
- `createThread(workspaceId, ...)` → accepts optional `projectId` parameter
- `getThreadsForProject(projectId: string): Thread[]`
- New: `getProjectsWithThreadCounts(workspaceId: string): ProjectWithCounts[]`

### 1.3 Fork metadata on threads

Add `forked_from_thread_id` and `forked_at_message_index` columns to threads:

```sql
ALTER TABLE threads ADD COLUMN forked_from_thread_id TEXT;
ALTER TABLE threads ADD COLUMN forked_at_message_index INTEGER;
```

---

## Part 2: Remove "Active Workspace" Concept

### 2.1 Session model changes

**File:** `src/lib/auth.server.ts`

The `Session` interface currently has `workspace_id: string | null`. This stays in the cookie for backward compat but is no longer authoritative. The frontend decides which workspace to interact with based on user navigation.

**Changes to `requireAuthContext()`:**
- Stop selecting a `currentWorkspace`. Return `workspaces: WorkspaceWithAccess[]` but NOT `currentWorkspace`.
- Remove fallback logic that picks a default workspace.
- Remove re-signing the session cookie when workspace changes.

**File:** `src/types.ts`

```typescript
export interface AuthState {
  user: User | null;
  currentOrg: Organization | null;
  // REMOVED: currentWorkspace
  orgs: OrgMembership[];
  onboarding?: OnboardingPreferences | null;
  workspaces?: WorkspaceWithAccess[];
  allWorkspaces?: WorkspaceWithAccess[];
  orgWorkspaceCount?: number;
  loading: boolean;
  error: string | null;
}
```

### 2.2 Update `useAuthData` consumers

**File:** `src/hooks/use-auth-data.ts`

The hook no longer returns `currentWorkspace`. Any component that reads `currentWorkspace` needs to either:
- Accept a `workspaceId` prop from its parent
- Read the workspace ID from the URL or from the active project's workspace

Search for all usages of `currentWorkspace` in `src/` and update each one. Key files:
- `src/components/sidebar/app-sidebar.tsx` — rewritten (Part 3)
- `src/components/sidebar/workspace-switcher.tsx` — deleted
- `src/routes/_app.chat._index.tsx` — needs workspace from URL/context
- `src/routes/_app.chat.$id.tsx` — thread already has workspace_id
- `src/routes/_app.history.tsx` — now shows all workspaces by default
- `src/routes/_app.apps.tsx` — now shows all workspaces by default
- `src/routes/_app.connections.tsx` — now shows all workspaces by default
- `src/components/Chat.tsx` — receives workspaceId as prop already

### 2.3 Route changes

**File:** `src/routes.ts`

Add workspace-scoped chat routes:

```typescript
route('chat/ws/:workspaceId', 'routes/_app.chat.workspace.tsx'),  // new chat in specific workspace
route('chat/:id', 'routes/_app.chat.$id.tsx'),                    // existing thread (workspace inferred)
```

---

## Part 3: Sidebar Rewrite

### 3.1 New sidebar structure

**File:** `src/components/sidebar/app-sidebar.tsx` — full rewrite

```
┌──────────────────────┐
│  camelAI             │
│                      │
│ ▼ Production App     │  ← workspace (expanded, collapsible)
│   ● Build dashboard  │  ← project (pulsing dot = running)
│   ◉ Fix auth bug     │  ← project (amber dot = needs attention)
│     Analytics        │  ← project (no icon = idle)
│   + New chat         │  ← create new project in this workspace
│                      │
│ ▶ Marketing Site  ●  │  ← workspace (collapsed, dot shows busy)
│                      │
│ ────────────────     │
│ History              │
│ Apps                 │
│ Connections          │
│ ────────────────     │
│ ⚙ Settings           │
│ ? Help               │
│ 👤 User              │
└──────────────────────┘
```

**Implementation:**

Use `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` for each workspace.

```tsx
<Collapsible defaultOpen={hasActiveProject}>
  <SidebarMenuItem>
    <CollapsibleTrigger asChild>
      <SidebarMenuButton>
        <ChevronRight className="transition-transform [[data-state=open]_&]:rotate-90" />
        <span>{workspace.name}</span>
        {/* Status dot ONLY when collapsed */}
        {isCollapsed && <ProjectStatusDot status={workspaceAggregateStatus} />}
      </SidebarMenuButton>
    </CollapsibleTrigger>
  </SidebarMenuItem>
  <CollapsibleContent>
    <SidebarMenuSub>
      {projects.map(project => (
        <SidebarMenuSubItem key={project.id}>
          <SidebarMenuSubButton
            isActive={project.id === activeProjectId}
            onClick={() => switchProject(project.id)}
          >
            <ProjectStatusDot status={project.status} />
            <span>{project.name}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
      <SidebarMenuSubItem>
        <SidebarMenuSubButton onClick={() => createNewChat(workspace.id)}>
          <Plus className="size-3" />
          <span className="text-muted-foreground">New chat</span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    </SidebarMenuSub>
  </CollapsibleContent>
</Collapsible>
```

### 3.2 Status indicators

Follow the existing tool-call pattern (`src/components/tool-call/tool-call.tsx`):

```tsx
function ProjectStatusDot({ status }: { status: 'running' | 'unread' | 'idle' }) {
  if (status === 'idle') return null;
  return (
    <span className={cn(
      "w-1.5 h-1.5 rounded-full shrink-0",
      status === 'running' && "bg-blue-500 animate-pulse motion-reduce:animate-none",
      status === 'unread' && "bg-amber-500",
    )} />
  );
}
```

**Cascading rules:**
- **When expanded:** Status dots on project lines only. NO dot on the workspace header.
- **When collapsed:** Single dot on workspace header using highest-priority status (`running` > `unread` > `idle`).

### 3.3 Hover tooltip on projects

Use `Tooltip` / `TooltipContent` / `TooltipTrigger`. Single line: `"3 chats"` or `"3 chats · 1 needs review"`.

### 3.4 Data loading

The `_app.tsx` layout loader fetches project lists for all workspaces:

```typescript
const projectsByWorkspace = await Promise.all(
  workspaces.map(async (ws) => ({
    workspaceId: ws.id,
    projects: await orgDO.getProjectsWithThreadCounts(ws.id),
  }))
);
```

### 3.5 Remove workspace-switcher.tsx

Delete `src/components/sidebar/workspace-switcher.tsx`.

---

## Part 4: Unified Tab Bar (Chat + File Tabs)

This is the core differentiator of Variant 2. Chat tabs and file preview tabs share a single horizontal bar.

### 4.1 New component: `UnifiedTabBar`

**File:** `src/components/unified-tab-bar.tsx`

```
┌──────────────────┬─────────────┬──────────┬──────────┬───┐
│ ● Build dashboard│ API endpnts │ app.py × │ data.csv │ + │
│     (chat)       │   (chat)    │  (file)  │  (file)  │   │
└──────────────────┴─────────────┴──────────┴──────────┴───┘
```

**Tab types:**
```typescript
type Tab =
  | { kind: 'chat'; threadId: string; name: string; status: 'idle' | 'running' | 'unread' }
  | { kind: 'file'; fileId: string; name: string; target: PreviewTarget };
```

**Props:**
```typescript
interface UnifiedTabBarProps {
  tabs: Tab[];
  activeTabId: string; // threadId or fileId
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewChatTab: () => void;
}
```

**Visual distinction between chat and file tabs:**
- Chat tabs: no icon prefix (or a small `MessageSquare` icon)
- File tabs: `FileCode2` icon prefix, monospace filename
- Chat tabs with status get the pulsing/amber dot
- Both types have `×` close on hover

**Styling:** Same as Variant 1's tab bar (`h-10`, `bg-muted/30` for inactive, etc.) but now accommodates both types.

### 4.2 Tab state management

**File:** `src/hooks/use-project-tabs.ts`

```typescript
interface ProjectTabState {
  activeProjectId: string | null;
  tabs: Tab[];  // ordered list of chat + file tabs
  activeTabId: string | null;
}
```

**Key behavior:**
- When switching projects, the entire tab set swaps. Each project has its own `Tab[]` state.
- File tabs are **project-scoped** — they persist when switching between chat tabs within the same project, but are cleared/swapped when the user clicks into a different project.
- Store per-project tab state in a `Map<projectId, Tab[]>` in a React context.
- Persist to `sessionStorage` keyed by project ID.

**Actions:**
- `switchProject(projectId)` — load that project's tabs. If no saved state, open the most recent chat.
- `openChatTab(threadId, name)` — add chat tab if not present, focus it
- `openFileTab(target: PreviewTarget)` — add file tab if not present, focus it
- `closeTab(id)` — remove, focus adjacent
- `addNewChatTab(workspaceId, projectId)` — create thread, add tab, focus it
- `setActiveTab(id)` — focus any tab

### 4.3 Content area — conditional rendering

When a chat tab is active, render the full `Chat` component (messages + composer). When a file tab is active, render the file preview (using existing preview panel components, but full-width since there's no split).

```tsx
function ProjectContent({ activeTab, ...props }) {
  if (!activeTab) return <EmptyState />;

  if (activeTab.kind === 'chat') {
    return (
      <Chat
        key={activeTab.threadId}
        threadId={activeTab.threadId}
        workspaceId={workspaceId}
        {...chatProps}
      />
    );
  }

  if (activeTab.kind === 'file') {
    return (
      <FilePreviewFullWidth
        target={activeTab.target}
        workspaceId={workspaceId}
      />
    );
  }
}
```

### 4.4 How files get added to the tab bar

When the agent produces a file or the chat references a file, a clickable file chip appears in the assistant message. Clicking it calls `openFileTab(target)` which adds it to the unified tab bar.

This replaces the current behavior where files open in the split preview panel. In Variant 2, files are first-class tabs.

**Modify in `Chat.tsx`:** Replace `setPreviewTarget(...)` calls with `openFileTab(...)` calls. Everywhere a file reference is clickable in chat messages (the `FileLink` component in tool calls, or inline file references), hook into the tab system instead of the old preview panel.

---

## Part 5: Chat Area Updates

### 5.1 No split preview panel

Since files are tabs in the unified bar, the `ResizablePanelGroup` split in `Chat.tsx` is **removed** for Variant 2. The chat content area takes full width when a chat tab is active. File content takes full width when a file tab is active.

**Remove from `Chat.tsx`:**
- The `ResizablePanelGroup` / `ResizableHandle` / second `ResizablePanel`
- The `previewPanelBody` rendering
- The `previewTabs` state (replaced by project-level tab state)

The chat is always full-width: `<div className="flex flex-col h-full">{chatPanelContent}</div>`

### 5.2 Fork button on messages

Same as Variant 1. Add a `GitFork` icon button to message hover actions.

**Fork handler:**
1. API call to create forked thread in same project
2. Clone messages up to clicked message
3. Set `forked_from_thread_id` and `forked_at_message_index`
4. Name it `⑂ {parentThreadTitle}`
5. Add as new chat tab in the unified bar, focus it

**API route:** `POST /api/workspaces/:id/chat/fork`

### 5.3 Context pills in the composer

Same as Variant 1. Rendered above `PromptInput` when the project has sibling chats. Toggleable badges for sibling chats.

---

## Part 6: Full-Width File Preview

### 6.1 New component: `FilePreviewFullWidth`

**File:** `src/components/file-preview-full-width.tsx`

When a file tab is active, this component renders the file content at full width (no split). Reuse existing preview renderers:

- Code files → Shiki syntax highlighting (reuse from `src/components/chat-file-preview/`)
- Notebooks → notebook renderer
- Markdown → markdown renderer
- Images → image preview
- CSV/TSV → table viewer

**Structure:**
```tsx
function FilePreviewFullWidth({ target, workspaceId }: Props) {
  // Toolbar at top (refresh, open external, download)
  // Content area (full width, full height)
  return (
    <div className="flex flex-col h-full">
      <FilePreviewToolbar target={target} onRefresh={...} />
      <div className="flex-1 overflow-auto">
        <FilePreviewContent target={target} workspaceId={workspaceId} />
      </div>
    </div>
  );
}
```

Reuse existing `PreviewToolbar` logic from `src/components/preview-panel/preview-toolbar.tsx` but without the tab row (tabs are now in the unified bar).

---

## Part 7: Update History, Apps, Connections Pages

### 7.1 History page

**File:** `src/routes/_app.history.tsx`

Change filter from `this-workspace | all-workspaces` to per-workspace tabs:

```
┌─────┬──────────────┬──────────────┬──────────────┐
│ All │ Production   │ Marketing    │ Dev Sandbox  │
└─────┴──────────────┴──────────────┴──────────────┘
```

**Loader:** Default to "All", add per-workspace filter options. Return workspace list for tab rendering.

**Component:** Use `Tabs` / `TabsList` / `TabsTrigger`. First tab "All", then one per workspace.

### 7.2 Apps page

Same treatment — per-workspace tabs.

### 7.3 Connections page

Same treatment — per-workspace tabs.

---

## Part 8: New Chat / Welcome Page

### 8.1 Workspace-scoped new chat

**File:** `src/routes/_app.chat.workspace.tsx` (new route at `/chat/ws/:workspaceId`)

Looks like the existing welcome page, filtered to that workspace. Creates a project + thread when user sends first message.

### 8.2 Project auto-naming

Same as Variant 1 — project mirrors the first chat's auto-generated title.

---

## Part 9: Implementation Order

1. **Data model** — Projects table, thread.project_id, fork columns in OrgDO.
2. **Remove active workspace** — Update AuthState/AuthContext, fix all consumers.
3. **Sidebar rewrite** — Workspace accordion + project list.
4. **Unified tab bar** — Build `UnifiedTabBar`, `useProjectTabs` hook, wire into layout.
5. **Remove split preview** — Strip `ResizablePanelGroup` from `Chat.tsx`. Chat goes full-width.
6. **Full-width file preview** — Build `FilePreviewFullWidth`, wire file clicks to `openFileTab`.
7. **Conditional content rendering** — Chat tab → `Chat` component, file tab → `FilePreviewFullWidth`.
8. **Forking** — Fork API, fork button, tab opening.
9. **Context pills** — Build component, integrate into composer.
10. **History/Apps/Connections** — Per-workspace filter tabs.
11. **New chat page** — Workspace-scoped route.
12. **Polish** — Status cascading, tooltips, animations, empty states, `sessionStorage` persistence.

---

## Key Files to Modify

| File | Change |
|------|--------|
| `workers/main/src/durable-objects.ts` | Add projects table, project RPC methods, thread.project_id |
| `src/types.ts` | Remove `currentWorkspace` from `AuthState`, add `Project` + `Tab` types |
| `src/lib/auth.server.ts` | Remove active workspace logic |
| `src/hooks/use-auth-data.ts` | Remove `currentWorkspace` |
| `src/routes/_app.tsx` | Load projects for all workspaces |
| `src/components/sidebar/app-sidebar.tsx` | Full rewrite — workspace accordion + projects |
| `src/components/sidebar/workspace-switcher.tsx` | Delete |
| `src/components/unified-tab-bar.tsx` | New — combined chat + file tab bar |
| `src/hooks/use-project-tabs.ts` | New — project-scoped tab state |
| `src/components/Chat.tsx` | Remove ResizablePanelGroup split, remove preview panel, add fork button, integrate context pills, replace file click handlers |
| `src/components/file-preview-full-width.tsx` | New — full-width file preview for file tabs |
| `src/components/context-pills.tsx` | New — sibling chat context toggles |
| `src/routes/_app.chat._index.tsx` | Update for no-active-workspace |
| `src/routes/_app.chat.$id.tsx` | Infer workspace from thread |
| `src/routes/_app.chat.workspace.tsx` | New — workspace-scoped new chat |
| `src/routes/_app.history.tsx` | Per-workspace filter tabs |
| `src/routes/_app.apps.tsx` | Per-workspace filter tabs |
| `src/routes/_app.connections.tsx` | Per-workspace filter tabs |
| `src/routes.ts` | Add `/chat/ws/:workspaceId` route |
