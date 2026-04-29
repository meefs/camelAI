# Set Preview Clickable Link Plan

## Problem

When the agent calls `set_file_preview` or `set_app_preview` (the two MCP tools used to drive the chat preview panel), the tool call renders as a generic MCP row in the message stream:

```
● Called set file preview on Chiridion-mcp                                  ▸
```

There is no clickable affordance to re-open whatever was previewed. Other path-bearing tool calls (`Read`, `Edit`, `Write`, `CodexImageView`, etc.) render their target as a `FileLink` button that calls `useChatPreviewContext().openPreviewTarget(...)` and snaps the panel back to that file. Set-preview should behave the same way: scrolling back through a long thread, the user should be able to click any prior `set_file_preview` / `set_app_preview` row and have the preview panel re-open exactly what the agent originally showed.

The MCP tools live in `workers/main/src/mcp-handler.ts:528-642`. There are two of them:

- **`set_file_preview`** — input `{ path, content_type? }`, where `path` is a workspace path (`src/app.tsx`, `/home/claude/README.md`) or a temp path (`/mnt/user-uploads/...`, `/mnt/user-outputs/...`).
- **`set_app_preview`** — input `{ script_name }`. The result body contains `app.is_public` which we need to construct a complete `PreviewTarget`.

### What "preview" means here

The chat preview panel renders via an `<iframe>` — so under the hood every preview is a URL. There are two kinds:

- **App preview.** `set_app_preview` accepts a `script_name`. `Chat.tsx:4141-4163` resolves it to `https://{appLabel}.{iframeDomain}` (with org-slug prefix if present) and points the iframe at that URL. Apps are URLs — they're just URLs whose host is computed from the workspace's deployed worker, not provided directly by the agent.
- **File preview.** `set_file_preview` accepts a workspace or temp path. The iframe loads `/api/workspaces/{id}/fs/content/{path}` (or `uploads/...` / `outputs/...`).

Both kinds are first-class on `PreviewTarget` (`src/types.ts:24-37`) and both already work end-to-end through `openPreviewTarget`. The only thing we are **not** adding is a third kind for arbitrary external URLs (`https://example.com`); the MCP surface today doesn't expose that, so it's out of scope for this plan.

---

## Design

Render set-preview tool calls with the same shape as `Read` / `Edit`: status dot + action verb + clickable target, collapsed by default. Clicking the target calls `previewContext.openPreviewTarget(...)` so the preview panel opens that file or app in a new (or refreshed) tab — the existing tab/sync machinery handles persistence and WebSocket broadcast.

### Collapsed state (file)

```
● Previewed README.md                                                       ▸
        └── clickable; opens file in preview panel
```

### Collapsed state (app)

```
● Previewed app my-todo-app                                                 ▸
        └── clickable; opens app in preview panel
```

### Streaming / error states (mirrors Read/Edit conventions)

```
● Opening preview…                          ← running, no path/script yet
● Opening preview README.md                 ← running, path/script known
● Failed to preview README.md               ← error
```

### Why two presentations

`set_file_preview` already targets a path, so we can reuse the existing `FileLink` component as-is — it already opens any workspace, upload, or output path in the preview panel via `openPreviewTarget`, and it already normalizes `/home/claude/`, `/workspace/`, `/root/`, `/mnt/user-uploads/`, `/mnt/user-outputs/` correctly (see `src/components/tool-call/file-link.tsx:12-45`). Zero new wiring needed for files — we just need to tell `tool-summary.ts` to surface the path.

`set_app_preview` does **not** have a path; it has a `scriptName` plus an `isPublic` boolean. We need a small new `AppLink` component that produces a `PreviewTarget` of `kind: 'app'` and calls `openPreviewTarget` the same way `FileLink` does. Symmetric, ~30 lines.

### ASCII: data flow when the user clicks the link

