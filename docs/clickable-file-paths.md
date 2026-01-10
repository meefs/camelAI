# Clickable File Paths - Implementation Plan

This document extends the tool-call UX design to make file paths clickable. When clicked, files open in the Computer tab in a new browser tab.

---

## Overview

**Goal:** Make file paths in tool calls clickable, opening the referenced file in the Computer tab.

**Current State:**
- FileLink component exists at `src/components/tool-call/file-link.tsx`
- **Bug:** FileLink uses `currentOrg.id` in the URL but should use `currentWorkspace?.id`
- The computer page route is `/computer/[orgId]` but the param is actually a `workspaceId` (confusing naming)
- Computer page already supports `?file=` query param for deep linking

**Schema Context (Important):**
- **Org → Workspace**: One-to-many (orgs have multiple workspaces)
- **Workspace → Container**: One-to-one (each workspace has its own container)
- **Threads → Workspace**: Threads are stored per-workspace (ChatIndexDO is per-workspace)
- **Session has `workspace_id`**: Tracks user's current workspace

**Target State:**
- File paths are clickable links using the correct workspace ID
- Clicking opens a new tab with the Computer page, file pre-selected
- Works for all file-related tools: Read, Write, Edit, Glob, Grep, NotebookEdit

---

## URL Design

### Deep Link Format

```
/computer/{workspaceId}?file={encodedPath}
```

**Examples:**
- `/computer/ws_abc123?file=%2Fapp%2Findex.html`
- `/computer/ws_abc123?file=%2Fstyle.css`

**Note:** The route param is named `[orgId]` in `src/app/(app)/computer/[orgId]/` but is actually a workspace ID. See `page.tsx` line 10 where `orgId` is renamed to `workspaceId`:
```typescript
const { orgId: workspaceId } = await params;
```

---

## Implementation Tasks

### Task 1: Fix FileLink to Use Workspace ID

**File:** `src/components/tool-call/file-link.tsx`

**Current (broken):**
```typescript
const { currentOrg } = useAuth();
// ...
const href = `/computer/${currentOrg.id}?file=${encodeURIComponent(normalizedPath)}`;
```

**Fixed:**
```typescript
const { currentWorkspace } = useAuth();
// ...
if (!normalizedPath || !currentWorkspace?.id) {
  return (
    <span className={cn(mono && "font-mono", className)}>
      {children ?? path}
    </span>
  );
}

const href = `/computer/${currentWorkspace.id}?file=${encodeURIComponent(normalizedPath)}`;
```

**Key changes:**
1. Import `currentWorkspace` instead of `currentOrg` from `useAuth()`
2. Check `currentWorkspace?.id` instead of `currentOrg?.id`
3. Use `currentWorkspace.id` in the URL

**Why this works:**
- AuthContext already provides `currentWorkspace` (see `src/contexts/AuthContext.tsx` line 47, 66-67)
- Chat component receives `workspaceId` prop and the session tracks `workspace_id`
- When user is in a chat, `currentWorkspace` will be set to the workspace containing that thread

**Acceptance criteria:**
- [ ] Clicking a file link opens `/computer/{workspaceId}?file=...`
- [ ] File link falls back to plain text when `currentWorkspace` is null
- [ ] Links work correctly in different workspaces

---

### Task 2: Verify Computer Page Deep Link Support

**File:** `src/app/(app)/computer/[orgId]/computer-page-content.tsx`

The computer page already has deep link support. Verify the following work correctly:

**Expected behavior:**
1. `?file=` query param is read on mount via `useSearchParams()`
2. Path is decoded and normalized (removes `/home/claude`, `/workspace`, `/root` prefixes)
3. Parent directories are expanded in the tree
4. File is opened in the editor

**Testing checklist:**
- [ ] `/computer/{workspaceId}?file=/app/index.html` opens the file
- [ ] `/computer/{workspaceId}?file=/deep/nested/path/file.txt` expands tree and opens
- [ ] `/computer/{workspaceId}?file=/nonexistent.txt` handles gracefully (no crash)
- [ ] Special characters in path work (`file=%2Ftest%20file.txt`)

