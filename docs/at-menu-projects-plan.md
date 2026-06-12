# At-Menu: @-Mention Projects — Plan

**Date:** 2026-06-11
**Branch:** `illianaa/davis`
**Primary files:**
- [src/lib/connection-mentions.ts](../src/lib/connection-mentions.ts) → renamed `src/lib/mentions.ts` — shared slug/parse/expand/rank utilities
- [src/components/connection-mention-menu/](../src/components/connection-mention-menu/) → renamed `src/components/at-mention-menu/` — menu popover, trigger hook, composer chip overlay, message chip
- [src/components/prompt-input.tsx](../src/components/prompt-input.tsx) — composer wiring, keyboard nav
- [src/components/Chat.tsx](../src/components/Chat.tsx), [src/components/welcome-screen/index.tsx](../src/components/welcome-screen/index.tsx) — data plumbing into the composer + message renderer
- [src/routes/_app.chat._index.tsx](../src/routes/_app.chat._index.tsx), [src/routes/_app.chat.$id.tsx](../src/routes/_app.chat.$id.tsx) — loaders (deferred projects, like connections)
- [workers/main/src/connection-mention-context.ts](../workers/main/src/connection-mention-context.ts) → renamed `workers/main/src/mention-context.ts` — server-side expansion + system-message section
- [workers/main/src/chat-thread-do.ts](../workers/main/src/chat-thread-do.ts), [workers/main/src/routes/websocket.ts](../workers/main/src/routes/websocket.ts) — per-turn call sites

**Backend audit notes (2026-06-11):**
- Keep `src/lib/mentions.ts` browser-safe. Do not import worker modules from this shared lib, even as a type-only convenience; define a small structural project-source type in the lib and let callers pass `WorkspaceProject[]` structurally. This avoids accidental value imports when the sandbox preview renderer bundles `markdown-renderer.tsx`.
- The old server helper returns early when `integrations.length === 0`. The new helper must not do that: project-only workspaces still need project mention expansion and the `## Referenced projects` block.
- Fetch connections and projects with independent failure handling at worker call sites. A `WORKSPACE_FS`/project-listing failure should degrade to connections-only, and a `WORKSPACE.getIntegrations()` failure should degrade to projects-only when possible.
- The `GET /api/workspaces/:id/projects` route is app-side, not a Worker route. Add it through React Router route generation, return mention DTOs only, set `Cache-Control: private, no-store`, and run type generation/typecheck before relying on its `+types` import.

---

## Objective

Users can already type `@` in the composer and pick a **connection** from a popover menu. This change adds **projects** to that same menu so `@projectname` tells the agent which project the user wants to work on.

In scope:

1. Populate the menu with the workspace's projects (from `WorkspaceFilesystemDO.listProjects()`), ranked into the **same single list** as connections — rows are differentiated per-row by icon and the right-aligned kind label, not by section grouping or kind-based ordering (product decision 2026-06-11).
2. Distinct iconography: connections keep their brand `IntegrationIcon`; projects get a monochrome Lucide `FolderGit2`.
3. Project mentions get the same chip treatment as connection mentions (composer overlay chip + hover card, chip in sent message bubbles).
4. Server-side: a matched `@project` mention is annotated inline (`⟦ref: project "<name>" id=<id>⟧`) and a `<camelai system message>` block tells the agent which project(s) the user referenced and how to address them (`location: "vm"`, `project: "<name>"`).
5. Rename the surface from "connection mention menu" to "**at-mention menu**" (components, lib, worker helper), leaving the door open for more kinds (files etc.) later.

Out of scope (explicitly): @-mentioning files, apps, threads, or people; an "Add a project" creation flow (projects are created by the agent, not a form); any change to the mention trigger conditions or chip visual style.

---

## Architecture: how a mention flows today, and where projects slot in

```text
                         CLIENT                                        SERVER
┌───────────────────────────────────────────────────┐   ┌─────────────────────────────────────┐
│ loaders (_app.chat._index / _app.chat.$id)        │   │ ChatThreadDO.applyConnectionMentions │
│   connectionsPromise ──► Chat.tsx / WelcomeScreen │   │ ForTurn (chat-thread-do.ts:7145,     │
│ + projectsPromise  (NEW)        │                 │   │ called at :7475 for every user turn) │
│                                 ▼                 │   │   getIntegrations()                  │
│             mentionables: AtMentionEntity[] (NEW) │   │ + workspaceFs.listProjects()  (NEW)  │
│                  │                    │           │   │            │                         │
│                  ▼                    ▼           │   │            ▼                         │
│           PromptInput          mentionSlugMap     │   │  applyMentionContext (renamed)       │
│      ┌────────┴─────────┐      (message chips     │   │   - expandMentions → ⟦ref:…⟧         │
│      ▼                  ▼       via markdown-     │   │   - "Available connections" block    │
│ AtMentionMenu   ComposerMention  renderer)        │   │   - "Referenced projects" block (NEW)│
│ (one ranked list)  Decorations                    │   │            │                         │
│      │           (textarea chips)                 │   │            ▼                         │
│      ▼                                            │   │   Pi agent sees name + description   │
│ insert "@camel_site "  ──── send over WS ────────────►│   and addresses the project by name  │
└───────────────────────────────────────────────────┘   └─────────────────────────────────────┘
```

