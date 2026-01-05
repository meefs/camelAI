# Streaming Tool Summaries - Implementation Plan

This document addresses the confusing UX when tool calls are streaming and their input parameters haven't been received yet.

---

## Problem Statement

When a tool call is streaming, the input JSON is built incrementally:

1. `content_block_start` → tool created with `name` but `input: {}`
2. `input_json_delta` → partial JSON accumulated in `_inputJson`
3. `content_block_stop` → JSON parsed into `input`

**Result:** During streaming, tools show incomplete summaries:

| Tool | Streaming Display | Issue |
|------|-------------------|-------|
| Write | "Created" | No filename - just a single word |
| Read | "Read" | No filename - just a single word |
| Edit | "Edited" | No filename - just a single word |
| Bash | "Ran command" | Generic fallback, no actual command |
| Grep | `Searching for ""...` | Empty quotes look broken |
| WebFetch | "Fetched web page" | Generic, no URL |

Users see a single word like "Created" with a pulsing blue dot and have no context about what's happening.

---

## Solution

Add streaming-aware summaries that:

1. Use **present continuous tense** during streaming ("Creating...", "Reading...")
2. Use **past tense** when complete ("Created", "Read")
3. Show a **meaningful action** even without input parameters
4. Indicate **in-progress state** through language, not just the status dot

---

## Tool Analysis

### Affected Tools (need streaming summaries)

| Tool | Current (no input) | Streaming Summary | Complete Summary |
|------|-------------------|-------------------|------------------|
| Read | "Read" | "Reading file..." | "Read filename.txt" |
| Write | "Created" | "Creating file..." | "Created filename.txt" |
| Edit | "Edited" | "Editing file..." | "Edited filename.txt" |
| Bash | "Ran command" | "Running command..." | "Ran npm install" |
| Grep | `Searching for ""...` | "Searching..." | `Searching for "pattern"...` |
| WebFetch | "Fetched web page" | "Fetching page..." | "Fetched example.com" |

### Unaffected Tools (already work well)

| Tool | Streaming Summary | Why It Works |
|------|-------------------|--------------|
| Glob | "Searching for files..." | Already uses streaming-friendly text |
| Task | "Agent: working..." | Has built-in fallback |
| WebSearch | "Searched web" | Static, no input dependency |
| TodoWrite | "Updated tasks" | Static |
| NotebookEdit | "Edited notebook cell" | Static |
| KillShell | "Stopped background task" | Static |
| TaskOutput | "Retrieved task output" | Static |

---

## Implementation

### Phase 1: Update `getToolSummaryParts` Signature

Add `isStreaming` parameter:

```typescript
export interface ToolSummaryParts {
  action: string;
  filename?: string;
  path?: string;
}

export function getToolSummaryParts(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  isStreaming?: boolean  // NEW
): ToolSummaryParts {
  // ...
}
```

### Phase 2: Update Tool Cases

**Read:**
```typescript
case 'Read': {
  const path =
    typeof inputRecord.file_path === 'string'
      ? inputRecord.file_path
      : typeof inputRecord.path === 'string'
        ? inputRecord.path
        : '';

  // Streaming with no path yet
  if (isStreaming && !path) {
    return { action: 'Reading file...' };
  }

  return {
    action: 'Read',
    filename: path ? getFilename(path) : undefined,
    path: path || undefined,
  };
}
```

**Write:**
```typescript
case 'Write': {
  const path =
    typeof inputRecord.file_path === 'string'
      ? inputRecord.file_path
      : typeof inputRecord.path === 'string'
        ? inputRecord.path
        : '';

  // Streaming with no path yet
  if (isStreaming && !path) {
    return { action: 'Creating file...' };
  }

  return {
    action: 'Created',
    filename: path ? getFilename(path) : undefined,
    path: path || undefined,
  };
}
```

**Edit:**
```typescript
case 'Edit': {
  const path =
    typeof inputRecord.file_path === 'string'
      ? inputRecord.file_path
      : typeof inputRecord.path === 'string'
        ? inputRecord.path
        : '';

  // Streaming with no path yet
  if (isStreaming && !path) {
    return { action: 'Editing file...' };
  }

  return {
    action: 'Edited',
    filename: path ? getFilename(path) : undefined,
    path: path || undefined,
  };
}
```

