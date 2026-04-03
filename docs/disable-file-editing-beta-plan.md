# Disable File Editing in Computer Tab During Beta

## Context

On 2026-04-03, a fraudster exploited the Computer Tab file editor to bypass agent safety review. The attack pattern:

1. Ask the agent to create an empty file
2. Switch to Computer Tab and manually write malicious code (WebSocket relay proxy)
3. Return to chat and say "deploy it" — agent deploys without safety review

The file editor lets users inject arbitrary code that the agent never generated and has no mandate to refuse. None of the existing safeguards (`<camelai system message>` file-safety injection, `<prohibited_activities>` system prompt) cover this path because they assume the agent authored the code.

**Decision:** Disable all user-initiated file mutations in the Computer Tab during beta. This will eventually become a paid-only feature.

## Scope

### What gets disabled (user-initiated from Computer Tab UI)

All file mutation operations triggered by the user through the Computer Tab:

| Operation | Frontend location | API route |
|-----------|------------------|-----------|
| Edit + save file content | Monaco editor save (`Ctrl+Cmd+S`, save button) | `POST /api/workspaces/:id/fs/write` |
| Create new file | "New file" dialog | `POST /api/workspaces/:id/fs/create` |
| Create new folder | "New folder" dialog | `POST /api/workspaces/:id/fs/mkdir` |
| Upload file | File upload drag-drop / button | `POST /api/workspaces/:id/fs/upload` |
| Move / rename | Drag-drop, rename dialog | `POST /api/workspaces/:id/fs/move` |
| Delete file / folder | Context menu delete | `POST /api/workspaces/:id/fs/delete` |
| External API file write | Programmatic API | `PUT /api/ext/files/write` |

### What stays enabled

- **Reading files** — `GET /api/workspaces/:id/fs/read`, `/fs/list`, `/fs/content/*` are unchanged
- **File download** — the download button remains
- **Agent-initiated file writes** — the agent writes files through the sandbox control plane, not through these API routes. Agent file operations are unaffected.
- **Chat attachment uploads** — `POST /api/workspaces/:id/upload` (R2 multipart uploads to `/mnt/user-uploads/`) is a separate path with its own `<camelai system message>` file-safety injection. Keep as-is.
- **External MCP `write_file` tool** — this goes through `ExternalMcpDO` and sandbox-host, not the `/fs/write` route. Separate review if needed.

## Implementation

### 1. Server-side: block mutation routes (the hard gate)

In each of the 6 mutation API routes (`fs/write`, `fs/create`, `fs/mkdir`, `fs/upload`, `fs/move`, `fs/delete`) and the external `ext.files.write` route, add an early return **after auth but before any write operation**:

```typescript
// In each mutation route's action(), after requireWorkspaceAuth():
return Response.json(
  { error: 'File editing is disabled during beta.' },
  { status: 403 }
);
```

**Implementation approach:** Add a shared helper to `workspaces.utils.ts`:

```typescript
/**
 * Returns a 403 response blocking user-initiated file mutations during beta.
 * Remove this function (and all call sites) when file editing is re-enabled
 * as a paid feature.
 */
export function blockBetaFileEdit(): Response {
  return Response.json(
    { error: 'File editing is disabled during beta.' },
    { status: 403 }
  );
}
```

Call `return blockBetaFileEdit()` at the top of each mutation route action, after auth. This is the security boundary — the frontend changes below are UX polish.

For `ext.files.write`, add the equivalent block after `requireBearerAuth()`.

**Files to modify:**
- `src/routes/api/workspaces.$id.fs.write.ts` — add after line 17
- `src/routes/api/workspaces.$id.fs.create.ts` — add after line 17
- `src/routes/api/workspaces.$id.fs.mkdir.ts` — add after line 17
- `src/routes/api/workspaces.$id.fs.upload.ts` — add after line 25
- `src/routes/api/workspaces.$id.fs.move.ts` — add after line 18
- `src/routes/api/workspaces.$id.fs.delete.ts` — add after line 17
- `src/routes/api/ext.files.write.ts` — add after line 9
- `src/routes/api/workspaces.utils.ts` — add `blockBetaFileEdit` helper