Key existing mechanics that stay unchanged: the `@` trigger detection ([use-mention-trigger.ts](../src/components/connection-mention-menu/use-mention-trigger.ts)), slug charset and word-boundary rules, the `⟦ref:…⟧` annotation strip/parse machinery (it is already generic over any `⟦ref: …⟧` payload), the chip CSS, and the menu's popover anchoring/width logic.

---

## 1. Shared lib: generalize `connection-mentions.ts` → `src/lib/mentions.ts`

Rename the file and generalize the core types. All functions are already generic-ish (`<T extends MentionableIntegration>`); widen the base type and add a `kind` discriminator.

```ts
// src/lib/mentions.ts
export type MentionKind = 'connection' | 'project';

export interface MentionableConnection {
  kind: 'connection';
  id: string;
  integration_type: string;
  name: string;
  created_at?: number;            // ms epoch from WorkspaceIntegrationRecord/Integration
}

export interface MentionableProject {
  kind: 'project';
  id: string;                     // WorkspaceProject.id (ca-<ws>-<name>)
  name: string;                   // the agent-facing handle — names are unique per workspace
  description: string;
  project_kind: 'project' | 'clone';
  cloned_from_name?: string;      // set for clones (parent project name)
  created_at?: number;            // Date.parse(createdAt)
  updated_at?: number;            // Date.parse(updatedAt) — for the hover card
}

export type Mentionable = MentionableConnection | MentionableProject;
```

Function changes (keep them in this one file; it is imported by app code, workers, and tests):

| Function | Change |
|---|---|
| `slug(name)` | unchanged |
| `buildSlugMap` | signature becomes generic: `<T extends Mentionable>(items: readonly T[]): Map<string, T>`. Algorithm unchanged — one map across **both kinds**, so a project named like a connection gets the deterministic `-2` suffix by `created_at` asc, then `id`. This removes today's `as Map<string, Integration>` casts at call sites. |
| `filterMentionableConnections` | rename `filterMentionables`; logic unchanged (drop items whose name slugs to empty). |
| `rankMentionableConnections` | rename `rankMentionables<T extends Mentionable>(items, query): T[]`. **One interleaved list across both kinds** — the existing four-tier logic applies per item (kind-aware type matching), alphabetical within a tier. No kind-based blocks. See "Ranking & ordering" below. |
| `slugForIntegration` | rename `slugForMentionable`; unchanged otherwise. |
| `parseMentions` | unchanged logic; `MentionMatch.integration` renamed `MentionMatch.target: Mentionable \| null`. |
| `expandMentions` | annotation type token becomes kind-aware: connections keep `⟦ref: ${integration_type} "${name}" id=${id}⟧` **byte-identical to today**; projects emit `⟦ref: project "${name}" id=${id}⟧`. |
| `stripMentionAnnotations*` | unchanged — the regex `⟦ref:[^⟧]*⟧` and `id=` parsing already handle the project payload. |

Add a shared mapper used by both the React loaders and the worker (single source of truth for flattening clones). Keep the input type structural so this browser-imported file does **not** import anything from `workers/main/src/*`:

```ts
export interface MentionProjectSource {
  id: string;
  name: string;
  description?: string;
  kind?: 'project' | 'clone';
  createdAt?: string;
  updatedAt?: string;
  cloneSource?: { id: string; name: string; description?: string };
  clones?: MentionProjectCloneSource[];
}

export interface MentionProjectCloneSource {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function projectsToMentionables(projects: readonly MentionProjectSource[]): MentionableProject[] {
  // Flatten: each source project is one item; each entry in project.clones[]
  // is its own item with project_kind: 'clone' and cloned_from_name: parent.name.
  // created_at/updated_at = Date.parse(...); guard with Number.isFinite, else undefined.
}
```

`WorkspaceProject[]` and `WorkspaceProjectCloneSummary[]` satisfy this structurally at both call sites. This is safer than a type-only worker import because the same lib is pulled into the sandbox preview renderer through `markdown-renderer.tsx`.

### Ranking & ordering

There is **no kind-based grouping or kind-based ordering** — projects and connections compete in one ranked list, and each row's icon + right-aligned kind label do the differentiating (product decision 2026-06-11). `rankMentionables` runs every item through the same four tiers regardless of kind; within a tier, sort alphabetically by name exactly as today (`localeCompare`, sensitivity `base`). Empty query = one alphabetical list across both kinds. The menu renders the returned array in order and `prompt-input.tsx` drives keyboard nav over the same array, so visual order equals arrow-key order by construction.