---

### Task 3: Verify Tool Detail Components Use FileLink

Check that all file-related tool detail components use the FileLink component:

**Files to verify:**

| File | Path Field | Status |
|------|------------|--------|
| `details/read-details.tsx` | `file_path` | ☐ Check |
| `details/write-details.tsx` | `file_path` | ☐ Check |
| `details/edit-details.tsx` | `file_path` | ☐ Check |
| `details/notebook-details.tsx` | `notebook_path` | ☐ Check |
| `details/search-details.tsx` | File list items | ☐ Check |

If any are not using FileLink, update them to use `<FileLink path={...}>`.

---

### Task 4: Verify Collapsed Summary Uses FileLink

**File:** `src/components/tool-call/tool-call.tsx`

Check that the collapsed summary (e.g., "Read Chat.tsx", "Edited index.html") has the filename as a clickable FileLink.

**Expected behavior:**
- Clicking the filename opens the computer tab
- Clicking elsewhere on the row expands the tool call
- FileLink's `stopPropagation` prevents click bubbling

---

## Edge Cases

### 1. File doesn't exist
- The computer page will attempt to open it
- Existing error handling shows file tree without the file selected
- **No changes needed** - existing behavior is acceptable

### 2. User not authenticated or no workspace
- FileLink checks for `currentWorkspace` from auth context
- Falls back to plain text if not available
- Links won't be generated for unauthenticated views

### 3. Cross-workspace file references
- If a historical message references a file from a different workspace, the link will go to the current workspace
- This is acceptable since files are workspace-scoped and old references may be stale anyway

### 4. Special characters in paths
- `encodeURIComponent` handles spaces, unicode, etc.
- Computer page decodes with `decodeURIComponent`

---

## File Structure Reference

```
src/components/tool-call/
├── file-link.tsx              # FIX: Use currentWorkspace.id
├── tool-call.tsx              # VERIFY: Uses FileLink in summary
├── tool-summary.ts            # Helper for summary text
└── details/
    ├── shared.tsx             # DetailRow with asFileLink prop
    ├── read-details.tsx       # VERIFY: Uses FileLink
    ├── write-details.tsx      # VERIFY: Uses FileLink
    ├── edit-details.tsx       # VERIFY: Uses FileLink
    ├── notebook-details.tsx   # VERIFY: Uses FileLink
    └── search-details.tsx     # VERIFY: Uses FileLink for file lists

src/app/(app)/computer/[orgId]/
├── page.tsx                   # Route wrapper (param is workspaceId despite name)
└── computer-page-content.tsx  # VERIFY: ?file= deep link works

src/contexts/AuthContext.tsx   # Provides currentWorkspace
```

---

## Testing Checklist

### FileLink Fix
- [ ] FileLink uses `currentWorkspace.id` in URL
- [ ] Fallback to plain text when no workspace context
- [ ] Click opens new tab with correct workspace

### Deep Link
- [ ] `/computer/{workspaceId}?file=/existing/file.txt` opens file
- [ ] `/computer/{workspaceId}?file=/deep/nested/path/file.txt` expands tree and opens
- [ ] `/computer/{workspaceId}?file=/nonexistent.txt` handles gracefully
- [ ] `/computer/{workspaceId}?file=` (empty) doesn't break
- [ ] Special characters in path work

### Tool Details
- [ ] Read details path is clickable
- [ ] Write details path is clickable
- [ ] Edit details path is clickable
- [ ] NotebookEdit path is clickable
- [ ] Glob/Grep file lists have clickable files
- [ ] Copy button still works next to link

### Collapsed Summary
- [ ] "Read Chat.tsx" has clickable "Chat.tsx"
- [ ] "Created index.html" has clickable "index.html"
- [ ] "Edited style.css" has clickable "style.css"
- [ ] Clicking filename opens new tab
- [ ] Clicking elsewhere expands tool call
- [ ] Non-file tools (Bash, Task, etc.) unchanged

