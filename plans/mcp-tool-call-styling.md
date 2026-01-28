# Plan: Improve MCP Tool Call Styling

## Problem

MCP tool calls currently fall through to the `default` case in `tool-summary.ts` and `tool-details.tsx`, rendering the raw tool name (e.g. `mcp__chiridion__list_apps`) with no human-readable label, no active/completed verb states, and generic JSON input/output details.

## Current Behavior

```
 ● mcp__chiridion__list_apps                    >
```

Expanded shows `GenericDetails` with raw JSON "Input" / "Output" blocks.

## Desired Behavior

### Summary Line

```
ACTIVE (running):
 ◉ Calling list apps on Chiridion...            >

COMPLETED:
 ● Called list apps on Chiridion                 >
```

Format: `{verb} {humanized tool name} on {humanized server name}`

- **Active verb:** "Calling"
- **Completed verb:** "Called"
- The `mcp__` prefix is stripped
- Server name is title-cased (e.g. `chiridion` → `Chiridion`)
- Tool name underscores replaced with spaces (e.g. `list_apps` → `list apps`)
- Active state appends `...`
- CSS `truncate` on the outer span handles overflow naturally — the tool name comes first so it stays visible; server name gets clipped if needed

### ASCII Mockup — Collapsed

```
┌─────────────────────────────────────────────────────┐
│ ◉  Calling list apps on Chiridion...            ▸   │  ← running
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ ●  Called list apps on Chiridion                 ▸   │  ← complete
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ ●  Called list apps on Chiridion                 ▸   │  ← error (dot red)
└─────────────────────────────────────────────────────┘
```

### ASCII Mockup — Expanded

```
┌─────────────────────────────────────────────────────┐
│ ●  Called list apps on Chiridion                 ▾   │
│                                                      │
│ ┊  MCP Server   Chiridion                            │
│ ┊                                                    │
│ ┊  Input                                             │
│ ┊  ┌──────────────────────────────────────────┐      │
│ ┊  │ {}                                       │ 📋   │
│ ┊  └──────────────────────────────────────────┘      │
│ ┊                                                    │
│ ┊  Output                                            │
│ ┊  ┌──────────────────────────────────────────┐      │
│ ┊  │ { "count": 1, "apps": [ ... ] }          │ 📋   │
│ ┊  └──────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────┘
```

The expanded view is essentially the same as `GenericDetails` today but with a small "Server" label row at top showing the humanized server name. This gives extra context without requiring a redesign of the details panel.

## Implementation

### 1. Add MCP name parser utility

**File:** `src/components/tool-call/mcp-utils.ts` (new file)

```ts
const MCP_PREFIX = 'mcp__';

export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

export interface McpToolParts {
  serverName: string;       // raw, e.g. "chiridion"
  toolName: string;         // raw, e.g. "list_apps"
  displayServer: string;    // title-cased, e.g. "Chiridion"
  displayTool: string;      // humanized, e.g. "list apps"
}

export function parseMcpToolName(name: string): McpToolParts | null {
  if (!isMcpTool(name)) return null;
  const withoutPrefix = name.slice(MCP_PREFIX.length);
  const separatorIdx = withoutPrefix.indexOf('__');
  if (separatorIdx === -1) return null;
  const serverName = withoutPrefix.slice(0, separatorIdx);
  const toolName = withoutPrefix.slice(separatorIdx + 2);
  return {
    serverName,
    toolName,
    displayServer: titleCase(serverName),
    displayTool: toolName.replace(/_/g, ' '),
  };
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

### 2. Update `tool-summary.ts`

In `getToolSummaryParts`, add a check **before** the `default` case (or at the top of the function, before the switch):

```ts
import { isMcpTool, parseMcpToolName } from './mcp-utils';

// Add at top of function, before the switch:
if (isMcpTool(name)) {
  const parts = parseMcpToolName(name);
  if (parts) {
    if (isStreaming && !result) {
      return { action: `Calling ${parts.displayTool} on ${parts.displayServer}...` };
    }
    return { action: `Called ${parts.displayTool} on ${parts.displayServer}` };
  }
}
```

**Verb states:**

| State | Text |
|-------|------|
| Running (streaming, no result) | `Calling {tool} on {Server}...` |
| Completed | `Called {tool} on {Server}` |
| Error | `Called {tool} on {Server}` (red dot handles error indication) |

### 3. Add MCP details component

**File:** `src/components/tool-call/details/mcp-details.tsx` (new file)

This is a thin wrapper around the existing `GenericDetails` that adds a server name label row.

```tsx
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { parseMcpToolName } from '../mcp-utils';
import { GenericDetails } from './generic-details';
import { DetailRow } from './shared';

