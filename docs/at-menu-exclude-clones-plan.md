# At-Menu: Exclude Clones From @-Mentions — Plan

**Date:** 2026-06-12
**Branch:** `illianaa/davis`
**Decision:** Product/CTO call (2026-06-12): cloned projects are **excluded from the @ menu entirely** for now. This supersedes the clone handling in [at-menu-projects-plan.md](at-menu-projects-plan.md) (which included clones as mentionable items) and resolves the Codex P2 on `workers/main/src/mention-context.ts:81-83` **by deletion** — the flagged clone-label branch becomes unreachable and is removed, not improved.

Net effect: only source projects (`kind: "project"`) are mentionable. Clones never appear in the menu, never chip, never annotate, and never produce a "Referenced projects" bullet. A user who types `@some_clone_slug` manually gets plain text, exactly like any unknown `@word`.

---

## The one structural rule

Filter clones at the **shared mapper** — `projectsToMentionables` in [src/lib/mentions.ts:247](../src/lib/mentions.ts#L247) — and nowhere else. Every consumer (both chat loaders, `GET /api/workspaces/:id/projects`, the menu, the composer overlay, and the worker's `applyMentionContext`) feeds from this one function, so filtering here keeps the client-side and server-side slug maps byte-identical. Filtering in the UI instead would desync slug collision suffixes between client insert and server resolve (e.g. client sees `stripe`, server resolves `stripe-2`).

Two-part filter inside the mapper:

1. **Stop flattening `clones[]`** — delete the inner loop ([src/lib/mentions.ts:267-278](../src/lib/mentions.ts#L267-L278)).
2. **Skip top-level entries with `kind === 'clone'`** — `if ((project.kind ?? 'project') === 'clone') continue;` with a comment that this is deliberate. Today `nestProjectClones` ([workspace-filesystem-do.ts:1139](../workers/main/src/workspace-filesystem-do.ts#L1139)) never returns top-level clones, so this branch is currently unreachable — it exists so that a future backend change that hoists orphaned clones to the top level (a known follow-up for when single-project delete ships) cannot silently resurrect clones in the @ menu.

---

## File-by-file changes

### 1. `src/lib/mentions.ts`

- `projectsToMentionables` ([:247-282](../src/lib/mentions.ts#L247-L282)): apply the two-part filter above. Resulting items always have today's `project_kind: 'project'` semantics, so:
- `MentionableProject` ([:22-31](../src/lib/mentions.ts#L22-L31)): **delete** `project_kind` and `cloned_from_name`. Do not leave them as dead optional fields — nothing populates them anymore, and a stale field is a trap for the next feature.
- `MentionProjectCloneSource` ([:35-41](../src/lib/mentions.ts#L35-L41)), `cloneSource?`, and the `clones?` field on `MentionProjectSource` ([:50-51](../src/lib/mentions.ts#L50-L51)): **delete all three**. `WorkspaceProject[]` still satisfies `MentionProjectSource[]` structurally (extra fields are fine); keep `kind?: 'project' | 'clone'` on the source type — the skip needs it.
- `rankMentionables` type tier ([:123](../src/lib/mentions.ts#L123) and [:126](../src/lib/mentions.ts#L126)): replace `item.project_kind` with the literal `'project'`. The `clone` keyword no longer matches anything (there are no clones to find).

### 2. `src/components/at-mention-menu/index.tsx`

- Row meta label ([:144](../src/components/at-mention-menu/index.tsx#L144)): `item.project_kind === 'clone' ? 'Clone' : 'Project'` → just `'Project'`.

### 3. `src/components/at-mention-menu/composer-mention-overlay.tsx`

- Hover card kind line ([:164-165](../src/components/at-mention-menu/composer-mention-overlay.tsx#L164-L165)): delete the `Clone of …` branch; the line is always `Project`.

### 4. `workers/main/src/mention-context.ts`

- `buildProjectsSection` ([:81-83](../workers/main/src/mention-context.ts#L81-L83)): delete the `kindLabel` ternary (the Codex-flagged lines). Every bullet is uniform:

```text
- @<slug> — project "<name>": <normalized description>
- @<slug> — project "<name>"            (when description is empty)
```

  No other change to the block: header text, `normalizeProjectDescription`, and the `seenProjectIds` dedupe stay as they are.

### 5. `src/routes/api/workspaces.$id.projects.ts`

- No code change — it returns `projectsToMentionables(...)`, so clones drop out automatically. Only its test changes (below).

### Do NOT touch (grep-collision fence)

A sweep for `Clone` also hits unrelated code. Leave all of these alone:

- `src/components/pages/connections/*` — the **connection** "Clone to workspace" feature (`onClone`, clone dialog).
- `src/lib/tool-activity-summary.ts:138` — the `CloneProject` agent-tool label.
- `src/components/chat-file-preview/notebook-preview/chart-runtime.ts` — `structuredClone`.
- `workers/main/src/workspace-filesystem-do.ts` — `clone_project`, `nestProjectClones`, `cloneSource`, etc. The platform's clone capability is unchanged; only the @ menu ignores clones.
- `workers/main/src/chat-thread-do.ts` `projectForAgent`/`projectCloneForAgent` — the agent's `list_projects` tool still reports clones; this plan only changes mention preprocessing.

---

## Behavior notes

| Case | Expected behavior |
|---|---|
| Workspace has a project with 3 clones | Menu shows 1 row (the source project). |
| User types `@my_clone_slug` manually | No menu match, no chip, no annotation, no context block — passes through as plain text, like any unknown `@word`. The agent can still resolve it conversationally via `list_projects`. |
| Old transcript contains a clone mention from the brief period clones were mentionable (`@my_fork ⟦ref: project "my-fork" id=…⟧`) | Slug is no longer in the map and the annotated id is unresolvable → renders as the existing muted "deleted" chip. Same path as a deleted project; no action needed. |
| Slug collision suffixes shift (a clone previously held `stripe`, so a connection was `stripe-2`) | Client and server shift together because both feed from the same mapper — new messages are consistent. Old transcripts keep their annotations (id-based resolution), so no rendering breakage. |
| Future backend hoists orphaned clones to top level of `listProjects()` | The defensive `kind === 'clone'` skip keeps them out of the menu with no further change. |

---

## Tests

- **`tests/mentions.test.ts`** — invert the clone-flattening coverage: `projectsToMentionables` ignores `clones[]` entries; skips a top-level `kind: 'clone'` item; output items have no `project_kind`/`cloned_from_name` (type-level). Drop/replace any cross-kind collision fixtures that relied on clone items. Ranking: `clone` query no longer type-tier-matches projects.
- **`workers/main/tests/chat-websocket-mentions.test.ts`** — replace the clone-bullet case with: a mention of a nested clone's slug does **not** annotate and does **not** produce a Referenced-projects bullet; a source-project mention still produces the uniform `project "<name>"` bullet. Keep the project-only, mixed-mention, and source-failure cases as-is.
- **`tests/prompt-input-mentions.test.tsx`** — remove/replace clone-row cases: a workspace fixture whose project has clones renders only the source-project row; meta label is always `Project`.
- **`tests/workspace-projects-api.test.ts`** — flip "includes flattened clones" to "excludes clones"; response items carry no clone fields.
- **`tests/markdown-renderer.test.ts`** — only if it has clone-specific fixtures; the muted-chip fallback for unknown slugs is already covered by the deleted-project case.

Run: `bun run test:run tests/mentions.test.ts tests/prompt-input-mentions.test.tsx tests/workspace-projects-api.test.ts`, `bun run test:workers -- chat-websocket-mentions`, then `bun run typecheck` and `bun run lint`.

---

## Out of scope

- Re-introducing clones to the @ menu later. If/when that happens, restore via this change's git history: the mapper flatten, `project_kind`/`cloned_from_name`, the `Clone` row label, the hover `Clone of …` line, and a context bullet that leads with the clone's **own** name as the tool handle — `project "<clone-name>" (clone of "<parent>")` — per the Codex P2 finding.
- The `nestProjectClones` orphan-drop (clones vanish from `listProjects()` if their parent is ever deleted). Separate backend follow-up, relevant once single-project delete exists; the defensive skip here already insulates the @ menu from whichever way that lands.
- Any change to `clone_project` / agent-facing project tools.