```
        Tool call row (rendered from a past message)
                    │
                    │  click on FileLink / AppLink
                    ▼
       previewContext.openPreviewTarget(target)
                    │
                    ▼
   Chat.tsx setPreviewTargetForThread(target)
                    │
                    ├──► add/update PreviewTab (getPreviewTabId)
                    ├──► setActiveTabId
                    ├──► setMobileView('preview')
                    └──► syncPreviewTabsStateBestEffort  ──► WS to ChatThreadDO
                                                              │
                                                              └─► broadcastPreviewState()
                                                                    fans out to all tabs
```

Nothing in this flow is new — the file path and the app target both already work through `openPreviewTarget`. We are only adding the "where the click originates" piece.

---

---

## Visual / styling spec (READ BEFORE WRITING ANY JSX)

The clickable link must look **identical** to the existing `Read` / `Edit` rows. Do not invent new colors, sizes, weights, spacing, or hover effects. Match the existing pattern exactly.

### Anatomy of a tool-call row (existing — see `tool-call.tsx:118-150`)

```
●   Read README.md                                                          ▸
│      │      └── filename — clickable, slightly brighter than the action verb,
│      │           underlines on hover, opens preview panel on click
│      └── action verb — muted text, NOT clickable, NO underline, no hover effect
└── status dot (blue=running, green=complete, red=error)
```

The new set-preview rows look exactly the same. Only the **filename / app name** is clickable. The action verb ("Previewed", "Previewed app", "Opening preview…") is plain text in the same muted color as the rest of the row.

```
●   Previewed README.md                                                     ▸
                  │
                  └── clickable; on hover gets an underline + slight color brighten

●   Previewed app my-todo-app                                               ▸
                       │
                       └── clickable; same hover treatment
```

### Exact classes to use

These classes already live on `FileLink` (`src/components/tool-call/file-link.tsx:99-123`) and the surrounding row (`tool-call.tsx:124-128`). Copy them verbatim into `AppLink`. Do not substitute equivalents.

**Row container** (already correct in `tool-call.tsx:124-128`, no change):
```
text-sm text-muted-foreground            ← whole row text color
```

