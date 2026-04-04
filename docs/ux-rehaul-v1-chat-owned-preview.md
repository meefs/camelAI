# UX Rehaul — Variant 1: Chat-Owned Preview Panel

---

## Summary

Introduce **projects** (groups of related chats), **multi-chat tabs**, and a **workspace-accordion sidebar** to support parallel workloads. In this variant, the preview panel is **tied to the active chat tab** — switching tabs swaps the preview content.

### Key concepts

- **Project**: A lightweight group of chats within a workspace. Created automatically when a user starts a new chat. Auto-named from the first chat's topic. Renameable. Think of it as "what I'm working toward" — building an app, investigating a bug, running analytics.
- **Multi-chat tabs**: A top tab bar shows open chats within the active project. Users can have multiple chats running in parallel. `+` creates a new chat in the same project.
- **Forking**: At any message, a user can fork the conversation into a new chat (cloning history up to that point) within the same project.
- **Context pills**: When composing in one chat, users can optionally attach summaries from sibling chats in the same project.
- **Multi-workspace**: Users work across all workspaces in their org simultaneously. No "active workspace" — workspaces are collapsible sections in the sidebar.

---

## Target Layout

```
┌──────────────┬─────────────────────────────────────────────────────────────────┐
│  Sidebar     │  ┌──────────────────┬──────────────────────┬───┐               │
│              │  │ ● Build dashbrd  │ ⑂ Try D3 instead    │ + │               │
│▼ WORKSPACE A │  └──────────────────┴──────────────────────┴───┘               │
│  ● Build     │  ┌───────────────────────────┬─────────────────────────────┐   │
│    dashboard │  │                           │                             │   │
│  ◉ Fix auth  │  │  Chat Messages            │  Preview (this chat's)     │   │
│    Analytics │  │                           │                             │   │
│              │  │                           │  ┌────────┬──────────┐     │   │
│▶ WORKSPACE B │  │                           │  │chart.ts│ index.tsx│     │   │
│  (● visible  │  │                           │  └────────┴──────────┘     │   │
│   if busy &  │  │ ┌───────────────────────┐ │                             │   │
│   collapsed) │  │ │Context: ☑ Build dshbrd│ │  (switches when you        │   │
│              │  │ ├───────────────────────┤ │   change chat tabs)        │   │
│  ────────────│  │ │ Message...    [Send]  │ │                             │   │
│  History     │  │ └───────────────────────┘ │                             │   │
│  Apps        │  └───────────────────────────┴─────────────────────────────┘   │
│  Connections │                                                                │
│  ────────────│                                                                │
│  ⚙ Settings  │                                                                │
│  ? Help      │                                                                │
│  👤 User     │                                                                │
└──────────────┴─────────────────────────────────────────────────────────────────┘
```

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

Threads with `project_id = NULL` are standalone (legacy threads, or threads not yet assigned). The UI treats null-project threads as single-chat projects.

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

The `Session` interface currently has `workspace_id: string | null`. This stays in the cookie for backward compat but is no longer authoritative for determining what the user sees. Instead, the frontend decides which workspace to interact with based on user navigation.

**Changes to `requireAuthContext()`:**
- Stop selecting a `currentWorkspace`. The returned `AuthContext` should include `workspaces: WorkspaceWithAccess[]` (all accessible in current org) but NOT `currentWorkspace`.
- Remove the fallback logic that picks a default workspace.
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
- Accept a `workspaceId` prop from its parent (based on sidebar/route context)
- Read the workspace ID from the URL or from the active project's workspace

Search for all usages of `currentWorkspace` in `src/` and update each one. Key files:
- `src/components/sidebar/app-sidebar.tsx` — will be rewritten (Part 3)
- `src/components/sidebar/workspace-switcher.tsx` — will be removed
- `src/routes/_app.chat._index.tsx` — needs workspace from URL/context
- `src/routes/_app.chat.$id.tsx` — thread already has workspace_id
- `src/routes/_app.history.tsx` — now shows all workspaces by default
- `src/routes/_app.apps.tsx` — now shows all workspaces by default
- `src/routes/_app.connections.tsx` — now shows all workspaces by default
- `src/components/Chat.tsx` — receives workspaceId as prop already

### 2.3 Workspace switching API

**File:** `src/routes/api/auth.switch-workspace.ts`

Keep this endpoint but it now only updates the session cookie's `workspace_id` for backward compat with any remaining server-side code that reads it. The frontend no longer calls this when navigating between workspaces — it just renders different workspace content directly.

### 2.4 Route changes

**File:** `src/routes.ts`

Add workspace-scoped chat routes:

```typescript
route('chat/ws/:workspaceId', 'routes/_app.chat.workspace.tsx'),  // new chat in specific workspace
route('chat/:id', 'routes/_app.chat.$id.tsx'),                    // existing thread (workspace inferred from thread)
```

The new `/chat/ws/:workspaceId` route replaces the old `/chat` welcome page when a user clicks "New chat" under a specific workspace.

---

## Part 3: Sidebar Rewrite

### 3.1 New sidebar structure

**File:** `src/components/sidebar/app-sidebar.tsx` — full rewrite

Replace the flat nav list (New Chat, Computer, History, Connections, Apps) with:

```
┌──────────────────────┐
│  camelAI             │  ← branding / org name
│                      │
│ ▼ Production App     │  ← workspace (expanded, collapsible)
│   ● Build dashboard  │  ← project (pulsing dot = running)
│   ◉ Fix auth bug     │  ← project (filled dot = needs attention)
│     Analytics        │  ← project (no icon = idle)
│   + New chat         │  ← create new project in this workspace
│                      │
│ ▶ Marketing Site  ●  │  ← workspace (collapsed, dot shows busy)
│                      │
│ ────────────────     │
│ History              │  ← kept as nav link
│ Apps                 │  ← kept as nav link
│ Connections          │  ← kept as nav link
│ ────────────────     │
│ ⚙ Settings           │
│ ? Help               │
│ 👤 User              │
└──────────────────────┘
```

**Implementation:**

Use `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` from `@/components/ui/collapsible` for each workspace section.

```tsx
// For each workspace
<Collapsible defaultOpen={hasActiveProject}>
  <SidebarMenuItem>
    <CollapsibleTrigger asChild>
      <SidebarMenuButton>
        <ChevronRight className="transition-transform [[data-state=open]_&]:rotate-90" />
        <span>{workspace.name}</span>
        {/* Show status dot ONLY when collapsed and workspace has activity */}
        {isCollapsed && statusDot}
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
            {statusIcon(project)} {/* pulsing dot or attention dot */}
            <span>{project.name}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
      {/* New chat button */}
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
- A project is "running" if any of its chats is currently streaming.
- A project is "unread" if any of its chats completed a run and the user hasn't viewed it.
- **When the workspace accordion is expanded:** Show the status dot next to each project. Do NOT also show a status dot on the workspace header. This avoids redundant visual noise.
- **When the workspace accordion is collapsed:** Show a single status dot on the workspace header row. Use the highest-priority status among all projects (`running` > `unread` > `idle`).

### 3.3 Hover tooltip on projects

Use `Tooltip` / `TooltipContent` / `TooltipTrigger` from `@/components/ui/tooltip`.

Show a single line: `"3 chats"` or `"3 chats · 1 needs review"` or `"2 chats · 1 running"`.

### 3.4 Data loading for sidebar

The `_app.tsx` layout loader should fetch project lists for all workspaces in the current org:

```typescript
// In _app.tsx loader
const workspaces = authContext.workspaces;
const projectsByWorkspace = await Promise.all(
  workspaces.map(async (ws) => ({
    workspaceId: ws.id,
    projects: await orgDO.getProjectsWithThreadCounts(ws.id),
  }))
);
```

This data is passed to `AppSidebar` via loader data.

### 3.5 Remove workspace-switcher.tsx

Delete `src/components/sidebar/workspace-switcher.tsx`. It's replaced by the workspace accordion sections.

---

## Part 4: Chat Tab Bar

### 4.1 New component: `ChatTabBar`

**File:** `src/components/chat-tab-bar.tsx`

A horizontal tab bar rendered between the page header and the chat content area. Shows all open chats within the active project.

```
┌──────────────────┬────────────────────┬───────────────┬───┐
│ ● Build dashboard│  API endpoints     │ ◉ Fix layout  │ + │
└──────────────────┴────────────────────┴───────────────┴───┘
```

**Props:**
```typescript
interface ChatTabBarProps {
  tabs: Array<{
    threadId: string;
    name: string;
    status: 'idle' | 'running' | 'unread';
  }>;
  activeTabId: string | null;
  onSelectTab: (threadId: string) => void;
  onCloseTab: (threadId: string) => void;
  onNewTab: () => void;
}
```

**Styling:**
- Height: `h-10`
- Active tab: `bg-background border-b-2 border-primary text-foreground font-medium`
- Inactive tab: `bg-muted/30 text-muted-foreground hover:text-foreground`
- Close `×`: visible on hover, `opacity-0 group-hover:opacity-100`
- `+` button: `text-muted-foreground hover:text-foreground` with `Plus` icon
- Status indicators: same `ProjectStatusDot` component (pulsing blue for running, amber for unread)
- Overflow: horizontally scrollable, no wrapping

### 4.2 Tab state management

Create `src/hooks/use-chat-tabs.ts`:

```typescript
interface ChatTabState {
  activeProjectId: string | null;
  openTabs: string[]; // thread IDs
  activeTabId: string | null;
}
```

This state lives in a React context so both the sidebar and tab bar can interact with it. Store in `sessionStorage` for persistence across navigation.

**Actions:**
- `switchProject(projectId)` — load project's threads into tabs, focus first unread or most recent
- `openTab(threadId)` — add to tabs if not present, focus it
- `closeTab(threadId)` — remove, focus adjacent
- `addNewTab(workspaceId, projectId)` — create thread, add tab, focus it
- `setActiveTab(threadId)` — focus a specific tab

---

## Part 5: Chat Area Updates

### 5.1 Preview panel — tied to active chat

This is the defining feature of Variant 1. When the user switches chat tabs, the preview panel swaps to show the files associated with that chat.

**Implementation:** The existing `previewTabs` state in `Chat.tsx` already works per-thread. The key change is that when the active tab changes (via `ChatTabBar`), a different `Chat` component instance renders (keyed by `threadId`), which naturally brings its own preview state.

The simplest approach: render `<Chat key={activeTabId} threadId={activeTabId} ... />` so React fully swaps the component. Each chat instance manages its own preview tabs.

For performance, you could keep inactive chats mounted but hidden (`display: none`) so they preserve scroll position and don't re-fetch messages. But start simple — remount on tab switch — and optimize later if needed.

### 5.2 Fork button on messages

**File:** `src/components/Chat.tsx` (or the message rendering component within it)

Add a fork button (`GitFork` icon from lucide-react) to the hover actions on each message bubble. Place it alongside the existing copy/retry actions.

```tsx
<Button
  variant="ghost"
  size="icon-xs"
  className="text-muted-foreground hover:text-foreground"
  onClick={() => handleFork(messageIndex)}
  title="Fork conversation from here"