**Bash:**
```typescript
case 'Bash': {
  const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
  const command = typeof inputRecord.command === 'string' ? inputRecord.command : '';

  // Streaming with no command/description yet
  if (isStreaming && !description && !command) {
    return { action: 'Running command...' };
  }

  return {
    action: description
      ? `Ran ${description}`
      : `Ran ${truncate(command || 'command', 30)}`,
  };
}
```

**Grep:**
```typescript
case 'Grep': {
  const count = parseCountFromResult(result);
  if (count !== null) return { action: `Found ${count} matches` };

  const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';

  // Streaming with no pattern yet - don't show empty quotes
  if (isStreaming && !pattern) {
    return { action: 'Searching...' };
  }

  return { action: `Searching for "${truncate(pattern || 'pattern', 20)}"...` };
}
```

**WebFetch:**
```typescript
case 'WebFetch': {
  const url = typeof inputRecord.url === 'string' ? inputRecord.url : '';

  // Streaming with no URL yet
  if (isStreaming && !url) {
    return { action: 'Fetching page...' };
  }

  return { action: `Fetched ${url ? getHostname(url) : 'web page'}` };
}
```

### Phase 3: Update Callers

**In `tool-call.tsx`:**

```typescript
function ToolCallSummary({
  tool,
  result,
  isStreaming,  // ADD THIS
}: {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  isStreaming?: boolean;  // ADD THIS
}) {
  const parts = useMemo(
    () => getToolSummaryParts(tool, result, isStreaming),  // PASS IT
    [tool, result, isStreaming]
  );

  // ... rest unchanged
}

export function ToolCall({ tool, result, isStreaming, defaultExpanded = false }: ToolCallProps) {
  // ...

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <div /* ... */>
          <span className={/* status dot */} />
          <ToolCallSummary tool={tool} result={result} isStreaming={isStreaming} />  {/* PASS IT */}
          <ChevronRight /* ... */ />
        </div>
      </CollapsibleTrigger>
      {/* ... */}
    </Collapsible>
  );
}
```

---

## Full Updated `getToolSummaryParts`

```typescript
export function getToolSummaryParts(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  isStreaming?: boolean
): ToolSummaryParts {
  if (!tool) return { action: result ? 'Result' : 'Tool call' };

  const { name, input } = tool;
  const inputRecord = input || {};

  switch (name) {
    case 'Read': {
      const path =
        typeof inputRecord.file_path === 'string'
          ? inputRecord.file_path
          : typeof inputRecord.path === 'string'
            ? inputRecord.path
            : '';
      if (isStreaming && !path) {
        return { action: 'Reading file...' };
      }
      return {
        action: 'Read',
        filename: path ? getFilename(path) : undefined,
        path: path || undefined,
      };
    }

    case 'Write': {
      const path =
        typeof inputRecord.file_path === 'string'
          ? inputRecord.file_path
          : typeof inputRecord.path === 'string'
            ? inputRecord.path
            : '';
      if (isStreaming && !path) {
        return { action: 'Creating file...' };
      }
      return {
        action: 'Created',
        filename: path ? getFilename(path) : undefined,
        path: path || undefined,
      };
    }

    case 'Edit': {
      const path =
        typeof inputRecord.file_path === 'string'
          ? inputRecord.file_path
          : typeof inputRecord.path === 'string'
            ? inputRecord.path
            : '';
      if (isStreaming && !path) {
        return { action: 'Editing file...' };
      }
      return {
        action: 'Edited',
        filename: path ? getFilename(path) : undefined,
        path: path || undefined,
      };
    }

    case 'Bash': {
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      const command = typeof inputRecord.command === 'string' ? inputRecord.command : '';
      if (isStreaming && !description && !command) {
        return { action: 'Running command...' };
      }
      return {
        action: description
          ? `Ran ${description}`
          : `Ran ${truncate(command || 'command', 30)}`,
      };
    }

    case 'Glob': {
      const count = parseCountFromResult(result);
      return { action: count !== null ? `Found ${count} files` : 'Searching for files...' };
    }

    case 'Grep': {
      const count = parseCountFromResult(result);
      if (count !== null) return { action: `Found ${count} matches` };
      const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
      if (isStreaming && !pattern) {
        return { action: 'Searching...' };
      }
      return { action: `Searching for "${truncate(pattern || 'pattern', 20)}"...` };
    }

    case 'Task': {
      if (result) return { action: 'Agent completed task' };
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      return { action: `Agent: ${description || 'working...'}` };
    }

    case 'WebFetch': {
      const url = typeof inputRecord.url === 'string' ? inputRecord.url : '';
      if (isStreaming && !url) {
        return { action: 'Fetching page...' };
      }
      return { action: `Fetched ${url ? getHostname(url) : 'web page'}` };
    }

    case 'WebSearch':
      return { action: 'Searched web' };

    case 'TodoWrite':
      return { action: 'Updated tasks' };

    case 'NotebookEdit':
      return { action: 'Edited notebook cell' };

    case 'KillShell':
      return { action: 'Stopped background task' };

    case 'TaskOutput':
      return { action: 'Retrieved task output' };

    default:
      return { action: name };
  }
}
```