**Action verb wrapper** (`ToolCallSummary` in `tool-call.tsx:75-82`, no change — it's just a `<span>`):
```
tool-call__text min-w-0 flex-1 truncate  ← inherits text-muted-foreground from parent
```
The action verb ("Previewed", "Previewed app", etc.) sits as plain text inside this span. **No button, no underline, no color shift.**

**Clickable link button** (must be identical on `FileLink` and `AppLink`):
```
inline-flex min-w-0 max-w-full items-center gap-1 hover:underline
text-foreground/80 hover:text-foreground
```
Plus the per-call `className="inline-flex max-w-full min-w-0"` passed by `ToolCallSummary`.

Breakdown of what those classes do — the implementer must understand this so they don't "improve" it:

| Class | Effect |
|---|---|
| `text-foreground/80` | Filename color: full foreground at 80% opacity. **Slightly brighter** than the surrounding `text-muted-foreground` action verb, which is the visual cue that this token is interactive. |
| `hover:text-foreground` | On hover, the filename brightens to 100% foreground. Subtle. |
| `hover:underline` | On hover, an underline appears under the filename. **Underline is hover-only — never visible at rest.** |
| `inline-flex items-center gap-1` | Lays the link out inline so it sits flush in the sentence. |
| `min-w-0 max-w-full` | Allows the inner `<span class="truncate">` to ellipsize when the row is narrow. |

**Inner text span** (passed as `children` from `ToolCallSummary`):
```
<span className="truncate">{filename}</span>
```
This must wrap the visible text so long filenames / script names get an ellipsis instead of overflowing.

### What NOT to do (common implementer mistakes)

- ❌ Do not put the action verb inside the button. The verb is muted-foreground plain text; only the name is the link.
- ❌ Do not add `underline` (always-on). Use `hover:underline` only.
- ❌ Do not use `text-primary`, `text-blue-500`, `text-link`, or any "link blue" color. The existing FileLink is **monochrome** — `text-foreground/80` → `text-foreground`. Match it.
- ❌ Do not add an external-link icon (`ExternalLink` / `↗`) to the AppLink. `FileLink` only renders an icon when `showIcon` is true, and `ToolCallSummary` does not pass that prop. AppLink should match — name only.
- ❌ Do not bold, italicize, or change the font of the link. It inherits `text-sm` from the row and stays the default font weight.
- ❌ Do not add padding, margin, background color, or border to the button. It is a bare inline button styled only with the classes above.
- ❌ Do not change spacing between the action verb and the filename. Keep the existing `{parts.action}{' '}<Link>...</Link>` pattern from `tool-call.tsx:75-82` — a single literal space between them.

### Reference: side-by-side comparison

Before (today, with no special-case):
```
●   Called set file preview on Chiridion-mcp                                ▸
       └── all muted, all plain text, nothing clickable
```

After (this plan):
```
●   Previewed README.md                                                     ▸
       │         │
       │         └── text-foreground/80, hover: text-foreground + underline
       └── text-muted-foreground (inherited from row)

●   Previewed app my-todo-app                                               ▸
       │             │
       │             └── text-foreground/80, hover: text-foreground + underline
       └── text-muted-foreground (inherited from row)
```

Identical to:
```
●   Read README.md                                                          ▸
●   Edited app.tsx                                                          ▸
●   Created plot.png                                                        ▸
```

If the rendered set-preview row looks visually different from a `Read` row, the styling is wrong.

---

## Files to change

| File | Change |
|---|---|
| `src/components/tool-call/mcp-utils.ts` | Add a small helper to detect set-preview MCP tools regardless of MCP server-name prefix (mirrors the `isAskUserQuestionToolName` pattern at line 31). |
| `src/components/tool-call/tool-summary.ts` | (a) Short-circuit set-preview tools **before** the generic MCP block at line 74 so they don't render as "Called set file preview on Chiridion-mcp". (b) Extend `ToolSummaryParts` with an optional `appPreview?: { scriptName: string; isPublic: boolean }` discriminator for the app case (file case reuses `path` + `filename`). |
| `src/components/tool-call/app-link.tsx` | **New file.** Small button component analogous to `FileLink` that opens a `kind: 'app'` PreviewTarget. |
| `src/components/tool-call/tool-call.tsx` | In `ToolCallSummary` (line 42), branch on `parts.appPreview` and render `<AppLink>` instead of `<FileLink>` when present. |
| `docs/set-preview-clickable-link-plan.md` | This file. |

No changes to: `Chat.tsx`, the MCP handler, the preview panel itself, the WebSocket protocol, the `PreviewTarget` type, or `PreviewTab`.

---

## Implementation steps

### Step 1 — Add MCP-tool-name detection helper

In `src/components/tool-call/mcp-utils.ts`, add (right after `isAskUserQuestionToolName`):

```ts
const SET_FILE_PREVIEW_TOOL = 'set_file_preview';
const SET_APP_PREVIEW_TOOL = 'set_app_preview';

export function isSetFilePreviewToolName(name?: string): boolean {
  if (!name) return false;
  if (name === SET_FILE_PREVIEW_TOOL) return true;
  return parseMcpToolName(name)?.toolName === SET_FILE_PREVIEW_TOOL;
}

export function isSetAppPreviewToolName(name?: string): boolean {
  if (!name) return false;
  if (name === SET_APP_PREVIEW_TOOL) return true;
  return parseMcpToolName(name)?.toolName === SET_APP_PREVIEW_TOOL;
}
```

Why both forms: we don't know with certainty whether the harness will ever expose these without the `mcp__chiridion-mcp__` prefix (the same defensive pattern is used for `ask_user_question` at `mcp-utils.ts:31`). Cost is negligible.

### Step 2 — Extend `ToolSummaryParts`

In `src/components/tool-call/tool-summary.ts:31`, add an optional discriminator:

```ts
export interface ToolSummaryParts {
  action: string;
  filename?: string;
  path?: string;
  /** When set, summary should render an app-preview link instead of a FileLink. */
  appPreview?: { scriptName: string; isPublic: boolean };
}
```

### Step 3 — Add set-preview cases ahead of the MCP fallback

In `src/components/tool-call/tool-summary.ts`, **insert before** the existing `if (isMcpTool(name)) { ... }` block at line 74:

```ts
import { isSetAppPreviewToolName, isSetFilePreviewToolName } from './mcp-utils';
// (add to the existing import on line 2)

// File preview — reuse the existing FileLink path/filename plumbing.
if (isSetFilePreviewToolName(name)) {
  const path = typeof inputRecord.path === 'string' ? inputRecord.path : '';
  if (isRunning) {
    if (!path) return { action: 'Opening preview...' };
    return { action: 'Opening preview', filename: getFilename(path), path };
  }
  if (isError) {
    return {
      action: 'Failed to preview',
      filename: path ? getFilename(path) : undefined,
      path: path || undefined,
    };
  }
  return {
    action: 'Previewed',
    filename: path ? getFilename(path) : undefined,
    path: path || undefined,
  };
}

// App preview — needs scriptName + isPublic to build a PreviewTarget.
if (isSetAppPreviewToolName(name)) {
  const scriptName = typeof inputRecord.script_name === 'string' ? inputRecord.script_name : '';
  const isPublic = parseAppPreviewIsPublic(result);
  if (isRunning) {
    if (!scriptName) return { action: 'Opening preview...' };
    return { action: 'Opening preview app', filename: scriptName };
  }
  if (isError) {
    return {
      action: 'Failed to preview app',
      filename: scriptName || undefined,
    };
  }
  // Only attach the clickable appPreview once we can build a complete target.
  if (scriptName && isPublic !== null) {
    return {
      action: 'Previewed app',
      filename: scriptName,
      appPreview: { scriptName, isPublic },
    };
  }
  return {
    action: 'Previewed app',
    filename: scriptName || undefined,
  };
}
```

Add the `parseAppPreviewIsPublic` helper near the top of the file (next to `parseCountFromResult` at line 23):

```ts
function parseAppPreviewIsPublic(result?: ToolResultBlock): boolean | null {
  if (!result) return null;
  const text = getResultText(result);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { app?: { is_public?: unknown } };
    if (parsed?.app && typeof parsed.app.is_public === 'boolean') {
      return parsed.app.is_public;
    }
  } catch {
    // result not JSON, fall through
  }
  return null;
}
```

This works because `set_app_preview`'s success response is the JSON-serialized object built at `workers/main/src/mcp-handler.ts:631-640` (`{ success, target, app: { name, url, is_public }, message }`), wrapped by `textResponse`.

If `isPublic` can't be determined (parse failure, error result, still streaming), the row renders the script name as plain text — degraded gracefully but not clickable. We don't fabricate a target with a wrong `isPublic` because that controls which deployed-app URL the iframe resolves to.

### Step 4 — Create `AppLink` component

**New file:** `src/components/tool-call/app-link.tsx`

The classes below are copied verbatim from `FileLink` (`file-link.tsx:99-123`). **Do not change them.** See the "Visual / styling spec" section above for the rationale on each class — the implementer must match the existing FileLink rendering pixel-for-pixel.

```tsx
"use client";

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import type { PreviewTarget } from '@/types';

interface AppLinkProps {
  scriptName: string;
  isPublic: boolean;
  children?: ReactNode;
  className?: string;
}

export function AppLink({ scriptName, isPublic, children, className }: AppLinkProps) {
  const previewContext = useChatPreviewContext();

  // Fallback when there's no preview context (e.g., admin thread viewer):
  // render as plain text in the same color as the surrounding muted row.
  // Do NOT add hover underline / brighter color here — non-clickable text
  // should not look interactive.
  if (!previewContext) {
    return (
      <span className={cn('inline-flex min-w-0 max-w-full', className)}>
        {children ?? scriptName}
      </span>
    );
  }

  const target: PreviewTarget = { kind: 'app', scriptName, isPublic };

  return (
    <button
      type="button"
      className={cn(
        // Layout — keeps the link inline and ellipsis-safe inside the row.
        'inline-flex min-w-0 max-w-full items-center gap-1',
        // Hover affordance — underline ONLY on hover, never at rest.
        'hover:underline',
        // Color — slightly brighter than the muted row text at rest;
        // brightens to full foreground on hover. Monochrome — do NOT
        // swap in text-primary / text-blue-* / text-link.
        'text-foreground/80 hover:text-foreground',
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        previewContext.openPreviewTarget(target);
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
    >
      {children ?? scriptName}
    </button>
  );
}
```

Notes:
- Mirrors `FileLink`'s event-stop handling (`onMouseDown` / `onPointerDown` / `onKeyDown`) so a click on the link doesn't also toggle the parent `Collapsible` — this is the same pattern as `file-link.tsx:108-118`.
- No fallback `<a href>` is needed: there is no out-of-band route for "open app preview." If the preview context is missing (e.g., the row is rendered outside `ChatPreviewProvider`), we degrade to plain text.
- **No icon.** `FileLink` only shows an `ExternalLink` icon when its caller passes `showIcon={true}`, and `ToolCallSummary` does not. `AppLink` matches — name only, no trailing icon.

### Step 5 — Wire `AppLink` into `ToolCallSummary`

In `src/components/tool-call/tool-call.tsx`, modify `ToolCallSummary` (lines 42-83) to branch on `parts.appPreview`. The new branch must be **structurally identical** to the existing `FileLink` branch at lines 75-82 — same outer span, same `{parts.action}{' '}` prefix, same `<span class="truncate">` wrapping the name. Only the link component itself changes.

```tsx
import { AppLink } from './app-link';
// (add to existing imports)

// inside ToolCallSummary, place this branch BETWEEN the early-return guards
// (lines 58-73) and the existing FileLink branch (lines 75-82):

if (parts.appPreview && parts.filename) {
  return (
    <span className="tool-call__text min-w-0 flex-1 truncate">
      {parts.action}{' '}
      <AppLink
        scriptName={parts.appPreview.scriptName}
        isPublic={parts.appPreview.isPublic}
        className="inline-flex max-w-full min-w-0"
      >
        <span className="truncate">{parts.filename}</span>
      </AppLink>
    </span>
  );
}

// existing FileLink branch unchanged — keep as-is
```

Visual contract (verify after wiring):

- Action verb ("Previewed app") renders in the inherited `text-muted-foreground` from the row.
- A single literal space sits between the verb and the link — `{parts.action}{' '}`. No `&nbsp;`, no margin, no padding.
- The script name renders inside `<span class="truncate">` so it ellipsizes on narrow rows.
- `parts.path` is **not** set for the app case, so the existing `FileLink` branch at the bottom of the function is never reached — no extra guard needed.

### Step 6 — Smoke tests

The features here are 100% UI-side; no Worker/DO behavior changes. No new persistence semantics. Recommended verification:

1. `bun run typecheck` — confirms the `ToolSummaryParts` change compiles cleanly across all consumers (currently `tool-call.tsx` and `tool-summary.ts` themselves).
2. `bun run test:run -- tool-summary` — if a vitest exists for `tool-summary.ts`, extend it with two cases: file preview returns `{ action: 'Previewed', path, filename }`, app preview with a parseable result returns `{ action: 'Previewed app', filename, appPreview }`. Don't add a brand-new test file just for this — only extend existing coverage.
3. Manual: trigger a `set_file_preview` and a `set_app_preview` from the agent in dev (`bun run dev`), confirm the row shows "Previewed <name>" with the link styled like Read/Edit, click it from a scrolled-up position, confirm the preview panel opens / refocuses the right tab.
4. Manual: test running state (open dev tools, throttle the WS, confirm "Opening preview…" appears briefly).

---

## Edge cases & gotchas

1. **MCP server name uncertainty.** The MCP server is registered as `name: 'chiridion-mcp'` (`mcp-handler.ts:93`). The Claude SDK / Codex harnesses surface MCP tools as `mcp__<server>__<tool>`, but server-name slugging across runtimes isn't guaranteed identical. The detection helpers in Step 1 use `parseMcpToolName(name)?.toolName === ...` so they work no matter how the server name renders. Don't hardcode the full tool name.

2. **App previews are URL-backed, but routed through `kind: 'app'`.** Apps load in the iframe via a computed URL (`https://{appLabel}.{iframeDomain}` — see `Chat.tsx:4141-4163`), but the agent supplies `script_name`, not the URL. Always construct `PreviewTarget = { kind: 'app', scriptName, isPublic }` — never try to fabricate a `kind: 'url'` target (that variant doesn't exist). Arbitrary external URLs (e.g. `https://news.ycombinator.com`) are not previewable today and are out of scope for this plan.

3. **Path normalization is already handled by `FileLink`.** `set_file_preview` accepts paths like `/home/claude/README.md`, `src/app.tsx`, `/mnt/user-uploads/notebook.ipynb`. `FileLink`'s `normalizeWorkspacePath` and `getTempFileInfo` already cover all four shapes (`file-link.tsx:12-45`). Do not duplicate normalization in `tool-summary.ts` — pass the raw path through as `path` and let `FileLink` do its job. Display only `getFilename(path)` (basename) in the summary.

4. **`isPublic` for apps must come from the result, not be guessed.** The active preview URL the iframe loads depends on whether the deployed app is public — the wrong value yields a 404 or auth wall. If the result body is missing or unparseable (offline thread replay, redacted history), render the script name as plain text instead of fabricating a clickable link with `isPublic: false`. The `parseAppPreviewIsPublic` helper returns `null` to signal this.

5. **Don't duplicate the row.** `set_file_preview` and `set_app_preview` always trigger a `preview_state` WebSocket broadcast, which already updates the panel for the live user. The new clickable link is a **historical / replay** affordance — it lets the user re-open old previews. Don't add any auto-scroll or auto-focus behavior; clicking already calls `openPreviewTarget`, which sets `mobileView = 'preview'` (`Chat.tsx:3989-3992`) — that's enough.

6. **Click event propagation.** The parent `CollapsibleTrigger` in `tool-call.tsx:120` toggles expand/collapse on click. Both `FileLink` and the new `AppLink` must call `event.stopPropagation()` on `onClick` / `onMouseDown` / `onPointerDown` / `onKeyDown` so clicking the link doesn't also toggle the row open/closed. The existing `FileLink` pattern (lines 108-118) is the canonical reference.

7. **Streaming order.** `inputRecord.path` arrives via streaming JSON parsing — early in the stream it may be an empty string. The "Opening preview…" / "Opening preview <name>" branches handle the gradient. Mirror Read/Edit behavior: don't render `FileLink` until both `path` and `filename` exist (already enforced by `ToolCallSummary` line 58).

---

## Out of scope

- Adding URL-preview support to `PreviewTarget` / the MCP surface.
- Custom `ToolCallDetails` content for set-preview (the default JSON-dump details panel is fine; users open the link, not the details).
- Server-side changes to the MCP handler — the result already contains everything we need.
- Changes to `PreviewTab` ID generation, broadcast protocol, or persistence.
