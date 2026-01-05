# Clickable File Paths - Implementation Plan

This document extends the tool-call UX design to make file paths clickable. When clicked, files open in the Computer tab in a new browser tab.

---

## Overview

**Goal:** Make file paths in tool calls clickable, opening the referenced file in the Computer tab.

**Current State:**
- Tool calls display file paths as plain text (e.g., `Path: /home/claude/app/index.html`)
- The Computer page (`/computer/[orgId]`) has no deep linking support
- File paths appear in both the collapsed summary and expanded details

**Target State:**
- File paths are clickable links
- Clicking opens a new tab with the Computer page, file pre-selected
- Works for all file-related tools: Read, Write, Edit, Glob, Grep, NotebookEdit

---

## URL Design

### Deep Link Format

```
/computer/{orgId}?file={encodedPath}
```

**Examples:**
- `/computer/abc123?file=%2Fhome%2Fclaude%2Fapp%2Findex.html`
- `/computer/abc123?file=%2Fhome%2Fclaude%2Fstyle.css`

**Why query param instead of path segment:**
- File paths can be deeply nested (`/a/b/c/d/e.txt`)
- Path segments would conflict with Next.js routing
- Query params are simpler to encode/decode

### Alternative: Hash-based

```
/computer/{orgId}#/home/claude/app/index.html
```

Hash-based could work but query params are easier to read server-side if needed later.

**Recommendation:** Use query param `?file=`

---

## Implementation Phases

### Phase 1: Computer Page Deep Link Support

**Goal:** Make the Computer page respond to the `?file=` query param.

**Changes to `src/app/(app)/computer/[orgId]/computer-page-content.tsx`:**

1. Read `file` query param on mount
2. If present, call `openFile(decodedPath)` after initial load
3. Expand parent directories in the tree to reveal the file

**Implementation approach:**

```typescript
// In ComputerPageContent component

import { useSearchParams } from 'next/navigation';

// Inside component:
const searchParams = useSearchParams();
const initialFilePath = searchParams.get('file');

// Effect to handle deep link on mount
useEffect(() => {
  if (!initialFilePath || !hydrated) return;

  const decodedPath = decodeURIComponent(initialFilePath);

  // Ensure parent directories are expanded
  void ensurePathExpanded(decodedPath).then(() => {
    openFile(decodedPath);
    scrollToNode(decodedPath);
  });
}, [initialFilePath, hydrated, ensurePathExpanded, openFile, scrollToNode]);
```

**Key functions already available:**
- `ensurePathExpanded(path)` - Expands all parent directories
- `openFile(path)` - Opens file in editor
- `scrollToNode(path)` - Scrolls tree to show the file

**Acceptance criteria:**
- Navigating to `/computer/{orgId}?file=/path/to/file` opens that file
- Parent directories are auto-expanded in the tree
- File is selected in the tree view
- File content is shown in the editor

---

### Phase 2: FileLink Component

**Goal:** Create a reusable component for clickable file paths.

**Create `src/components/tool-call/file-link.tsx`:**

```typescript
"use client";

import { ExternalLink } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

interface FileLinkProps {
  /** The full file path (e.g., /home/claude/app/index.html) */
  path: string;
  /** Display text - defaults to filename only */
  children?: React.ReactNode;
  /** Show external link icon */
  showIcon?: boolean;
  /** Additional classes */
  className?: string;
  /** Use monospace font */
  mono?: boolean;
}

export function FileLink({
  path,
  children,
  showIcon = false,
  className,
  mono = false
}: FileLinkProps) {
  const { currentOrg } = useAuth();

  if (!path || !currentOrg?.id) {
    // Fallback to plain text if no org context
    return <span className={cn(mono && "font-mono", className)}>{children ?? path}</span>;
  }

  const href = `/computer/${currentOrg.id}?file=${encodeURIComponent(path)}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1 hover:underline",
        "text-foreground/80 hover:text-foreground",
        mono && "font-mono",
        className
      )}
      onClick={(e) => e.stopPropagation()} // Prevent triggering parent collapse
    >
      {children ?? path}
      {showIcon && <ExternalLink className="h-3 w-3 opacity-50" />}
    </a>
  );
}
```

**Key behaviors:**
- Opens in new tab (`target="_blank"`)
- `stopPropagation` prevents collapsing the tool call when clicking
- Graceful fallback to plain text if no org context
- Optional external link icon for clarity

**Acceptance criteria:**
- Component renders as a link
- Clicking opens new tab
- Link has proper encoding for special characters
- Fallback works when auth context unavailable

---

### Phase 3: Update Tool Detail Components

**Goal:** Replace plain file paths with FileLink in expanded details.

**Files to modify:**

1. **`details/shared.tsx`** - Update `DetailRow` to support link rendering

```typescript
// Add to DetailRow props
interface DetailRowProps {
  label: string;
  value?: React.ReactNode;
  copyValue?: string;
  mono?: boolean;
  className?: string;
  tooltipThreshold?: number;
  /** If true, renders value as a FileLink */
  asFileLink?: boolean;
  /** The file path for FileLink (uses value if not provided) */
  filePath?: string;
}

