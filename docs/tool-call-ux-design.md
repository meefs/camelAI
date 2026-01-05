# Tool Call UX Design Specification

This document outlines the UX design for tool calls in Chiridion. The design prioritizes **minimal visual weight** while providing depth for users who want more context.

---

## Design Philosophy

### Core Principles

1. **Whisper, don't shout** - Tool calls are background work. They should inform, not distract.
2. **Trust the agent** - Errors are the agent's problem to solve, not the user's. Keep error states subtle.
3. **Progressive disclosure** - Simple by default, detailed on demand.
4. **Respect the flow** - Many tool calls happen in sequence. The UI must stay calm.

### Visual Inspiration

The target aesthetic is a single line with minimal elements:

```
• Edited filename.css
```

That's it. A dot, an action, a target. No icons, no borders, no color themes.

---

## Default (Collapsed) State

### Structure

```
[status dot] [action verb] [target]
```

### Examples

| Tool | Default Display |
|------|-----------------|
| Read | `• Read Chat.tsx` |
| Write | `• Created index.html` |
| Edit | `• Edited Chat.tsx` |
| Bash | `• Ran npm install` |
| Glob | `• Found 23 files` |
| Grep | `• Searched for "pattern"` |
| Task | `• Agent completed task` |
| WebFetch | `• Fetched example.com` |
| WebSearch | `• Searched web` |
| TodoWrite | `• Updated tasks` |
| NotebookEdit | `• Edited notebook cell` |

### Status Dot Colors

| Status | Color | Tailwind Class |
|--------|-------|----------------|
| Running | Blue | `bg-blue-500` |
| Complete | Green | `bg-green-500` |
| Error | Red | `bg-red-500` |

The dot is small (6-8px) and the only color element. Everything else is `text-muted-foreground`.

### Styling

```css
.tool-call {
  @apply flex items-center gap-2 py-1 text-sm text-muted-foreground;
  @apply hover:bg-muted/30 rounded px-2 -mx-2 cursor-pointer;
  @apply transition-colors duration-150;
}

.tool-call__dot {
  @apply w-1.5 h-1.5 rounded-full shrink-0;
}

.tool-call__dot--running {
  @apply bg-blue-500 animate-pulse;
}

.tool-call__dot--complete {
  @apply bg-green-500;
}

.tool-call__dot--error {
  @apply bg-red-500;
}

.tool-call__text {
  @apply truncate;
}

.tool-call__chevron {
  @apply ml-auto opacity-0 transition-opacity duration-150;
  @apply text-muted-foreground/50;
}

.tool-call:hover .tool-call__chevron {
  @apply opacity-100;
}
```

### Hover Behavior

On hover:
1. Subtle background highlight (`bg-muted/30`)
2. Chevron (`ChevronRight` or `ChevronDown`) fades in on the right
3. Cursor becomes pointer

The chevron is the only indication that clicking will reveal more.

---

## Expanded State

When clicked, the tool call expands to show details. The expansion should feel lightweight - not a heavy card or modal.

### Structure

```
[status dot] [action verb] [target]              [chevron ▼]
  └─ [detail line 1]
     [detail line 2]
     [content preview or output]
```

### Example: Edit Tool

**Collapsed:**
```
• Edited Chat.tsx
```

**Expanded:**
```
• Edited Chat.tsx                                      ▼
  Path: src/components/Chat.tsx
  Changes: 3 replacements

  - const foo = 'old';
  + const foo = 'new';
```

### Example: Bash Tool

**Collapsed:**
```
• Ran npm install
```

**Expanded:**
```
• Ran npm install                                      ▼
  Command: npm install
  Exit code: 0

  added 234 packages in 12s
  45 packages are looking for funding
```

### Example: Error State

**Collapsed (same as success, just red dot):**
```
• Read config.json
```

**Expanded (error details visible):**
```
• Read config.json                                     ▼
  Error: File does not exist
  Path: /home/claude/config.json
```

Note: The red dot signals something went wrong, but we don't add warning icons or red backgrounds. The agent will handle it.

### Expanded Content Styling

```css
.tool-call__details {
  @apply pl-4 mt-1 text-xs text-muted-foreground/80;
  @apply border-l border-border/50 ml-1;
}

.tool-call__details-row {
  @apply py-0.5;
}

.tool-call__details-label {
  @apply text-muted-foreground/60;
}

.tool-call__output {
  @apply mt-2 font-mono text-xs bg-muted/30 rounded p-2;
  @apply max-h-32 overflow-auto;
}
```

---

## Tool-Specific Display Logic

### Summary Text Generation

Each tool should generate a concise summary string:

```typescript
function getToolSummary(tool: ToolUseBlock, result?: ToolResultBlock): string {
  const { name, input } = tool;

  switch (name) {
    case 'Read':
      return `Read ${getFilename(input.file_path as string)}`;

    case 'Write':
      return `Created ${getFilename(input.file_path as string)}`;

    case 'Edit':
      return `Edited ${getFilename(input.file_path as string)}`;

    case 'Bash':
      // Prefer description if provided, else truncate command
      return input.description
        ? `Ran ${input.description}`
        : `Ran ${truncate(input.command as string, 30)}`;

    case 'Glob':
      const globCount = parseGlobCount(result);
      return globCount !== null
        ? `Found ${globCount} files`
        : `Searching for files...`;

    case 'Grep':
      const grepCount = parseGrepCount(result);
      return grepCount !== null
        ? `Found ${grepCount} matches`
        : `Searching for "${truncate(input.pattern as string, 20)}"...`;

    case 'Task':
      return result
        ? `Agent completed task`
        : `Agent: ${input.description || 'working...'}`;

    case 'WebFetch':
      return `Fetched ${getHostname(input.url as string)}`;

    case 'WebSearch':
      return `Searched web`;

    case 'TodoWrite':
      return `Updated tasks`;

    case 'NotebookEdit':
      return `Edited notebook cell`;

    case 'KillShell':
      return `Stopped background task`;

    case 'TaskOutput':
      return `Retrieved task output`;

    default:
      return `${name}`;
  }
}

// Helpers
function getFilename(path: string): string {
  return path.split('/').pop() || path;
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str;
}
```

### Expanded Details by Tool

| Tool | Expanded Details |
|------|------------------|
| Read | Full path, line count, content preview (first ~10 lines) |
| Write | Full path, file size, content preview |
| Edit | Full path, replacement count, inline diff |
| Bash | Full command, exit code, stdout/stderr |
| Glob | Pattern, search path, file list |
| Grep | Pattern, path, matches with line numbers |
| Task | Agent type, model, prompt, result summary |
| WebFetch | Full URL, prompt used, response |
| WebSearch | Query, result list with titles/URLs |
| TodoWrite | Task list with status indicators |
| NotebookEdit | Notebook path, cell ID, new content |

---

## Thinking Blocks

Thinking blocks are NOT tool calls. They should be styled differently - even more subtle.

**Default (collapsed):**
```
Thinking...
```

**Expanded:**
```
Thinking...                                            ▼
  Let me analyze this step by step...
  First, I need to consider...
```

Styling: Italic, lighter text, no dot.

```css
.thinking-block {
  @apply text-sm text-muted-foreground/60 italic;
  @apply hover:bg-muted/20 rounded px-2 -mx-2 cursor-pointer;
}
```

---

## Implementation Phases

Break implementation into phases to ensure quality at each step.

### Phase 1: Core Component Structure

**Goal:** Replace current tool rendering with minimal collapsed view.

**Deliverables:**
1. Create `ToolCall` component with props:
   ```typescript
   interface ToolCallProps {
     tool?: ToolUseBlock;
     result?: ToolResultBlock;
     isStreaming?: boolean;
   }
   ```
2. Implement status dot (running/complete/error)
3. Implement `getToolSummary()` for all tools
4. Basic text display: `[dot] [summary]`
5. No expand/collapse yet - just the single line

**Files to create/modify:**
- `src/components/tool-call.tsx` (new)
- `src/components/Chat.tsx` (use new component)

**Acceptance criteria:**
- All tool calls render as single line
- Dot color reflects status
- Running tools show pulsing blue dot
- Completed tools show static green dot
- Error tools show static red dot
- Text is muted and doesn't compete with message content

---

### Phase 2: Expand/Collapse Behavior

**Goal:** Add hover chevron and click-to-expand functionality.

**Deliverables:**
1. Add chevron that appears on hover (right side)
2. Implement expand/collapse state
3. Create expanded container with left border
4. Implement basic details display (path, counts, etc.)
5. Use Radix Collapsible for smooth animation

**Component structure:**
```tsx
<Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
  <CollapsibleTrigger asChild>
    <div className="tool-call">
      <StatusDot status={status} />
      <span className="tool-call__text">{summary}</span>
      <ChevronRight className={cn(
        "tool-call__chevron",
        isExpanded && "rotate-90"
      )} />
    </div>
  </CollapsibleTrigger>
  <CollapsibleContent>
    <ToolCallDetails tool={tool} result={result} />
  </CollapsibleContent>
</Collapsible>
```

**Acceptance criteria:**
- Chevron hidden by default, visible on hover
- Click anywhere on tool call to expand
- Smooth expand/collapse animation
- Expanded state shows tool-specific details
- Chevron rotates when expanded

---

### Phase 3: Rich Expanded Content

**Goal:** Add meaningful detail views for each tool type.

**Deliverables:**
1. `ToolCallDetails` sub-components per tool type
2. Code/output display with syntax highlighting (optional)
3. Diff view for Edit tool
4. File list for Glob/Grep results
5. Scrollable output containers with max-height