Kind-aware tier matching:
- Connections: existing tiers (name prefix → slug prefix → integration-type/display-name prefix → substring). Unchanged.
- Projects: name prefix → slug prefix → the literal keywords `project` / `clone` in the type tier → name/slug substring. **Do not match against `description`** — descriptions are paragraphs and substring hits there make the menu feel random.

Determinism note for tests: name ties across kinds fall back to input order (`Array.prototype.sort` is stable, and the tier buckets are filled in input order). `mentionEntities` concatenates connections before projects (§2b), so an identically-named connection lists ahead of its project namesake.

### Lib tests — rename `tests/connection-mentions.test.ts` → `tests/mentions.test.ts`

Keep every existing case (update constructor fixtures to add `kind: 'connection'`). Add:
- Cross-kind slug collision: connection "Stripe" (created first) + project "stripe" → `stripe` / `stripe-2`, deterministic both insertion orders.
- `expandMentions` on a project: `hi @camel_site` → `hi @camel_site ⟦ref: project "camel-site" id=ca-…⟧` (note: annotation carries the **real name** with its dash; the slug mangles it, the name is the agent's handle).
- Connection annotations byte-identical to before (regression guard for old transcripts).
- `rankMentionables`: empty query → one alphabetical list across kinds; a name-prefix (tier 0) project outranks a substring-only (tier 3) connection and vice versa; a same-tier project and connection sort alphabetically regardless of kind; `proj` query matches all projects via the type-keyword tier; identical names across kinds keep input order (connection first per §2b concat order).
- `projectsToMentionables`: flattens nested `clones[]`, sets `cloned_from_name`, parses ISO dates, tolerates invalid dates.

---

## 2. Frontend data: getting projects to the composer

Projects currently have **no frontend read surface** — they live in `WorkspaceFilesystemDO` ([workers/main/src/workspace-filesystem-do.ts:414](../workers/main/src/workspace-filesystem-do.ts#L414)) and are only reachable through agent tools. Two additions, both mirroring the connections pattern:

### 2a. Deferred loader data (initial population)

In **both** chat loaders, next to the existing `connectionsPromise` ([_app.chat._index.tsx:304](../src/routes/_app.chat._index.tsx#L304), [_app.chat.$id.tsx:845](../src/routes/_app.chat.%24id.tsx#L845)):

```ts
const projectsPromise: Promise<MentionableProject[]> = workspaceId
  ? new WorkspaceFilesystemClient(env as never, workspaceId)
      .listProjects()
      .then(projectsToMentionables)
      .catch((error) => {
        console.error('Failed to load workspace projects:', error);
        return [];
      })
  : Promise.resolve([]);
```

- `_app.chat._index.tsx`: add `projects: projectsPromise` to the returned welcome data (and to the `welcomeData` type consumed by Chat/WelcomeScreen, plus the `resolvedWelcomeData` fallback at [Chat.tsx:1552](../src/components/Chat.tsx#L1552) with a module-level `EMPTY_MENTION_PROJECTS`).
- `_app.chat.$id.tsx`: add `projects: projectsPromise` to the loader return and pass `projects={projects}` into `<Chat>` at [line 1368](../src/routes/_app.chat.%24id.tsx#L1368). Add `[] as MentionableProject[]` to the early-return branches that already zero out `connections` (lines ~567, ~746, ~776).
- The `[]`-on-error fallback matches the existing connections behavior in these loaders: the mention menu is an enhancement, and the error is still logged.

### 2b. Chat.tsx: resolve + combine

Mirror the promise-resolution effect used for connections at [Chat.tsx:1560–1591](../src/components/Chat.tsx#L1560-L1591) with a `resolvedMentionProjects` state, then build one combined list that feeds everything downstream:

```ts
const mentionEntities = useMemo<AtMentionEntity[]>(() => [
  ...resolvedMentionConnections.map((c) => ({ ...c, kind: 'connection' as const })),
  ...resolvedMentionProjects,
], [resolvedMentionConnections, resolvedMentionProjects]);

const mentionSlugMap = useMemo(() => buildSlugMap(mentionEntities), [mentionEntities]);
```

`AtMentionEntity` goes in [src/types.ts](../src/types.ts):

```ts
import type { MentionableProject } from '@/lib/mentions';
export type AtMentionConnection = Integration & { kind: 'connection' };
export type AtMentionEntity = AtMentionConnection | MentionableProject;
```

(The UI needs the full `Integration` — `category`, `has_credentials`, `updated_at` — for icons and hover cards; the generic lib functions preserve the concrete type through `buildSlugMap`/`rankMentionables`, which is why the `as` casts disappear.)

`mentionSlugMap` is already passed into the message renderer; widening its value type to `AtMentionEntity` gives project chips in sent messages for free (§4c). `WelcomeScreen` does the same combine (it already resolves the connections promise at [welcome-screen/index.tsx:355–379](../src/components/welcome-screen/index.tsx#L355-L379)); its `ConnectedTools` slug lookup at line 425 must use the **combined** map so a colliding project name yields the correctly suffixed connection slug.

### 2c. Freshness: `GET /api/workspaces/:id/projects` + refetch when the menu opens

The common case for this feature is "agent just created project X in this conversation → user wants to `@X`". The loader snapshot would always be stale for that. Add a small read API and refetch on menu open:

- New route file `src/routes/api/workspaces.$id.projects.ts`, registered in [src/routes.ts](../src/routes.ts) next to the existing project content route (line ~201). Loader: validate `params.id`, call `requireWorkspaceAccess(request, context, workspaceId)` (from [workspaces.utils](../src/routes/api/workspaces.utils.ts)), then `new WorkspaceFilesystemClient(env as never, workspaceId).listProjects()` → `Response.json({ projects: projectsToMentionables(projects) }, { headers: { 'Cache-Control': 'private, no-store' } })`. Expose only the mention DTOs, not the full project registry (no VM ids/remotes/artifact status needed in the composer).
- Do not add an `action`; React Router loaders only answer GET/HEAD. Let `requireWorkspaceAccess` thrown `Response`s pass through unchanged, and log + return 500 only for unexpected failures. After adding the route to `src/routes.ts`, run the route type generation path (`bun run typecheck` or the repo's generated-types command) so `./+types/workspaces.$id.projects` exists.
- `PromptInput` gains an optional `onMentionMenuOpenChange?: (open: boolean) => void`, fired when `effectiveMenuOpen` transitions (a small `useEffect` on the boolean).
- `Chat.tsx` wires it to a `useFetcher`: on the rising edge, if >15s since last fetch, `fetcher.load(\`/api/workspaces/${workspaceId}/projects\`)`; when data arrives, `setResolvedMentionProjects(fetcher.data.projects)`. The menu re-ranks reactively — stale-while-revalidate, no spinner.
- WelcomeScreen skips this (no agent is running on the welcome screen to create projects mid-screen).

---

## 3. Menu UI: `AtMentionMenu` (renamed from `ConnectionMentionMenu`)

### Visual design

One ranked list — **no section headings, no kind-based ordering**. Rows from both kinds interleave by match quality; the icon and the right-aligned kind label are what tell them apart:

```text
╭──────────────────────────────────────────────────────────────────╮
│ ▣ camel-site                                             Project │ ← FolderGit2, muted mono icon
│ ▣ camel-site-v2                                            Clone │ ← highlighted row (bg-accent)
│ ◉ My Prod DB                                            Postgres │ ← brand IntegrationIcon (colored)
│ ◉ Slack                                                    Slack │
│ ◉ Stripe (Live)                                           Stripe │
╰──────────────────────────────────────────────────────────────────╯
┌──────────────────────────────────────────────────────────────────┐
│ Build the pricing page in @▌                                   ↑ │ ← composer (empty query)
└──────────────────────────────────────────────────────────────────┘
```

(The order shown is simply what an empty query produces — alphabetical across both kinds. With a typed query the tiers reorder it; a project can land between two connections and that is correct.)

Nothing at all (no projects, no connections) — zero-state unchanged:

```text
╭──────────────────────────────────────────────────────────────────╮
│ ＋ Add a connection                                              │
╰──────────────────────────────────────────────────────────────────╯
```

### Row anatomy (shadcn, matches the existing restyle)

Each row keeps the established `[icon] [name flex-1 truncate] [right-aligned meta]` layout from [index.tsx:173–188](../src/components/connection-mention-menu/index.tsx#L173-L188):

- **Connection row** — unchanged: `<IntegrationIcon type size={16} className="size-4 shrink-0" />`, name `min-w-0 flex-1 truncate font-medium`, meta `shrink-0 pl-3 text-xs text-muted-foreground` = registry `displayName`.
- **Project row** — icon `<FolderGit2 className="size-4 shrink-0 text-muted-foreground" />` (lucide-react ^0.562 has it); same name span; meta = `Project` or `Clone` (from `project_kind`). The monochrome muted icon vs. the colored brand logos is the kind differentiator at a glance — no background tiles, no color coding. (`Folder` is already taken by workspaces in [settings/workspaces-list.tsx:7](../src/components/settings/workspaces-list.tsx#L7); `FolderGit2` also matches what projects are — git-backed work areas.)
- **List structure** — one `CommandGroup`, no headings, no dividers: the DOM shape is identical to today's menu. Kind is conveyed entirely per-row (monochrome `FolderGit2` + `Project`/`Clone` label vs. colored brand icon + integration display name). Do not add section headers between kinds.

### Component API

```ts
export interface AtMentionMenuProps {
  open: boolean;
  query: string;
  items: AtMentionEntity[];          // was: connections: Integration[]
  anchorRef: RefObject<HTMLElement | null>;
  side?: 'top' | 'bottom';
  activeValue: string | null;        // composite `${kind}:${id}` — see below
  onActiveValueChange: (value: string | null) => void;
  onSelect: (item: AtMentionEntity) => void;
  onClose: () => void;
  onAddNewClick: () => void;         // still "Add a connection" — see zero-state
}
```

- `CommandItem value` becomes the composite `` `${item.kind}:${item.id}` `` (project ids `ca-…` and integration UUIDs shouldn't collide, but the composite makes that a non-thought and keeps the `data-value` scroll-into-view lookup exact).
- The menu calls `rankMentionables(items, query)` and renders the returned array in order — the same array the composer uses for keyboard nav, so highlight/arrow behavior needs no special casing.
- Zero-state rule generalizes from "no connections" to "**no items at all**": `showAddRow = items.length === 0`. When projects exist but connections don't, show the Projects list only — no add-row clutter (the `/connections` page remains the discovery path). There is intentionally no "Add a project" row: projects are created conversationally by the agent, not via a form.
- Popover sizing/anchoring/outside-click code is untouched.

### `prompt-input.tsx` wiring

- Prop rename: `mentionableConnections?: Integration[]` → `mentionables?: AtMentionEntity[]`. `onMentionAddNewClick` and `mentionMenuSide` unchanged. Callers: [Chat.tsx:4993](../src/components/Chat.tsx#L4993) passes `mentionEntities`, [welcome-screen/index.tsx:462](../src/components/welcome-screen/index.tsx#L462) passes its combined list.
- Internal renames, logic unchanged: `mentionableConnectionList` → `mentionableItems` (via `filterMentionables`), `filteredMentionConnections` → `rankedMentionables` (via `rankMentionables` — stays in lockstep with the menu because both call the same pure function on the same inputs), `activeMentionId` → `activeMentionValue` (composite values), `hasAnyConnections` → `hasAnyItems`, `insertMention(item: AtMentionEntity)` uses `slugForMentionable`.
- Keyboard handling (↑/↓/Enter/Tab/Escape at [prompt-input.tsx:293–334](../src/components/prompt-input.tsx#L293-L334)), the Escape lockout, IME guard, and the no-match auto-hide (`matchesAvailable`) all generalize by simple substitution — no behavioral change.

---

## 4. Chips: composer overlay, hover card, sent messages

### 4a. Chip style — identical on purpose

`MentionChip` ([mention-chip.tsx](../src/components/connection-mention-menu/mention-chip.tsx)) and the overlay rect background (`bg-muted` rounded-md) are reused as-is for projects. The kind is conveyed by the menu icon and the hover card, not by chip color — chips stay one calm visual family. Only the prop type widens: `integration: Integration | null` → `target: AtMentionEntity | null` (the chip only checks null-ness for the deleted/muted style).

### 4b. Composer overlay hover card

`ComposerMentionDecorations` ([composer-mention-overlay.tsx](../src/components/connection-mention-menu/composer-mention-overlay.tsx)): `slugMap` type widens to `Map<string, AtMentionEntity>`; measurement/positioning code untouched. `ChipHoverPreview` (line 129) branches on `kind`:

```text
Connection (unchanged):              Project (new):
┌────────────────────────┐           ┌──────────────────────────────┐
│ ◉ My Prod DB           │           │ ▣ camel-site                 │
│ Postgres · Databases   │           │ Project                      │   ← "Clone of camel-site" for clones
│ ● No credentials …     │           │ Marketing site rebuild with… │   ← description, line-clamp-2, muted
│ Updated 3 days ago     │           │ Updated today                │   ← omit row if updated_at undefined
└────────────────────────┘           └──────────────────────────────┘
```

Project branch markup mirrors the connection one: header row `FolderGit2 size-4 text-muted-foreground` + `text-sm font-medium` name; kind line `text-xs text-muted-foreground` (`Project`, or `Clone of <cloned_from_name>`); description `text-xs text-muted-foreground line-clamp-2`; reuse the existing `formatRelative` for the updated line. Same `HoverCardContent` shell (`min-w-[200px] max-w-[280px]`).

Where `description` comes from: it is a **required field** on the project record ([workspace-filesystem-do.ts:65](../workers/main/src/workspace-filesystem-do.ts#L65)), authored by the agent when it calls `create_project` and maintained via `set_project_description` — it is the same text the agent itself uses to disambiguate projects, so it is always present and meaningful. If it is somehow empty (defensive), omit the line rather than rendering a blank row.

### 4c. Sent messages

[markdown-renderer.tsx](../src/components/markdown-renderer.tsx) already chips any slug found in `mentionSlugMap` and resolves renames via the `⟦ref:… id=…⟧` annotation ids (`buildAnnotatedIdsBySlug`, `resolveMentionChipIntegration` → rename `resolveMentionChipTarget`). Because Chat now builds `mentionSlugMap` from the combined entity list (§2b), project mentions in history render as chips with zero additional renderer logic. Widen the `mentionSlugMap` prop type in `markdown-renderer.tsx`, [message-bubble.tsx](../src/components/message-bubble.tsx) (lines 364, 656), and [chat-messages-view.tsx](../src/components/chat-messages-view.tsx) pass-throughs. A `@slug` whose project was deleted resolves to `null` → existing muted "deleted" chip style.

---

## 5. Server side: tell the agent which project the user means

### 5a. `applyMentionContext` (renamed from `applyConnectionMentionContext`)

Rename `workers/main/src/connection-mention-context.ts` → `mention-context.ts`:

```ts
export function applyMentionContext(
  rawContent: string,
  sources: {
    integrations: WorkspaceIntegrationRecord[];
    projects: WorkspaceProject[];     // nested, as returned by listProjects()
  },
): AppliedMentionContext
```

- Map integrations via the existing `toMentionable` (now adding `kind: 'connection'`); map projects via the **shared** `projectsToMentionables` from `src/lib/mentions.ts` (same flattening the client uses — this is what keeps client-inserted slugs and server-resolved slugs identical, including cross-kind `-2` suffixes).
- One combined `buildSlugMap` over both kinds; `expandMentions` annotates both.
- Preserve the `!rawContent` fast return, but remove the old `integrations.length === 0` fast return. A workspace with zero connections but one mentioned project must still produce the project annotation and context block.
- Compute matched kinds from `parseMentions(rawContent, slugMap)` once, after building the combined slug map:
  - `matchedConnections`: matches whose `target?.kind === 'connection'`.
  - `matchedProjects`: matches whose `target?.kind === 'project'`.
  - `hadMatchedMentions = matchedConnections.length > 0 || matchedProjects.length > 0`.
  If the slug map is empty or no slug matched, return the raw content byte-for-byte.
- **Connections block:** unchanged content and gating (emitted only when ≥1 connection mention matched; still lists all connections).
- **Projects block (new):** emitted only when ≥1 project mention matched; lists **only the mentioned projects** (the agent has `list_projects` for the rest, and descriptions are long). Wording aligned with [pi-system-prompt.ts:43–46](../workers/main/src/pi-system-prompt.ts#L43-L46):

```text
<camelai system message>
## Referenced projects

The user @-mentioned these projects. The project name is the handle to use in
tools: file tools take `location: "vm"` with `project: "<name>"`, and shell /
runtime operations run inside that project's VM checkout at /workspace. Use
`list_projects` for full details or other projects.

- @camel_site — project "camel-site": Marketing site rebuild with pricing pages
- @camel_site_v2 — clone of "camel-site": Experiment branch for the new hero
</camelai system message>
```

  One bullet per mentioned project: `- @<slug> — project "<name>": <description truncated to ~200 chars>`; clones read `clone of "<cloned_from_name>"`. Dedupe repeated mentions of the same project.
- Block order when both kinds matched: connections block, then projects block, then the expanded body (two separate `<camelai system message>` blocks — keeps the connections block byte-identical for existing tests/transcripts).
- Escape/truncate project descriptions as plain text only: replace newlines with spaces, collapse whitespace, and cap at ~200 chars so a stored multi-paragraph description cannot bloat the injected system context. Do not include project ids in the prompt block unless needed for debugging; project tools use the name handle.

### 5b. Call sites

1. **`ChatThreadDO.applyConnectionMentionsForTurn`** ([chat-thread-do.ts:7145](../workers/main/src/chat-thread-do.ts#L7145), invoked per user turn at :7475) — rename `applyMentionsForTurn`. Keep the `content.includes('@')` early-out, then fetch both sources concurrently with per-source catches; neither source should prevent the other from working:

```ts
const [integrations, projects] = await Promise.all([
  workspaceStub.getIntegrations().catch((err) => {
    console.error('[ChatThreadDO] getIntegrations for mentions failed', err);
    return [];
  }),
  this.workspaceFs.listProjects().catch((err) => {
    console.error('[ChatThreadDO] listProjects for mentions failed', err);
    return [];
  }),
]);
const result = applyMentionContext(content, { integrations, projects });
```

   (`this.workspaceFs` already exists — getter at [chat-thread-do.ts:1840](../workers/main/src/chat-thread-do.ts#L1840); the whole helper keeps its existing outer try/catch that falls back to the raw content for unexpected bugs in parsing/formatting.)

2. **`buildRunnerUserMessageContent`** ([workers/main/src/routes/websocket.ts:96](../workers/main/src/routes/websocket.ts#L96)) — same treatment: import `WorkspaceFilesystemClient` from `../workspace-filesystem-do.js`, build `new WorkspaceFilesystemClient(env, workspaceId)` next to the existing `WORKSPACE` stub, and `Promise.all` the two independently caught fetches inside the existing `safeContent.includes('@')` branch. (This function's only current caller is its test, but it must keep compiling and stay semantically aligned.)

These are the only two `applyConnectionMentionContext` call sites in the repo — Slack/email/cron ingress all funnel into the ChatThreadDO turn path, so they inherit project mentions automatically.

### 5c. Worker tests — `workers/main/tests/chat-websocket-mentions.test.ts`

Update for the new signature and add:
- Project mention → body contains `⟦ref: project "camel-site" id=…⟧` + a `## Referenced projects` block naming `camel-site` with its description; no connections block.
- Project-only workspace (`getIntegrations()` returns `[]`, `listProjects()` returns one project) still expands and injects project context. This specifically guards removal of the old `integrations.length === 0` early return.
- Mixed mention (`@stripe and @camel_site`) → both annotations, both blocks, connections block first and byte-identical to the connections-only fixture.
- Clone mention → bullet reads `clone of "<parent>"`.
- No project match → output identical to today's connections-only behavior (regression).
- Cross-kind collision: connection "camel" + project "camel" → `@camel` resolves to the older one, `@camel-2` to the newer.
- Source failure isolation:
  - `listProjects()` rejects but integrations load → connection annotations/block still appear.
  - `getIntegrations()` rejects but projects load → project annotations/block still appear.
  These can be covered through `buildRunnerUserMessageContent` by adding a minimal `WORKSPACE_FS` mock to the existing env fixture.

### 5d. App route tests — `tests/workspace-projects-api.test.ts` (or nearest existing route-test file)

Add focused coverage for the new `GET /api/workspaces/:id/projects` loader:
- 401/404/403 behavior is inherited from `requireWorkspaceAccess`; test at least unauthenticated and no-access if an existing route-test helper makes that cheap.
- Success returns `{ projects: MentionableProject[] }`, includes flattened clones, omits full registry/runtime-only fields (`defaultVmId`, artifact remotes, artifact status), and sets `Cache-Control: private, no-store`.
- `WorkspaceFilesystemClient.listProjects()` failure logs and returns a 500 JSON error; do not silently return an empty project list from this route. Loader-time empty fallback belongs in chat loaders, not in the API that is supposed to tell the client refresh failed.

---

## 6. Rename map (mechanical)

| From | To |
|---|---|
| `src/components/connection-mention-menu/` | `src/components/at-mention-menu/` (same file names inside) |
| `ConnectionMentionMenu` / `ConnectionMentionMenuProps` | `AtMentionMenu` / `AtMentionMenuProps` |
| `src/lib/connection-mentions.ts` | `src/lib/mentions.ts` |
| `MentionableIntegration` | `MentionableConnection` (+ new `MentionableProject`, `Mentionable`) |
| `filterMentionableConnections` / `rankMentionableConnections` / `slugForIntegration` | `filterMentionables` / `rankMentionables` / `slugForMentionable` |
| `MentionMatch.integration` | `MentionMatch.target` |
| `workers/main/src/connection-mention-context.ts` / `applyConnectionMentionContext` | `workers/main/src/mention-context.ts` / `applyMentionContext` |
| `ChatThreadDO.applyConnectionMentionsForTurn` | `applyMentionsForTurn` |
| `PromptInput.mentionableConnections` prop | `mentionables` |
| `tests/connection-mentions.test.ts` | `tests/mentions.test.ts` |

Import sites to sweep (grep `connection-mentions` and `connection-mention-menu`): `prompt-input.tsx`, `Chat.tsx`, `welcome-screen/index.tsx`, `message-bubble.tsx`, `markdown-renderer.tsx`, `connections-client.tsx`, `turn-utils.ts`, `teammate-message.ts`, `task-notification.ts`, `thread-preview.ts`, `workers/main/src/mention-context.ts`, `workers/main/src/chat-thread-do.ts`, `workers/main/src/routes/websocket.ts`, plus the test files `tests/mentions.test.ts`, `tests/prompt-input-mentions.test.tsx`, `tests/use-mention-trigger.test.ts`, `tests/markdown-renderer.test.ts`. Leave `docs/` history untouched.

**⚠ CI path filter:** [.github/workflows/deploy-go-services.yml:10,14](../.github/workflows/deploy-go-services.yml) watches `src/components/connection-mention-menu/mention-chip.tsx` and `src/lib/connection-mentions.ts` by exact path. These are transitive deps of the sandbox preview-renderer bundle (`sandbox/create-worker/renderer/main.tsx` → `chat-file-preview` → `markdown-renderer.tsx` → mention chip + lib). Update both paths to the renamed locations in the same change, or the sandbox renderer image silently stops rebuilding on future edits to these files. Related constraint: `src/lib/mentions.ts` must not import `workers/main/src/*` as a value or type; keep project mapping structural and dependency-free from worker modules so the renderer bundle stays browser-safe.

---

## 7. Implementation order

1. **Lib**: rename to `src/lib/mentions.ts`; add `Mentionable` union, structural `MentionProjectSource`/`projectsToMentionables`, kind-aware `expandMentions`, kind-aware interleaved `rankMentionables`; update + extend `tests/mentions.test.ts`. Run `bun run test:run tests/mentions.test.ts`.
2. **Server**: rename to `mention-context.ts`, implement `applyMentionContext` with the projects block and project-only behavior; update both call sites (`chat-thread-do.ts`, `routes/websocket.ts`) with independent source catches; update + extend `workers/main/tests/chat-websocket-mentions.test.ts`. Run `bun run test:workers -- chat-websocket-mentions`.
3. **Types + loaders**: `AtMentionEntity` in `src/types.ts`; `projectsPromise` in both chat loaders; `projects` through welcome data and `<Chat>` props.
4. **UI**: rename component dir (+ update the two `deploy-go-services.yml` path filters — see §6); single-list `AtMentionMenu` with `FolderGit2` project rows and `Project`/`Clone` kind labels + generalized zero-state; `prompt-input.tsx` prop/state generalization; overlay hover-card project branch; widen `mentionSlugMap` types through `Chat.tsx` → `chat-messages-view.tsx` → `message-bubble.tsx` → `markdown-renderer.tsx`; welcome-screen combine. Update `tests/prompt-input-mentions.test.tsx` (project rows interleaved with connection rows in rank order, kind labels, keyboard order = visual order, zero-state), `tests/use-mention-trigger.test.ts` (import path only), and `tests/markdown-renderer.test.ts` (project chip + annotated-id resolution).
5. **Freshness**: `src/routes/api/workspaces.$id.projects.ts` + `routes.ts` registration + route tests; `onMentionMenuOpenChange` on `PromptInput`; throttled `useFetcher` refresh in `Chat.tsx`.
6. **Full pass**: `bun run typecheck`, `bun run lint`, `bun run test:run`, `bun run test:workers`.

Steps 1–2 are independently shippable (server understands project mentions even before the menu offers them); steps 3–5 light the UI up.

---

## 8. Edge cases

| Case | Expected behavior |
|---|---|
| Project and connection share a name | One slug map across kinds → older item keeps the base slug, newer gets `-2`. Client and server derive identical maps from the same source data, so the inserted slug resolves to the same entity server-side. |
| Project name with dashes/caps (`Camel-Site`) | Slug is `camel_site` in the composer; the `⟦ref: project "Camel-Site" …⟧` annotation and the system block carry the exact name, which is the agent's tool handle. |
| Project deleted after being mentioned | Old transcripts keep the annotation; renderer shows the muted "deleted" chip (slug no longer in map, annotated id unresolvable). New sends of the stale slug simply don't match — body passes through unannotated, like unknown `@words` today. |
| Clone whose `artifactStatus` ≠ `ready` | Still listed and mentionable; the agent resolves actual status via `list_projects`. No status surfaced in the menu (keep rows clean). |
| Workspace has projects but zero connections | Menu lists just the projects; no "Add a connection" row. `mentionsEnabled` stays true via `hasAnyItems`. |
| No projects and no connections | Zero-state "Add a connection" row, exactly today's behavior. |
| Agent creates a project mid-conversation | Next time the user opens the @ menu (>15s throttle), the fetcher refreshes and the new project appears without a reload. |
| Query matches nothing in either kind | Menu auto-hides (existing `matchesAvailable` behavior, generalized). |
| `user@host.com` mid-word `@` | Still ignored — trigger and parse word-boundary rules untouched. |
| Projects fetch fails (loader or per-turn) | Logged; menu/expansion degrade to connections-only; message send is never blocked. |

---

## Out of scope

- @-mentioning files, apps, threads, or teammates (the `Mentionable` union and composite `kind:id` menu values are the extension points when that lands).
- An "Add a project" row or any project-creation UI.
- Project metadata stats in the hover card (deployed-app / file / notebook counts). Considered and deferred: deployed-app count would be cheap later because worker scripts already carry `project_id` ([_app.chat._index.tsx:272](../src/routes/_app.chat._index.tsx#L272)); file/notebook counts would require per-project runtime-service listing calls on hover, which is not worth it. The hover card ships with the agent-authored description (§4b).
- Matching the search query against project descriptions.
- Live push of project-list changes over the chat WebSocket (the open-edge refetch covers the practical case).
- Any change to chip visuals, trigger conditions, popover sizing, or the connections block format the agent already receives.