### 2. Frontend: make the Computer Tab read-only

In `src/components/pages/computer/computer-page-content.tsx`:

**a) Force `canMutate` to always be `false`:**

Change line 403:
```typescript
// Before:
const canMutate = editingEnabled && !readOnly;

// After:
const canMutate = false; // File editing disabled during beta
```

This single change propagates through the entire component — the Monaco editor becomes read-only, all context menu mutation items are disabled, drag-drop is disabled, the save shortcut is a no-op, new file/folder/upload buttons are disabled.

**b) Replace the "Enable editing" toggle with a disabled state message:**

At line 2074 (the "Enable editing..." context menu item) and line 2178-2191 (the bottom toolbar toggle), replace the interactive elements with a static label:

For the toolbar area around lines 2178-2191, replace the `Switch` toggle and "Enable editing" label with:
```tsx
<span className="text-xs text-muted-foreground">File editing is disabled during beta</span>
```

**c) Replace the "Enable editing" confirmation dialog (lines 2375-2398):**

Remove or skip rendering the `confirmEditOpen` dialog entirely since it can never trigger.

**d) Update the read-only hint (lines 2314-2324):**

Change the `AlertDescription` fallback text from `'Enable editing to modify files.'` to `'File editing is disabled during beta.'`

### 3. Handle 403 gracefully on the client

If somehow a mutation request reaches the server (e.g., stale client, browser dev tools), the 403 response should surface cleanly. The existing error handling in the save flow (around line 1030-1070) already reads `error` from the response JSON and surfaces it via tab error state. Verify this works for all mutation paths — no new error handling code should be needed, but test each path.

## Testing

1. **Manual testing:**
   - Open Computer Tab, verify editor is read-only (cursor shows read-only indicator)
   - Verify "Enable editing" toggle/menu item is replaced with beta message
   - Verify context menu items (new file, new folder, rename, delete, upload) are all disabled
   - Verify drag-drop does not work
   - Verify `Ctrl+Cmd+S` is a no-op
   - Verify file download still works
   - Verify file reading/browsing still works
   - Verify agent can still write files through chat

2. **API testing (curl or dev tools):**
   - `POST /api/workspaces/:id/fs/write` returns 403
   - `POST /api/workspaces/:id/fs/create` returns 403
   - `POST /api/workspaces/:id/fs/mkdir` returns 403
   - `POST /api/workspaces/:id/fs/upload` returns 403
   - `POST /api/workspaces/:id/fs/move` returns 403
   - `POST /api/workspaces/:id/fs/delete` returns 403
   - `PUT /api/ext/files/write` returns 403

3. **Existing tests:**
   - `bun run test` — unit tests should still pass (no behavior changes to tested units)
   - `bun run test:workers` — workers tests should still pass

## Rollback

To re-enable file editing (when it becomes a paid feature):

1. Remove the `blockBetaFileEdit()` calls from all 7 mutation routes
2. Remove the `blockBetaFileEdit` helper from `workspaces.utils.ts`
3. Restore `const canMutate = editingEnabled && !readOnly` in `computer-page-content.tsx`
4. Restore the "Enable editing" toggle UI and confirmation dialog
5. Add paid-tier gating in place of the beta block

## Not in scope

- **Paid feature gating logic** — that's a separate project once billing is wired up
- **Agent-side audit of user-edited files** — the agent sandbox path is unaffected; if we re-enable editing later, we should also add a pre-deploy audit step, but that's orthogonal
- **External MCP `write_file` tool** — goes through sandbox-host, not these routes. Flag for separate review if needed.
- **Chat attachment uploads** — separate upload path with existing safety injection