interface McpDetailsProps {
  tool: ToolUseBlock;
  result?: ToolResultBlock;
}

export function McpDetails({ tool, result }: McpDetailsProps) {
  const parts = parseMcpToolName(tool.name);

  return (
    <div className="space-y-1">
      {parts && <DetailRow label="Server:" value={parts.displayServer} />}
      <GenericDetails tool={tool} result={result} />
    </div>
  );
}
```

### 4. Update `tool-details.tsx`

Add a case for MCP tools in the switch. Since MCP tools are dynamic names, add a check before the switch:

```ts
import { isMcpTool } from './mcp-utils';
import { McpDetails } from './details/mcp-details';

// Before the switch statement:
if (tool && isMcpTool(tool.name)) {
  content = <McpDetails tool={tool} result={result} />;
} else {
  switch (name) {
    // ... existing cases
  }
}
```

### 5. Verify `DetailRow` exists in shared.tsx

The exploration found `shared.tsx` exports `OutputBlock`. Verify `DetailRow` is exported too (it was referenced in `GenericDetails`). If it doesn't exist, add a simple one:

```tsx
export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs text-muted-foreground/80">
      <span className="font-medium shrink-0">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}
```

### 6. Make copy buttons visible on hover over expanded details (all tools)

Currently, copy buttons inside expanded tool details are only visible when hovering directly over their immediate row/label. This makes them hard to discover. Change them to appear when hovering anywhere over the expanded details area.

**Approach:** Add a `group/details` class to the details container in `tool-call.tsx`, then update all copy button hover classes to use `group-hover/details:opacity-100`.

#### 6a. `src/components/tool-call/tool-call.tsx`

Add `group/details` to the `CollapsibleContent` wrapper (currently line 131):

```diff
 <CollapsibleContent
   className={cn(
+    "group/details",
     "overflow-hidden data-[state=open]:animate-collapsible-down ...",
   )}
 >
```

#### 6b. `src/components/tool-call/details/shared.tsx` — `CopyButton` default

Line 59: Change the default `hoverClassName` from `group-hover/row:opacity-100` to `group-hover/details:opacity-100`:

```diff
- hoverClassName ?? "group-hover/row:opacity-100",
+ hoverClassName ?? "group-hover/details:opacity-100",
```

#### 6c. `src/components/tool-call/details/shared.tsx` — `DetailRow`

Line 139: Change the `CopyButton` `hoverClassName` prop:

```diff
- <CopyButton value={copyValue} hoverClassName="group-hover/row:opacity-100" />
+ <CopyButton value={copyValue} hoverClassName="group-hover/details:opacity-100" />
```

#### 6d. `src/components/tool-call/details/shared.tsx` — `OutputBlock`

Line 163: Change the `CopyButton` `hoverClassName` prop:

```diff
- hoverClassName="group-hover/output:opacity-100"
+ hoverClassName="group-hover/details:opacity-100"
```

#### 6e. `src/components/tool-call/details/search-details.tsx`

Line 81: Change the `CopyButton` `hoverClassName` prop:

```diff
- hoverClassName="group-hover/filelist:opacity-100"
+ hoverClassName="group-hover/details:opacity-100"
```

**Not changed (intentionally):**
- `thinking-block.tsx` chevron — this is a toggle icon, not a copy button
- `tool-call.tsx` chevron — this is the expand/collapse affordance on the collapsed row

## Files to Change

| File | Change |
|------|--------|
| `src/components/tool-call/mcp-utils.ts` | **New** — MCP name parser |
| `src/components/tool-call/tool-summary.ts` | Add MCP branch before switch |
| `src/components/tool-call/details/mcp-details.tsx` | **New** — MCP detail component |
| `src/components/tool-call/tool-details.tsx` | Route MCP tools to `McpDetails` |
| `src/components/tool-call/details/shared.tsx` | Verify/add `DetailRow` if missing; update 3 copy button hover classes to `group-hover/details` |
| `src/components/tool-call/tool-call.tsx` | Add `group/details` class to `CollapsibleContent` |
| `src/components/tool-call/details/search-details.tsx` | Update copy button hover class to `group-hover/details` |

## Acceptance Criteria

- `mcp__chiridion__list_apps` displays as `Calling list apps on Chiridion...` while running
- `mcp__chiridion__list_apps` displays as `Called list apps on Chiridion` when complete
- Error state shows same text as complete but with red status dot
- Expanded details show "MCP Server: Chiridion" label above the existing Input/Output blocks
- All non-MCP tools remain unchanged
- No new shadcn components needed (uses existing `Collapsible`, `DetailRow`, `OutputBlock`)
- All copy buttons in expanded tool details are visible when hovering anywhere over the expanded content area (not just their immediate row)