>
  <GitFork className="size-3" />
</Button>
```

**Fork handler:**
1. Call API to create a new thread in the same project
2. Clone messages up to (and including) the clicked message into the new thread
3. Set the thread's `forked_from_thread_id` and `forked_at_message_index`
4. Name it `⑂ {parentThreadTitle}`
5. Open it as a new tab and focus it

**API route:** `POST /api/workspaces/:id/chat/fork`
```typescript
// Request body:
{ sourceThreadId: string; messageIndex: number; projectId: string }
// Response:
{ thread: Thread }
```

The fork API reads the source thread's JSONL, takes messages up to `messageIndex`, writes them into the new thread's JSONL, and returns the new thread.

### 5.3 Context pills in the composer

**File:** `src/components/context-pills.tsx` (new)

Rendered above the `PromptInput` when the current project has sibling chats.

```tsx
interface ContextPillsProps {
  siblingChats: Array<{ threadId: string; title: string }>;
  selected: Set<string>; // thread IDs with context enabled
  onToggle: (threadId: string) => void;
}
```

Each pill is a small toggleable `Badge`:
- Selected: `variant="default"` (filled)
- Unselected: `variant="outline"`
- Prefix: `☑` or `☐`

When a pill is selected and the user sends a message, the send handler prepends a hidden system message containing a compact summary of the selected chat(s). Use the existing `/compact` summary mechanism or generate one via an API call.

**Integration point in `Chat.tsx`:**
- Fetch sibling thread list from the project
- Track which ones are toggled on in local state
- Before sending, if any are toggled on, prepend context as a `<camelai system message>` block

---

## Part 6: Update History, Apps, Connections Pages

### 6.1 History page

**File:** `src/routes/_app.history.tsx`

Change the filter from `this-workspace | all-workspaces` to per-workspace tabs:

```
┌─────┬──────────────┬──────────────┬──────────────┐
│ All │ Production   │ Marketing    │ Dev Sandbox  │
└─────┴──────────────┴──────────────┴──────────────┘
```

**Loader changes:**
- Default filter: `all` (show threads across all accessible workspaces)
- Additional filters: one per workspace ID
- Use existing `getThreadsPaginatedAllWorkspaces` for "All" tab
- Use existing `getThreadsPaginated` for per-workspace tabs
- Return `workspaces` list in loader data so the component can render tabs

**Component changes:**
- Use `Tabs` / `TabsList` / `TabsTrigger` from `@/components/ui/tabs`
- First tab: "All" (default)
- Subsequent tabs: one per workspace, labeled with workspace name
- Tab switching updates `?filter=` URL param and triggers revalidation

### 6.2 Apps page

**File:** `src/routes/_app.apps.tsx`

Same treatment as History — replace `this-workspace | all-workspaces` with per-workspace tabs.

### 6.3 Connections page

**File:** `src/routes/_app.connections.tsx`

Same treatment. Each tab shows connections for that workspace. "All" tab shows connections across all workspaces grouped or listed with a workspace label.

---

## Part 7: New Chat / Welcome Page

### 7.1 Workspace-scoped new chat

**File:** `src/routes/_app.chat.workspace.tsx` (new route at `/chat/ws/:workspaceId`)

When the user clicks "New chat" under a specific workspace in the sidebar, they land on this page. It looks like the existing welcome page but filtered to that workspace's data:

- Recent threads from this workspace only
- Apps deployed in this workspace only
- Connections for this workspace only
- The composer creates a thread in this workspace (and creates a new project for it)

**Loader:**
```typescript
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const workspaceId = params.workspaceId;
  // Verify access to this workspace
  // Load workspace-specific apps, threads, connections
  return { workspaceId, apps, recentThreads, connections };
}
```

**Action (thread creation):**
```typescript
export async function action({ request, context, params }: Route.ActionArgs) {
  const workspaceId = params.workspaceId;
  // Create project
  const project = await orgDO.createProject(workspaceId);
  // Create thread in project
  const thread = await chatDO.createThread(workspaceId, { projectId: project.id });
  return redirect(`/chat/${thread.id}`);
}
```

### 7.2 Project auto-naming

When the first chat in a project gets auto-titled (from the first user message), the project should also be named the same thing. Add a hook: after `ChatThreadDO` generates a thread title for the first user message, if the thread's project name is still empty, update the project name to match.

---

## Part 8: Project Creation Flow

Starting a new chat = starting a new project. The flow:

1. User clicks "New chat" under a workspace in the sidebar
2. Navigate to `/chat/ws/:workspaceId`
3. User sees the welcome page (filtered to that workspace)
4. User sends their first message
5. Thread is created, project is created (both unnamed initially)
6. Thread auto-titles → project mirrors the title
7. Project + thread appear in the sidebar
8. User can click `+` in the tab bar to add more chats to the same project
9. User can rename the project by double-clicking or right-click → rename in the sidebar

---

## Part 9: Implementation Order

Build in this sequence to keep things working at each step:

1. **Data model** — Add projects table + thread association in OrgDO. Add RPC methods. Add fork columns.
2. **Remove active workspace** — Update AuthState/AuthContext, update `useAuthData`, fix all consumers. This is the most surgical step.
3. **Sidebar rewrite** — Replace flat nav with workspace accordion + projects. Wire up real data.
4. **Chat tab bar** — Build the component, add the context/state management, wire into the chat layout.
5. **Preview panel** — Already works per-chat since `Chat.tsx` remounts per threadId. Verify it swaps correctly on tab switch.
6. **Forking** — Add fork API, fork button on messages, tab opening logic.
7. **Context pills** — Build component, integrate into composer, implement context summarization.
8. **History/Apps/Connections** — Update filter tabs to per-workspace.
9. **New chat page** — Add workspace-scoped route, wire sidebar "New chat" to it.
10. **Polish** — Status indicator cascading, hover tooltips, animations, empty states.

---

## Key Files to Modify

| File | Change |
|------|--------|
| `workers/main/src/durable-objects.ts` | Add projects table, project RPC methods, thread.project_id column |
| `src/types.ts` | Remove `currentWorkspace` from `AuthState`, add `Project` type |
| `src/lib/auth.server.ts` | Remove active workspace logic from `getAuthContext()` |
| `src/hooks/use-auth-data.ts` | Remove `currentWorkspace` from return type |
| `src/routes/_app.tsx` | Load projects for all workspaces, pass to sidebar |
| `src/components/sidebar/app-sidebar.tsx` | Full rewrite — workspace accordion + projects |
| `src/components/sidebar/workspace-switcher.tsx` | Delete |
| `src/components/chat-tab-bar.tsx` | New — top tab bar |
| `src/hooks/use-chat-tabs.ts` | New — tab state management |
| `src/components/Chat.tsx` | Add fork button, integrate context pills |
| `src/components/context-pills.tsx` | New — sibling chat context toggles |
| `src/routes/_app.chat._index.tsx` | Update for no-active-workspace |
| `src/routes/_app.chat.$id.tsx` | Infer workspace from thread, not session |
| `src/routes/_app.chat.workspace.tsx` | New — workspace-scoped new chat |
| `src/routes/_app.history.tsx` | Per-workspace filter tabs |
| `src/routes/_app.apps.tsx` | Per-workspace filter tabs |
| `src/routes/_app.connections.tsx` | Per-workspace filter tabs |
| `src/routes.ts` | Add `/chat/ws/:workspaceId` route |