// Update rendering logic
export function DetailRow({
  label,
  value,
  copyValue,
  mono = false,
  className,
  tooltipThreshold = 48,
  asFileLink = false,
  filePath,
}: DetailRowProps) {
  // ... existing code ...

  let renderValue: React.ReactNode;

  if (asFileLink && typeof value === 'string') {
    renderValue = (
      <FileLink
        path={filePath ?? value}
        mono={mono}
        className="truncate block"
      >
        {value}
      </FileLink>
    );
  } else if (typeof value === 'string') {
    // ... existing truncation/tooltip logic ...
  } else {
    renderValue = value;
  }

  // ... rest of component ...
}
```

2. **`details/read-details.tsx`**

```typescript
// Change this:
<DetailRow label="Path:" value={path} copyValue={path} mono />

// To this:
<DetailRow label="Path:" value={path} copyValue={path} mono asFileLink />
```

3. **`details/write-details.tsx`**

```typescript
<DetailRow label="Path:" value={path} copyValue={path} mono asFileLink />
```

4. **`details/edit-details.tsx`**

```typescript
<DetailRow label="Path:" value={path} copyValue={path} mono asFileLink />
```

5. **`details/notebook-details.tsx`**

```typescript
// Similar pattern for notebook_path
<DetailRow label="Notebook:" value={notebookPath} copyValue={notebookPath} mono asFileLink />
```

6. **`details/search-details.tsx`** (Glob/Grep results)

For file lists in Glob/Grep results, each file in the list should be a FileLink:

```typescript
// In the file list rendering:
{files.map((file, i) => (
  <FileLink
    key={i}
    path={file}
    mono
    className="block truncate text-xs"
  />
))}
```

**Acceptance criteria:**
- All file paths in expanded details are clickable
- Copy button still works alongside the link
- Clicking link opens computer tab, doesn't collapse the tool call

---

### Phase 4: Clickable Filename in Collapsed Summary

**Goal:** Make the filename in the collapsed view clickable.

This is trickier because the collapsed view is a single clickable element (to expand). We need to:
1. Make the filename itself a link
2. Prevent the link click from triggering expand

**Update `tool-call.tsx`:**

```typescript
// Import FileLink
import { FileLink } from './file-link';

// Update the summary rendering to split into parts
function ToolCallSummary({
  tool,
  result,
  isStreaming
}: {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  isStreaming?: boolean;
}) {
  // Get action and filename separately
  const { action, filename, path } = getToolSummaryParts(tool, result);

  // If no path, just return plain text
  if (!path) {
    return <span className="tool-call__text min-w-0 flex-1 truncate">{action}</span>;
  }

  return (
    <span className="tool-call__text min-w-0 flex-1 truncate">
      {action}{' '}
      <FileLink path={path} className="hover:underline">
        {filename}
      </FileLink>
    </span>
  );
}
```

**Update `tool-summary.ts` to export parts:**

```typescript
interface ToolSummaryParts {
  action: string;      // "Read", "Created", "Edited"
  filename?: string;   // "Chat.tsx"
  path?: string;       // "/home/claude/src/Chat.tsx"
}