---

## Before/After Examples

### Write Tool

**Before (streaming):**
```
• Created
```
User sees a single word with a pulsing dot. Confusing.

**After (streaming):**
```
• Creating file...
```
User understands a file is being created.

**After (complete):**
```
• Created index.html
```
Clear, past tense, with filename.

### Bash Tool

**Before (streaming):**
```
• Ran command
```
Generic, doesn't communicate progress.

**After (streaming):**
```
• Running command...
```
Clear that something is actively happening.

**After (complete):**
```
• Ran npm install
```
Shows actual command.

### Grep Tool

**Before (streaming, no pattern yet):**
```
• Searching for ""...
```
Empty quotes look like a bug.

**After (streaming, no pattern yet):**
```
• Searching...
```
Clean, no broken-looking quotes.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/tool-call/tool-summary.ts` | Add `isStreaming` param, update all affected cases |
| `src/components/tool-call/tool-call.tsx` | Pass `isStreaming` to `ToolCallSummary` and `getToolSummaryParts` |

---

## Testing Checklist

### Streaming State
- [ ] Write shows "Creating file..." when streaming without path
- [ ] Read shows "Reading file..." when streaming without path
- [ ] Edit shows "Editing file..." when streaming without path
- [ ] Bash shows "Running command..." when streaming without command
- [ ] Grep shows "Searching..." when streaming without pattern
- [ ] WebFetch shows "Fetching page..." when streaming without URL

### Transition to Complete
- [ ] Write changes to "Created filename.txt" when input arrives
- [ ] Read changes to "Read filename.txt" when input arrives
- [ ] Edit changes to "Edited filename.txt" when input arrives
- [ ] Bash changes to "Ran {command}" when input arrives
- [ ] Grep changes to `Searching for "pattern"...` when pattern arrives

### Non-Streaming (Historical Messages)
- [ ] Completed tools show past tense summaries
- [ ] Filenames are clickable links
- [ ] No "..." suffix on completed actions

### Edge Cases
- [ ] Tool with result but isStreaming=false shows complete state
- [ ] Tool with no result and isStreaming=false shows appropriate fallback
- [ ] Very long commands still truncate properly

---

## Design Rationale

### Why Ellipsis (...)?

The trailing `...` on streaming summaries communicates "in progress" without requiring users to understand the blue pulsing dot:

- "Creating file..." → clearly incomplete
- "Created index.html" → clearly complete

### Why Present Continuous Tense?

It matches user mental model:

- "Creating" = happening now
- "Created" = already done

This is consistent with how other apps communicate progress (e.g., "Uploading...", "Saving...").

### Why Not Just "Write" or "Read"?

Single-word tool names don't communicate what's happening:

- "Write" → write what?
- "Creating file..." → ah, it's making a file

The action verb makes the tool's purpose clear even to users unfamiliar with the underlying tool names.

---

## Summary

This is a small change with high UX impact. By adding streaming-aware summaries, users always have context about what's happening, even before the full tool input is received.

**Key changes:**
1. Add `isStreaming` parameter to `getToolSummaryParts`
2. Return present-continuous summaries when streaming without required input
3. Pass `isStreaming` through from `ToolCall` component

**Scope:** ~30 lines of changes across 2 files.
