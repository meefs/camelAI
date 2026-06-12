# App Card → New Chat: Prefill `@project` Instead of Seeding a Message — Plan

**Date:** 2026-06-12
**Branch:** `illianaa/davis`
**Depends on:** the shipped at-menu projects work ([at-menu-projects-plan.md](at-menu-projects-plan.md), [at-menu-exclude-clones-plan.md](at-menu-exclude-clones-plan.md)).

---

## Objective

Today, clicking **New chat** on an app card immediately creates a thread and auto-sends a seeded system message (`<camelai system message>I'd like to work on the app "<name>" at <url>…</camelai system message>`). Change the happy path to match the connections flow on the welcome screen (`handleConnectionSelect`, [welcome-screen/index.tsx:462](../src/components/welcome-screen/index.tsx#L462)): **no thread is created on click** — the composer is prefilled with the app's project mention tag (`@<project_slug> `, trailing space, caret at end) and the user types whatever they want before sending.

Two entry surfaces, one outcome:

```text
  /apps page (AppCard "New chat")                /chat welcome (SlimAppCard click)
        │                                                  │
        │ app.project_id resolves to a                     │ app.project_id resolves in
        │ mentionable project?                             │ WelcomeScreen's resolvedProjects?
        │                                                  │
   yes ─┤ navigate('/chat', { state:                  yes ─┤ onPromptChange('@camel_site ')
        │   { atMentionApp: {projectId,                    │ + focusInput()
        │     scriptName} } })                             │ + report pending app to Chat
        │   → welcome applies prefill                      │
        │                                                  │
    no ─┴─► EXISTING seeded                            no ─┴─► EXISTING seeded
            createThreadAndStart POST                        createThreadAndStart submit
            (unchanged, kept as fallback)                    (unchanged, kept as fallback)

  Composer after the happy path (either surface):
  ┌──────────────────────────────────────────────────────────┐
  │ @camel_site ▌                                            │  ← chip renders via the existing
  └──────────────────────────────────────────────────────────┘    composer overlay automatically
```

The seeded-message code paths are **not deleted** — they become the explicit fallback for apps that cannot be mentioned (see "Resolvability" below).

---

## Resolvability rule

An app is *prefillable* iff `app.project_id` is non-null **and** matches the `id` of an item in the current mentionable-projects list (`projectsToMentionables` output). Everything else falls back to today's seeded flow:

| App state | Behavior |
|---|---|
| `project_id` matches a mentionable project | Prefill `@<slug> ` (slug from the **combined** connection+project slug map, so collision suffixes like `@stripe-2` come out right). |
| `project_id === null` (legacy app, direct API deploy) | Fallback: seeded flow, unchanged. |
| `project_id` points to a **clone** (staging deploys) | Clones are excluded from mentionables (CTO decision, [at-menu-exclude-clones-plan.md](at-menu-exclude-clones-plan.md)) → not found in the list → fallback seeded flow. Do not special-case. |
| `project_id` points to a deleted project | Not found → fallback seeded flow. |
| Projects list not yet resolved at click time (deferred promise still in flight) | Treat as unresolvable → fallback seeded flow. No spinners, no waiting. |
| App in a different workspace (`/apps` switch-dialog path, [apps-client.tsx:104-112](../src/components/pages/apps/apps-client.tsx#L104-L112)) | Untouched — the switch dialog and its post-switch behavior stay exactly as they are. |

---

## File-by-file changes

### 1. `src/lib/mentions.ts` — one new pure helper

```ts
/** Map key (slug) of the mentionable project with this id, or null. */
export function slugForProjectId(
  projectId: string,
  slugMap: ReadonlyMap<string, Mentionable>,
): string | null {
  for (const [slug, item] of slugMap) {
    if (item.kind === 'project' && item.id === projectId) return slug;
  }
  return null;
}
```

Both surfaces use it so the inserted slug always comes from the same combined map the menu/overlay/server use. The prefill string is always `` `@${slug} ` `` (trailing space) — identical to `handleConnectionSelect`.

### 2. Extract `loadWorkspaceMentionProjects` → `src/lib/mention-projects.server.ts`

The function is currently **duplicated** in [_app.chat._index.tsx:135-147](../src/routes/_app.chat._index.tsx#L135-L147) and [_app.chat.$id.tsx:122](../src/routes/_app.chat.%24id.tsx#L122). The `/apps` loader would be the third copy — extract instead:

- New `src/lib/mention-projects.server.ts` exporting the function verbatim (keep the `await import("../../workers/main/src/workspace-filesystem-do")` dynamic import inside it; `.server.ts` plus the dynamic import double-guarantees no worker code reaches a client bundle — same convention as `src/lib/sales-prompt.server.ts`).
- Replace both route-local copies with imports. No behavior change.

### 3. `src/routes/_app.apps.tsx` — loader provides projects

Add to the loader return, alongside the existing deferred `apps` promise:

```ts
projects: hasWorkspace && workspaceId
  ? loadWorkspaceMentionProjects(env, workspaceId).catch((error) => {
      console.error('Failed to load workspace projects for app cards:', error);
      return [] as MentionableProject[];
    })
  : Promise.resolve([] as MentionableProject[]),
```

Pass it through to `AppsClient`. (`[]`-on-error matches the chat loaders: the prefill is an enhancement; on failure every card just uses the seeded fallback.)

### 4. `src/components/pages/apps/apps-client.tsx` — branch in `handleStartChat`

- Resolve the `projects` promise into local state the same way the component resolves its other deferred props (`resolvedProjects: MentionableProject[] | null`, `null` until resolved).
- At the top of the same-workspace happy path in `handleStartChat` ([:97-131](../src/components/pages/apps/apps-client.tsx#L97-L131)), before building the seeded message:

```ts
const mentionProject = app.project_id && resolvedProjects
  ? resolvedProjects.find((p) => p.id === app.project_id) ?? null
  : null;
if (mentionProject) {
  navigate('/chat', {
    state: { atMentionApp: { projectId: mentionProject.id, scriptName: app.script_name } },
  });
  return;
}
// …existing seeded submit stays below, untouched.
```

Note the `/apps` side only checks **resolvability** (id membership). It does not compute the slug — the welcome screen owns the combined slug map (connections + projects) and computes the suffix-correct slug there.

### 5. `src/components/Chat.tsx` — apply navigation-state prefill + carry app context

**5a. Apply the prefill from `location.state.atMentionApp`.** In the welcome-screen branch (no active thread), add one effect:

- Guard with a `useRef` so it applies at most once per mount (React strict-mode double-effect safe).
- Wait until Chat's own `mentionSlugMap` includes projects (i.e. `resolvedMentionProjects` has loaded — reuse whatever readiness signal the projects resolution effect already exposes).
- `const slug = slugForProjectId(state.atMentionApp.projectId, mentionSlugMap)`:
  - found → `setWelcomeInput(`@${slug} `)`, set `pendingAppRef.current = { projectId, scriptName }` (5c), then strip the state so back/refresh can't re-apply: `navigate(location.pathname + location.search, { replace: true })`.
  - not found after projects resolved (rare divergence — project deleted between pages) → strip the state and leave the composer empty and focused. **Do not** auto-submit a seeded thread from a navigation effect; thread creation must always be a direct user action.
- This intentionally overwrites any persisted welcome draft — same replace semantics as clicking a connection in ConnectedTools.

**5b. Welcome-screen card clicks.** Keep `onStartChatForApp` (the seeded submit, [Chat.tsx:4376-4427](../src/components/Chat.tsx#L4376-L4427)) exactly as is — it becomes the fallback. Pass one new prop to `<WelcomeScreen>`: `onAppMentionPrefill={(app) => { pendingAppRef.current = app; }}` (see §6 for who decides prefill vs fallback).

**5c. Carry `previewApps` + `initialTitle` through the eventual submit.** Today's seeded flow passes `previewApps: app.script_name` and `initialTitle` so the new thread opens with the app preview. Preserve that when the user sends a prefilled mention:

- `pendingAppRef: { projectId: string; scriptName: string } | null` — set by 5a/5b, cleared when `welcomeInput` becomes empty (user wiped the composer) and on workspace change.
- In `startNewChat` ([Chat.tsx:4429-4491](../src/components/Chat.tsx#L4429-L4491)): if `pendingAppRef.current` is set **and** the submitted text still mentions that project — check with the existing parser, `parseMentions(userMessage, mentionSlugMap).some((m) => m.target?.kind === 'project' && m.target.id === pendingAppRef.current.projectId)` — add to `createThreadPayload`:
  - `previewApps: pendingAppRef.current.scriptName`
  - `initialTitle: buildAppThreadFallbackTitle(pendingAppRef.current.scriptName)` (already imported in Chat.tsx)
- Clear `pendingAppRef` after the submit either way. If the user deleted the mention before sending, submit without the app fields — they opted out of the app context.

### 6. `src/components/welcome-screen/index.tsx` — mirror `handleConnectionSelect`

Add next to `handleConnectionSelect` ([:462](../src/components/welcome-screen/index.tsx#L462)):

```ts
const handleAppSelect = useCallback((app: WorkerScriptWithCreator) => {
  const slug = app.project_id
    ? slugForProjectId(app.project_id, mentionSlugMap)
    : null;
  if (slug) {
    onPromptChange(`@${slug} `);
    focusInput();
    onAppMentionPrefill?.({ projectId: app.project_id!, scriptName: app.script_name });
    return;
  }
  onStartChatForApp(app);   // existing seeded fallback, unchanged
}, [mentionSlugMap, onPromptChange, focusInput, onAppMentionPrefill, onStartChatForApp]);
```

- New optional prop: `onAppMentionPrefill?: (app: { projectId: string; scriptName: string }) => void`.
- Wire `handleAppSelect` (instead of the raw `onStartChatForApp`) into both `AppCardsRow` usages in `AppsSection` ([:297](../src/components/welcome-screen/index.tsx#L297), [:310](../src/components/welcome-screen/index.tsx#L310)). `AppCardsRow` / `SlimAppCard` prop signatures are unchanged — only the handler passed in changes.
- `slugForProjectId` against the **combined** `mentionSlugMap` (already built at [:415](../src/components/welcome-screen/index.tsx#L415)) is what makes collision suffixes correct. If projects haven't resolved yet at click time, the map has no project entries → `null` → seeded fallback. Deterministic, no waiting state.

### No card UI changes

`AppCard` ([src/components/pages/apps/AppCard.tsx:225-233](../src/components/pages/apps/AppCard.tsx#L225-L233)) and `SlimAppCard` keep their exact markup, hover overlay, and "New chat" label. This plan changes only what the click does.

---

## Behavior notes

| Case | Expected behavior |
|---|---|
| Click app card on welcome, project mentionable | Composer becomes `@camel_site ` with the chip rendered by the existing overlay; caret after the space; no thread exists yet. Sending creates the thread with `previewApps`/`initialTitle` carried (5c). |
| Click app card on `/apps`, project mentionable | Client navigation to `/chat`; composer prefilled the same way once projects resolve (typically before paint, since the loader defers them with the page). No thread created by navigation. |
| User had a draft in the composer | Replaced — identical to clicking a connection in ConnectedTools. |
| User clears the prefilled mention and types something else | Send proceeds as a normal new chat; `previewApps`/`initialTitle` are **not** attached (mention-presence check in 5c). |
| User clicks two different app cards in a row | Second click replaces the input and `pendingAppRef` — last click wins. |
| Clone-backed app (staging deploy) / legacy `project_id: null` app | Seeded flow, byte-identical to today, from both surfaces. |
| Refresh or back-button after a `/apps`-originated prefill | State was stripped via `replace` navigation after applying — no re-prefill, no double anything. |
| Server-side expansion of the sent message | Nothing new — the sent text contains `@camel_site`, and the shipped `applyMentionContext` produces the annotation + "Referenced projects" block. The old seeded `<camelai system message>` app blurb is intentionally absent from this path; project description + `previewApps` cover the agent's context. |

---

## Tests

- **`tests/mentions.test.ts`** — `slugForProjectId`: found; not found; returns the *suffixed* key when the project lost the base slug to an older same-name connection (e.g. map has `stripe` → connection, `stripe-2` → project; lookup by the project's id returns `stripe-2`).
- **New `tests/app-card-mention-prefill.test.ts(x)`** — extract-and-test the two small pure decision points rather than mounting Chat:
  - the `/apps` resolvability branch (given `app.project_id` + `resolvedProjects`, prefill-navigate vs seeded-fallback), if extracted as a helper; otherwise cover via an `apps-client` render test following the existing component-test patterns in `tests/`.
  - the 5c carry predicate: text still mentioning the pending project ⇒ payload includes `previewApps`/`initialTitle`; mention removed ⇒ it doesn't.
- **Existing tests** — `tests/app-loader-sales-prompt.test.ts` and prompt-input/mention suites should pass unmodified; update the `_app.apps.tsx` loader test only if one exists for its return shape.

Run: `bun run test:run tests/mentions.test.ts tests/app-card-mention-prefill.test.ts`, then `bun run typecheck` and `bun run lint`.

---

## Out of scope

- Changing the seeded-message **content** for fallback apps (it stays byte-identical, including the `list_projects` hint variant in [Chat.tsx:4400](../src/components/Chat.tsx#L4400)).
- Cross-workspace app cards (`/apps` "all workspaces" filter) — the switch dialog flow is untouched; prefill applies only to same-workspace clicks.
- Prefilling from other app entry points (preview panel, deploy toasts, thread history) — this plan covers exactly the two card surfaces named.
- Removing `previewApps`/`initialTitle` from the thread-create action, or any action/server changes — the action already accepts everything we send.
- A visual "app context attached" indicator on the composer. The `@project` chip is the indicator; if discoverability suffers we can revisit.