export function getToolSummaryParts(
  tool?: ToolUseBlock,
  result?: ToolResultBlock
): ToolSummaryParts {
  if (!tool) return { action: result ? 'Result' : 'Tool call' };

  const { name, input } = tool;
  const inputRecord = input || {};

  switch (name) {
    case 'Read': {
      const path = typeof inputRecord.file_path === 'string' ? inputRecord.file_path : '';
      return { action: 'Read', filename: getFilename(path), path: path || undefined };
    }
    case 'Write': {
      const path = typeof inputRecord.file_path === 'string' ? inputRecord.file_path : '';
      return { action: 'Created', filename: getFilename(path), path: path || undefined };
    }
    case 'Edit': {
      const path = typeof inputRecord.file_path === 'string' ? inputRecord.file_path : '';
      return { action: 'Edited', filename: getFilename(path), path: path || undefined };
    }
    // ... other cases return { action: 'whatever' } without path
    default:
      return { action: name };
  }
}

// Keep getToolSummary for backwards compatibility
export function getToolSummary(tool?: ToolUseBlock, result?: ToolResultBlock): string {
  const parts = getToolSummaryParts(tool, result);
  if (parts.filename) {
    return `${parts.action} ${parts.filename}`;
  }
  return parts.action;
}
```

**Important:** The FileLink's `onClick` with `stopPropagation` prevents the link click from triggering the Collapsible's toggle.

**Acceptance criteria:**
- Filename in collapsed view is a clickable link
- Clicking filename opens computer tab
- Clicking elsewhere on the row still expands the tool call
- Non-file tools (Bash, WebFetch, etc.) work normally

---

## Edge Cases

### 1. File doesn't exist

If the user clicks a link to a file that was deleted:
- The computer page will attempt to open it
- The existing `removeMissingTab` logic handles 404s gracefully
- User sees the file tree without the file selected

**No changes needed** - existing error handling is sufficient.

### 2. User not authenticated

- FileLink checks for `currentOrg` from auth context
- Falls back to plain text if not available
- Links won't be generated for unauthenticated views

### 3. Very long file paths

- FileLink uses truncation styling
- Tooltip shows full path on hover (inherited from DetailRow)

### 4. Special characters in paths

- `encodeURIComponent` handles spaces, unicode, etc.
- Computer page decodes with `decodeURIComponent`

---

## File Structure

```
src/components/tool-call/
├── file-link.tsx          # NEW: FileLink component
├── tool-call.tsx          # Update: Use FileLink in summary
├── tool-summary.ts        # Update: Add getToolSummaryParts
└── details/
    ├── shared.tsx         # Update: Add asFileLink prop to DetailRow
    ├── read-details.tsx   # Update: Use asFileLink
    ├── write-details.tsx  # Update: Use asFileLink
    ├── edit-details.tsx   # Update: Use asFileLink
    ├── notebook-details.tsx # Update: Use asFileLink
    └── search-details.tsx # Update: FileLink for file lists
```

---

## Testing Checklist

### Phase 1: Deep Link
- [ ] `/computer/{orgId}?file=/existing/file.txt` opens file
- [ ] `/computer/{orgId}?file=/deep/nested/path/file.txt` expands tree and opens
- [ ] `/computer/{orgId}?file=/nonexistent.txt` handles gracefully
- [ ] `/computer/{orgId}?file=` (empty) doesn't break
- [ ] Special characters in path work (`file=%2Fhome%2Ftest%20file.txt`)

### Phase 2: FileLink Component
- [ ] Renders as `<a>` tag
- [ ] Has `target="_blank"` and `rel="noopener noreferrer"`
- [ ] Generates correct href with encoded path
- [ ] Falls back to span when no auth context
- [ ] `stopPropagation` works

### Phase 3: Detail Components
- [ ] Read details path is clickable
- [ ] Write details path is clickable
- [ ] Edit details path is clickable
- [ ] NotebookEdit path is clickable
- [ ] Glob/Grep file lists have clickable files
- [ ] Copy button still works next to link

### Phase 4: Collapsed Summary
- [ ] "Read Chat.tsx" has clickable "Chat.tsx"
- [ ] "Created index.html" has clickable "index.html"
- [ ] "Edited style.css" has clickable "style.css"
- [ ] Clicking filename opens new tab
- [ ] Clicking elsewhere expands tool call
- [ ] Non-file tools (Bash, Task, etc.) unchanged

---

## Summary

This implementation adds clickable file paths in 4 phases:

1. **Computer page deep link** - Accept `?file=` query param
2. **FileLink component** - Reusable link component
3. **Detail components** - Use FileLink for paths in expanded view
4. **Collapsed summary** - Make filename clickable in collapsed view

The changes are additive and non-breaking. Each phase can be implemented and tested independently.