**Tool-specific components:**
- `ReadDetails` - path, lines, content preview
- `WriteDetails` - path, size, content preview
- `EditDetails` - path, diff view
- `BashDetails` - command, exit code, output
- `SearchDetails` - pattern, matches (for Glob/Grep)
- `TaskDetails` - agent info, result
- `WebDetails` - URL, response (for WebFetch/WebSearch)

**Acceptance criteria:**
- Each tool type has appropriate expanded view
- Long outputs are scrollable (max-height: 128px or similar)
- Diffs show red/green for removed/added lines
- File paths are displayed but not clickable yet

---

### Phase 4: Interactivity

**Goal:** Add copy buttons, clickable paths, and tooltips.

**Deliverables:**
1. Copy button for:
   - File paths
   - Command outputs
   - Full tool input/output JSON
2. Tooltip on truncated text showing full value
3. Hover states for interactive elements

**Copy button behavior:**
- Appears on hover within expanded details
- Small, unobtrusive (ghost button, small icon)
- Shows checkmark briefly after click

**Acceptance criteria:**
- Users can copy paths with one click
- Users can copy command output
- Tooltips show full text for truncated values
- Copy confirmation is visible but brief

---

### Phase 5: Polish & Edge Cases

**Goal:** Handle edge cases and refine animations.

**Deliverables:**
1. Handle missing/partial data gracefully
2. Loading skeleton for streaming tool results
3. Group consecutive tool calls visually (subtle)
4. Keyboard navigation (Enter/Space to expand)
5. `prefers-reduced-motion` support

**Edge cases:**
- Tool use without result yet (streaming)
- Result without matching tool use
- Very long file paths
- Very long command outputs
- Empty results
- Binary file indicators

**Acceptance criteria:**
- No crashes on malformed data
- Streaming tools show appropriate loading state
- Keyboard accessible
- Respects motion preferences

---

## Component API Reference

### ToolCall

```typescript
interface ToolCallProps {
  /** The tool_use block from the message */
  tool?: ToolUseBlock;
  /** The tool_result block, if available */
  result?: ToolResultBlock;
  /** Whether this tool is currently streaming */
  isStreaming?: boolean;
  /** Initial expanded state (default: false) */
  defaultExpanded?: boolean;
}
```

### Usage

```tsx
// Tool with result
<ToolCall tool={toolUseBlock} result={toolResultBlock} />

// Streaming tool (no result yet)
<ToolCall tool={toolUseBlock} isStreaming={true} />

// Orphan result (rare)
<ToolCall result={toolResultBlock} />
```

---

## Utility Functions

### Status Derivation

```typescript
type ToolStatus = 'running' | 'complete' | 'error';

function getToolStatus(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  isStreaming?: boolean
): ToolStatus {
  if (isStreaming && !result) return 'running';
  if (result?.is_error) return 'error';
  if (result) return 'complete';
  return 'running';
}
```

### Result Parsing Helpers

```typescript
function parseGlobCount(result?: ToolResultBlock): number | null {
  if (!result) return null;
  const content = typeof result.content === 'string'
    ? result.content
    : '';
  // Parse from result format - adjust based on actual output
  const match = content.match(/Found (\d+) files/);
  return match ? parseInt(match[1], 10) : null;
}

function parseGrepCount(result?: ToolResultBlock): number | null {
  // Similar parsing logic
}

function parseBashExitCode(result?: ToolResultBlock): number | null {
  // Parse exit code from result
}
```

---

## File Structure

```
src/
├── components/
│   ├── tool-call/
│   │   ├── index.tsx           # Main ToolCall component
│   │   ├── tool-call.tsx       # Component implementation
│   │   ├── tool-summary.ts     # getToolSummary function
│   │   ├── tool-status.ts      # getToolStatus function
│   │   ├── tool-details.tsx    # Expanded details container
│   │   └── details/            # Tool-specific detail components
│   │       ├── read-details.tsx
│   │       ├── write-details.tsx
│   │       ├── edit-details.tsx
│   │       ├── bash-details.tsx
│   │       ├── search-details.tsx
│   │       ├── task-details.tsx
│   │       └── web-details.tsx
│   └── ...
└── lib/
    └── content-blocks.ts       # Shared content block utilities
```

---

## Don'ts

To keep the design minimal, explicitly avoid:

- ❌ Icons next to tool names
- ❌ Colored backgrounds or borders on collapsed state
- ❌ Different color themes per tool category
- ❌ Loud error states (red backgrounds, warning icons)
- ❌ Always-visible expand buttons
- ❌ Card-like containers around individual tools
- ❌ Timestamps on tool calls
- ❌ Tool IDs visible to users

---

## Summary

The tool call UI should feel like reading a quiet log - informative but unobtrusive. The status dot is the only color. Text is muted. Details are hidden until requested. Errors are noted but not alarming. The user's focus should remain on the conversation, with tool calls providing context on demand.
