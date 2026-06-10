# Kill the Computer Tab — Removal Plan

## Context

The project-VM migration (PR #718) broke the computer tab, we hid the nav item behind `SHOW_COMPUTER_NAV_ITEM = false`, and nobody noticed. We are removing the feature entirely. Git history is the recovery path if we ever want it back — do not leave commented-out code, feature flags, or "temporarily disabled" scaffolding behind.

Scope: delete the `/computer` routes and page, every link/button that navigates to them, the workspace-fs API routes that only the computer tab called, and all code that becomes dead as a result (types, utils, deps, tests).

## What must NOT be removed (verified shared)

These look computer-tab-adjacent but have other consumers. Leave them working:

| Surface | Why it stays |
|---|---|
| `src/routes/api/workspaces.$id.fs.content.$.ts` (`GET /api/workspaces/:id/fs/content/*`) | Chat preview panel renders workspace files through it (`use-chat-preview-render-state.ts:29`) and the MCP handler builds these URLs (`workers/main/src/mcp-handler.ts:467-469`). Also becomes the new FileLink fallback (see §3.3). |
| `src/routes/api/workspaces.$id.projects.$project.fs.content.$.ts` | Chat preview for project-VM files. |
| `src/routes/api/workspaces.$id.upload.ts`, `workspaces.$id.uploads.$.ts`, `workspaces.$id.outputs.$.ts` | Chat attachment upload (R2 multipart) and temp-file preview/download. Distinct from the dead `fs/upload`. |
| `workers/main/src/workspace-filesystem-do.ts` (`WorkspaceFilesystemDO` / `WorkspaceFilesystemClient`) | Backs agent file tools, legacy migration workflows, admin MCP. Entirely untouched by this change. |
| `src/components/no-workspaces-error.tsx` | Imported by chat, apps, connections, history, automations, settings routes — only the computer-route *import* goes away. |
| Marketing copy using the word "computer" | `src/components/legacy-user-banner.tsx:169` and `src/routes/_onboarding.welcome.tsx:470` describe the persistent computer concept, not the tab. Leave them. |
| `e2e/chat.spec.ts` "describe the computer" test | Tests the agent describing its runtime, not the tab. |
| `requireWorkspaceAccess` / `requireWorkspaceAuth` in `workspaces.utils.ts` | Used by the surviving fs/content, uploads, outputs, upload, and app-visibility routes, plus `tests/workspaces-access-superuser.test.ts`. |

## 1. Delete files

- `src/routes/_app.computer.tsx`
- `src/routes/_app.computer.$workspaceId.tsx`
- `src/components/pages/computer/` (entire directory; `computer-page-content.tsx` is ~2,500 lines and the only Monaco consumer)
- `src/routes/api/workspaces.$id.fs.list.ts`
- `src/routes/api/workspaces.$id.fs.read.ts`
- `src/routes/api/workspaces.$id.fs.write.ts`
- `src/routes/api/workspaces.$id.fs.create.ts`
- `src/routes/api/workspaces.$id.fs.mkdir.ts`
- `src/routes/api/workspaces.$id.fs.delete.ts`
- `src/routes/api/workspaces.$id.fs.move.ts`
- `src/routes/api/workspaces.$id.fs.upload.ts`
- `src/lib/workspace-file-access.server.ts` (zero importers — pre-existing dead code, confirmed by grep)
- `tests/workspace-file-access.server.test.ts`
- `tests/computer-admin-readonly-loader.test.ts`
- `tests/computer-file-editing-beta.test.tsx`
- `tests/workspace-file-mutation-beta-routes.test.ts` (imports the deleted blocked-mutation route actions)
- `tests/workspace-beta-file-edit-helper.test.ts` (tests `blockFileEdit()`, which §6 removes)

Rationale on the fs routes: `fs/write|create|mkdir|delete|move|upload` are already hard-403'd via `blockFileEdit()` and only the computer page ever called them. `fs/list` and `fs/read` have no callers outside `computer-page-content.tsx` (verified by repo-wide grep; chat preview uses `fs/content/*`, agents go through the DO directly).

## 2. Route registration — `src/routes.ts`

- Remove the two page routes: `route("computer", ...)` and `route("computer/:workspaceId", ...)` (~lines 40-41).
- Remove the API registrations for the eight deleted fs routes (~lines 197-221): `fs/list`, `fs/read`, `fs/write`, `fs/mkdir`, `fs/delete`, `fs/move`, `fs/create`, `fs/upload`.
- Keep `api/workspaces/:id/fs/content/*` and `api/workspaces/:id/projects/:project/fs/content/*`.
- Delete the commented-out `// route('api/workspaces/:id/fs/*', ...)` line (~282) while you're there.

## 3. UI changes

### 3.1 Sidebar — `src/components/sidebar/app-sidebar.tsx`

Delete the `SHOW_COMPUTER_NAV_ITEM` flag and its comment (lines 31-32), the `isComputer` / `computerHref` variables (lines 47-50), and the conditional Computer `SidebarMenuItem` block (lines 128-137). No visual change — the item is already hidden.

### 3.2 Workspace switcher — `src/components/sidebar/workspace-switcher.tsx`

In `handleSwitchWorkspace` (~lines 49-56), delete the `else if` branch that navigates to `/computer/${workspaceId}` when the current path is a computer route. Keep the `/chat/` branch as-is.

### 3.3 Chat file links — `src/components/tool-call/file-link.tsx`

This is the "open in new link" button the user mentioned. Today, workspace-file links fall back to `<a href="/computer/...">` when no preview context exists (lines 161, 198-221).

Change: make workspace files behave exactly like the existing temp-file branch (lines 87-158), which already has the right UX. Concretely:

- Delete the `href` construction at line 161 and the entire `<a>` fallback (lines 198-221).
- Keep the `previewContext` branch (lines 162-196) unchanged — clicking a file link in chat still opens the preview panel.
- For the no-`previewContext` fallback, mirror the temp-file pattern: a `<button>` (same classes as the temp-file button — `inline-flex min-w-0 max-w-full items-center gap-1 hover:underline text-foreground/80 hover:text-foreground`, `font-mono` when `mono`) that opens the existing `FilePreviewPopover` with:
  - `filename` = `getBasename(normalizedPath)`
  - `previewUrl` = `` `/api/workspaces/${currentWorkspace.id}/fs/content/${encodePathSegments(normalizedPath.replace(/^\/+/, ''))}` `` (same path shape `use-chat-preview-render-state.ts` builds — strip leading slashes, then encode per segment)

No new components, no new styling — both file flavors now share one interaction model. Keep the `ExternalLink` icon rendering driven by `showIcon` as today.

### 3.4 Preview panel "Open in Computer" — three files

`src/components/chat-preview/use-chat-preview-render-state.ts`:
- Delete the `fileExternalOpenUrl` memo (lines 166-175) and remove it from the return value.
- Simplify `openElsewhereKind` (lines 177-182) to: `previewTarget?.kind === "app" ? "app" : null`.
- The `readOnly` prop (line 66/77) was only consumed by `fileExternalOpenUrl`; remove the prop and update the call site in `Chat.tsx`.

`src/components/preview-panel/preview-toolbar.tsx`:
- Change `export type OpenElsewhereKind = 'app' | 'computer'` (line 34) to `'app'`.
- Simplify `OpenElsewhereButton` (lines 86-101): drop the ternary, always `{ icon: ExternalLink, tooltip: 'Open live app' }`.
- Remove the now-unused `AppWindowMac` import.
- Toolbar layout for file previews is otherwise unchanged: refresh, source toggle, copy-path chip, download button. Files simply no longer show an open-elsewhere icon — Download covers the "get it out of the app" need.

`src/components/Chat.tsx` (~lines 4755-4789):
- Remove `fileExternalOpenUrl` from the destructured hook result and from `handlePreviewOpenElsewhere` — the handler keeps only the app branch (`appPreviewVanityUrl` + `window.open`).
- `src/components/chat-preview/chat-preview-shell.tsx` only passes the props through; it compiles unchanged once the type narrows.

### 3.5 Apps page "View source" — `src/components/pages/apps/apps-client.tsx` + `AppCard.tsx`

Today the source-file chip on each app card navigates to the computer tab (and offers a workspace-switch dialog first when the app lives in another workspace).

Change — demote the chip to informational:

- `AppCard.tsx` (~lines 293-308): replace the `Button` with a static `<div>` chip, keeping the exact same visual treatment minus interactivity: `FileCode` icon (`size-3`) + truncated `sourceLabel` (`truncate max-w-[80px]`), classes `flex items-center gap-1.5 h-6 px-2 text-xs text-muted-foreground cursor-default`. Keep the `Tooltip`, but change its content from "View source file" to the full `app.config_path` so the path is still discoverable. Because the full path now lives only in the tooltip, the chip must stay keyboard-discoverable: give it `tabIndex={0}` and `` aria-label={`Source file: ${app.config_path}`} `` so focus triggers the tooltip and screen readers get the path. Remove the `onViewSource` prop from `AppCardProps`.
- `apps-client.tsx`: delete `handleViewSource` (lines 134-154), narrow the switch-dialog `action` type from `'chat' | 'viewSource' | null` to `'chat' | null` (line 65), delete the `viewSource` branch in `handleConfirmSwitch` (~lines 196-198), and drop the `onViewSource={handleViewSource}` prop (line 279).
- The "work on this app in chat" flow (which injects the config path into the first message) is untouched — that's now the canonical way to inspect an app's source.

## 4. App shell migration gate — `src/routes/_app.tsx`

`getMigrationGateWorkspace` (lines ~304-321) special-cases computer-route URLs to resolve the workspace from the path. With the routes gone, collapse it: the function body becomes `return authContext.currentWorkspace ?? null;` — or inline that at the call site and delete the function. Delete `getComputerRouteWorkspaceId` (lines 323-331).

## 5. Dead types — `src/types.ts`

Delete (verify zero remaining importers with grep after the file deletions — all current users are deleted files):

- `SandboxFileInfo` (line 213) and `SandboxFileListing` (line 222) — only referenced by `WorkspaceFileEntry`
- `WorkspaceFileEntry` (~line 228)
- `WorkspaceListResponse`, `WorkspaceFileRead`, `WorkspaceFileWrite`, `WorkspaceOperationResult` (lines 237-265)

Note: `workspaces.utils.ts` imports a *different* `WorkspaceListResponse` from the workers DO module — unrelated, leave it.

Also update the viewer-role TODO comment (~line 273): drop "access the computer tab" from the list of restricted capabilities.

## 6. Prune `src/routes/api/workspaces.utils.ts`

After the route deletions, prune exports with no remaining callers. Expected dead (grep-verify each — surviving routes are `fs.content.$`, `projects.$project.fs.content.$`, `upload`, `uploads.$`, `outputs.$`, `apps.$scriptName.visibility`, plus `tests/workspaces-access-superuser.test.ts`):

- `blockFileEdit()` — all six call sites are deleted routes. Its doc comment says to remove it when file editing is resolved; this is that moment.
- `resolveContainerPathForWrite()` and the private `splitWorkspacePath()` if it has no other user (`joinContainerPath` is still used by `resolveContainerPath` — keep).
- `getPathParam()` / `parseBooleanParam()` — only `fs.list` / `fs.read` used them, but grep the surviving routes before deleting.
- On `WorkspaceFileAdapter`: `writeFile`, `writeBinaryFile`, `mkdir`, `deleteFile`, `moveFile` lose all callers. Keep `readFile`, `readFileStream`, `listFiles` (used by `fs/content` and `resolveContainerPath`).

Do not touch `requireWorkspaceAccess` / `requireWorkspaceAuth` / `normalizeWorkspacePath` / `toContainerPath` / `resolveContainerPath` / whitespace helpers.

## 7. Monaco removal — deps, static assets, lint config

Sole consumer was `computer-page-content.tsx` (plus a mock in the deleted `computer-file-editing-beta.test.tsx`):

- `package.json`: remove `@monaco-editor/react` and `monaco-editor`; run `bun install` to update `bun.lock`.
- Delete `public/monaco/` (~15 MB of vendored editor assets served as static files).
- `eslint.config.mjs:28`: remove the `"public/monaco/**"` ignore entry.

## 8. Comment/copy stragglers

- `src/lib/auth.server.ts:663` — viewer-role comment: drop "computer" from "deny viewers access to chat, computer, connections...".
- `src/components/settings/invite-member-dialog.tsx:98` and `src/components/settings/team-table.tsx:278` — member-role description copy: change "chat, apps, computer, and connections" to "chat, apps, and connections" (both files share the string; keep them identical).
- `AGENTS.md`, "Uploads, Files, And Safety" section — delete the line "Computer tab file mutations may be intentionally blocked during beta; check `src/routes/api/workspaces.utils.ts` before changing write behavior." It is the only computer-tab reference in the guide. Per the maintenance rules, removing a subsystem updates this file in the same change.
- Historical docs in `docs/` that mention the computer tab are archives of past plans — leave them alone.

## 9. Test updates

- `tests/preview-toolbar-notebook-download.test.tsx`: references `openElsewhereKind="computer"` (line 21) and asserts on the "open in computer" button (lines 69-88). Rewrite those cases: the file-preview toolbar should render *no* open-elsewhere button; keep the download assertions. The fixture URLs pointing at `fs/content/...` are fine (route survives).
- `tests/workspaces-access-superuser.test.ts`: keep — it tests `requireWorkspaceAccess` directly. The `fs/list` / `fs/write` URLs in its `new Request(...)` fixtures are arbitrary strings; optionally update them to `fs/content/...` paths so they reference a real route, but it's cosmetic.
- `tests/chat-preview-shell.test.tsx`: unaffected (`fs/content` fixtures), but will catch regressions from the §3.4 type narrowing — run it.
- `tests/file-link.test.tsx`: rewrite to match §3.3. The "URL generation regression test" and "link behavior" describe blocks (lines 16-31, 74-98) assert on the `/computer` anchor — replace them with assertions that a workspace path with no preview context renders the popover-trigger `<button>` (not an anchor) and that the popover's `previewUrl` targets `/api/workspaces/ws-456/fs/content/...` with the workspaceId (not orgId) and per-segment encoding — those two regressions are still worth pinning, just against the new URL. Keep "falls back to plain text when no workspace is set" and the path-normalization cases (now asserted via the popover URL instead of `href`).
- `tests/app-loader-sales-prompt.test.ts`: delete the two computer-route migration-gate cases at lines 277 and 321 ("checks computer route workspace for project migration…" and "does not check inaccessible computer route workspaces…") — they exercise `getComputerRouteWorkspaceId`, which §4 deletes. The rest of the file stands.

## 10. Verification

```bash
bun run typecheck
bun run lint
bun run test:run
bun run test:workers
```

Then sweep for stragglers — each of these should come back empty (or only hit the allowed survivors listed in "What must NOT be removed"):

```bash
grep -rn '"/computer\|/computer/' src/ --include='*.ts' --include='*.tsx'
grep -rn 'fs/list\|fs/read\|fs/write\|fs/create\|fs/mkdir\|fs/delete\|fs/move\|fs/upload' src/ tests/
grep -rn 'monaco' src/ tests/ package.json eslint.config.mjs && ls public/monaco 2>/dev/null
grep -rn 'blockFileEdit\|SHOW_COMPUTER_NAV_ITEM\|getComputerRouteWorkspaceId\|fileExternalOpenUrl' src/ tests/
```

(`fs/read`, `fs/write`, etc. will still match `workers/main/src/project-runtime-service-vm.ts` and the legacy migration workflow — those are runtime-service paths, not the deleted API routes. Restrict the grep to `src/` and `tests/` as shown.)

Manual smoke (dev server): in a chat thread, click a workspace file link in a tool result → preview panel opens; file preview toolbar shows refresh/toggle/chip/download and no open-elsewhere icon; apps page cards show the source chip as a tooltip-only label; `/computer` and `/computer/<workspaceId>` return 404.