---

## Tests

### Task 5: Add Regression Test for FileLink

**Create:** `tests/file-link.test.tsx`

This test ensures FileLink uses `workspaceId` (not `orgId`) in generated URLs, preventing regression to the old org-based routing.

```typescript
/**
 * Regression test for FileLink component
 *
 * Ensures file links use workspaceId (not orgId) in URLs.
 * This is critical because the schema changed from org→container to workspace→container.
 *
 * Run with: npm run test:run -- tests/file-link.test.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock useAuth to return controlled workspace/org values
const mockUseAuth = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

// Import after mocking
import { FileLink } from '@/components/tool-call/file-link';

describe('FileLink', () => {
  describe('URL generation regression test', () => {
    it('uses workspaceId, NOT orgId, in the href', () => {
      // Setup: workspace and org have DIFFERENT IDs
      mockUseAuth.mockReturnValue({
        currentOrg: { id: 'org-123', name: 'Test Org' },
        currentWorkspace: { id: 'ws-456', name: 'Test Workspace' },
      });

      render(<FileLink path="/app/index.html" />);

      const link = screen.getByRole('link');
      const href = link.getAttribute('href');

      // CRITICAL: URL must contain workspace ID, not org ID
      expect(href).toContain('/computer/ws-456');
      expect(href).not.toContain('/computer/org-123');
      expect(href).toContain('file=%2Fapp%2Findex.html');
    });

    it('falls back to plain text when no workspace is set', () => {
      mockUseAuth.mockReturnValue({
        currentOrg: { id: 'org-123', name: 'Test Org' },
        currentWorkspace: null,
      });

      render(<FileLink path="/app/index.html" />);

      // Should render as span, not link
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByText('/app/index.html')).toBeInTheDocument();
    });
  });

  describe('path normalization', () => {
    it('strips /home/claude prefix from paths', () => {
      mockUseAuth.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/home/claude/app/index.html" />);

      const link = screen.getByRole('link');
      const href = link.getAttribute('href');

      // Should normalize to /app/index.html
      expect(href).toContain('file=%2Fapp%2Findex.html');
      expect(href).not.toContain('home');
      expect(href).not.toContain('claude');
    });

    it('strips /workspace prefix from paths', () => {
      mockUseAuth.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/workspace/app/style.css" />);

      const link = screen.getByRole('link');
      expect(link.getAttribute('href')).toContain('file=%2Fapp%2Fstyle.css');
    });
  });

  describe('link behavior', () => {
    it('opens in new tab with security attributes', () => {
      mockUseAuth.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/app/index.html" />);

      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('encodes special characters in file paths', () => {
      mockUseAuth.mockReturnValue({
        currentWorkspace: { id: 'ws-456' },
      });

      render(<FileLink path="/app/my file (1).html" />);

      const link = screen.getByRole('link');
      const href = link.getAttribute('href');

      // Spaces and parentheses should be encoded
      expect(href).toContain('file=%2Fapp%2Fmy%20file%20(1).html');
    });
  });
});
```

**Why this test matters:**
- The first test explicitly checks that `workspaceId` (not `orgId`) appears in the URL
- Uses different IDs for workspace and org to catch the regression
- If someone accidentally reverts to `currentOrg.id`, this test will fail

**Running the test:**
```bash
npm run test:run -- tests/file-link.test.tsx
```

---

## Summary

The main fix is straightforward: update `file-link.tsx` to use `currentWorkspace.id` instead of `currentOrg.id`. The rest of the infrastructure (computer page deep links, FileLink component, tool detail components) appears to already be in place.

**Implementation order:**
1. Fix FileLink to use workspace ID
2. Add regression test for FileLink
3. Verify computer page deep links work
4. Verify all tool details use FileLink
5. Test end-to-end

**Estimated scope:** Small - primarily a one-line fix in `file-link.tsx`, a new test file, and verification of existing functionality.
