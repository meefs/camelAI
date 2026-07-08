# Add "Project:" Row To Expanded Tool Calls

## Goal

Every workspace now contains multiple projects, and most agent tools take a `project` input naming the project they act on. When a tool call carries a project name, the expanded tool call state must surface it as a lowkey metadata row, styled exactly like the existing `Path:` row:

```text
Project: menu-app
```

This is a **frontend-only change**. The project name already arrives in the UI on `tool.input.project` (it is already consumed for file preview links and clipboard formatting); nothing in `workers/` or the tool schemas changes.

## Current State

- The expanded tool call state is rendered by `ToolCallDetails` in `src/components/tool-call/tool-details.tsx` (switch at lines 62-127), which dispatches per tool name to components in `src/components/tool-call/details/`.
- The `Path:` row the user referenced is the shared `DetailRow` component in `src/components/tool-call/details/shared.tsx:93-169`:
  - Row: `flex items-start gap-2 group/row py-0.5`
  - Label: `<span className="shrink-0 text-muted-foreground/60">{label}</span>`
  - Value: truncated span (mono optional) with a hover tooltip past 48 chars
  - Optional hover-reveal `CopyButton` on the right
  - Returns `null` when `value` is empty — rows self-hide.
- `label="Path:"` call sites today: `read-details.tsx:34`, `write-details.tsx:34`, `edit-details.tsx:70`, `search-details.tsx:234`; `notebook-details.tsx:35` uses `label="Notebook:"` for the same shape.
- Every file detail component already destructures `input.project` (for `buildFilePreviewLinkTarget` / `copyTargetFromToolInput`) but never displays it.
- Tools without a dedicated detail component fall through to `GenericDetails` (`generic-details.tsx`), which prints the raw input JSON — the project is technically visible there but buried.

### Which tools carry a project input

Parameter is spelled `project` everywhere it matters. Schemas: `workers/main/src/pi-container-tools.ts:33-46` (file tools) and `workers/main/src/code-mode-tools.ts` (everything else).

| Tool (chat name) | `project` | Renders via |
|---|---|---|
| `read` | required for `location: 'project' \| 'vm'` | `ReadDetails` |
| `write` | same | `WriteDetails` |
| `edit` | same | `EditDetails` |
| `grep`, `glob` | same | `SearchDetails` |
| `bash` | **required** | `BashDetails` |
| `NotebookEdit` | optional | `NotebookDetails` |
| `ls`, `find`, `delete` | required for `location: 'project' \| 'vm'` | `GenericDetails` (no switch case) |
| `scaffold_project`, `set_project_description`, `delete_project` | **required** | `GenericDetails` |
| `set_preview` | optional | `GenericDetails` |
| `list_apps` | optional (filter) | `GenericDetails` |
| `mcp__*__set_preview`, `mcp__*__set_file_preview` (internal MCP variants, Codex threads) | optional | `McpDetails` |
| js_exec-only today but may appear in historical transcripts: `deploy_project`, `build_project`, `add_dependency`, `add_shadcn_component`, `revert_project`, `list_commits`, `run_notebook`, `analysis_exec`, `add_python_dependency`, `vm_exec` | required/optional | `GenericDetails` |

Because `GenericDetails` is the fallback for every unknown tool, giving it a project row makes the feature cover the whole long tail (including future tools) with one change.

## Design

No new shadcn primitives are needed. The entire change reuses the existing `DetailRow` (which composes shadcn `Button` + `Tooltip` internally). Do not introduce badges, icons, links, or chips — the row must read as quiet metadata, identical in weight to `Path:`.

### Expanded states, before → after

```text
Read (expanded)                              Bash (expanded)
─────────────────────────────────────        ─────────────────────────────────────
● Read index.html                   ⌄        ● Ran build the app                 ⌄
│ Path:    /src/index.html          ⧉        │ Command:     bun run build        ⧉
│ Project: menu-app                 ⧉  NEW   │ Project:     menu-app             ⧉  NEW
│ Lines:   120                               │ Description: Build the app
│ Preview                                    │ Exit code:   0
│ ┌───────────────────────────────┐          │ Stdout
│ │ <!doctype html>…              │          │ ┌───────────────────────────────┐
│ └───────────────────────────────┘          │ │ built in 1.2s                 │
                                             │ └───────────────────────────────┘

Grep (expanded)                              delete_project (GenericDetails fallback)
─────────────────────────────────────        ─────────────────────────────────────
● Found 3 matches                   ⌄        ● Used Delete project               ⌄
│ Pattern: useFetcher               ⧉        │ Project: menu-app                 ⧉  NEW
│ Path:    /src                     ⧉        │ Input                                (project now scannable
│ Project: menu-app                 ⧉  NEW   │ ┌───────────────────────────────┐    without reading JSON)
│ Count:   3                                 │ │ { "project": "menu-app" }     │
│ Matches                                    │ └───────────────────────────────┘
│ …
```

`⧉` = the existing hover-only copy button. `NEW` markers are annotations, not rendered text.

### Row anatomy (identical to the Path row)

```text
┌ flex items-start gap-2 group/row py-0.5 ──────────────────────────────┐
│ Project:      menu-app                                           [⧉]  │
│ └ label:      └ value: font-mono, truncate,                      └ CopyButton,
│   shrink-0      tooltip when > 48 chars                            opacity-0 until
│   text-muted-foreground/60                                         group hover
└────────────────────────────────────────────────────────────────────────┘
```

### Placement rule

The `Project:` row goes **directly after the primary target row** (the thing the tool acted on), before secondary metadata:

- `ReadDetails`: Path → **Project** → Lines
- `WriteDetails`: Path → **Project** → Size
- `EditDetails`: Path → **Project** → Changes
- `SearchDetails`: Pattern → Path → **Project** → Mode → Count
- `NotebookDetails`: Notebook → **Project** → Cell
- `BashDetails`: Command → **Project** → Description → Exit code
- `GenericDetails`: **Project** first, then the Input/Output blocks (everything else there is a JSON block, so the row leads)
- `McpDetails`: MCP Server → **Project** (internal preview tools only, see below) → GenericDetails content

### Display semantics

- Show the **raw project name string the agent passed** (`input.project`, trimmed). Do not slugify it, do not render the `@mention` form, do not resolve it against the project registry. If the agent passed a wrong name, showing what it passed is the honest, debuggable behavior.
- Value renders `mono`, matching the other identifier rows (`Command:`, `Pattern:`, `Cell:`); prose rows like `Description:` stay non-mono.
- Copy button copies the raw project name. Give it the aria-label/tooltip **"Copy project name"** — this also keeps it distinct from the Path row's "Copy" button (see Tests: an existing test queries `button, { name: 'Copy' }` and must keep matching exactly one button).
- Row self-hides when there is no non-empty `input.project` string (via `DetailRow`'s existing empty-value null return). No placeholder, no "Project: —".

### Why per-component rows instead of one central row in `ToolCallDetails`

A single row rendered above the dispatched content would cover everything in one edit, but it would pin the project above `Path:`/`Command:` for every tool and outside each component's `space-y-1` stack. Placement after the primary row reads better and each edit is one line, so the per-component approach costs almost nothing extra.

### MCP false-positive guard

External connection MCP tools could define their own `project` argument meaning something unrelated (e.g. an analytics or GCP project). Therefore the MCP path (`McpDetails`) does **not** show the generic row. It shows the row only for the internal preview tools whose `project` is a workspace project name: `isSetPreviewToolName(...)` / `isSetFilePreviewToolName(...)` from `src/components/tool-call/mcp-utils.ts` (these already match both bare and `mcp__<server>__` forms). Non-MCP tools all come from our own registry, where `project` consistently means the workspace project name, so they need no allowlist.

## Implementation

### 1. Shared helper + row component — `src/components/tool-call/details/shared.tsx`

Add an optional `copyLabel` prop to `DetailRow` and forward it to `CopyButton` (which already takes `label`, default `'Copy'`):

```tsx
interface DetailRowProps {
  // ...existing props...
  copyLabel?: string;
}

// in the JSX:
{formattedCopyValue ? (
  <CopyButton
    value={formattedCopyValue}
    label={copyLabel}
    hoverClassName="group-hover/details:opacity-100"
  />
) : null}
```

Then add the shared extraction helper and row component:

```tsx
export function getToolInputProject(input?: Record<string, unknown>): string {
  if (!input) return '';
  return typeof input.project === 'string' ? input.project.trim() : '';
}

export function ProjectDetailRow({ input }: { input?: Record<string, unknown> }) {
  const project = getToolInputProject(input);
  if (!project) return null;
  return (
    <DetailRow
      label="Project:"
      value={project}
      copyValue={project}
      copyLabel="Copy project name"
      mono
    />
  );
}
```

### 2. File tools — one line each, after the `Path:` row

`src/components/tool-call/details/read-details.tsx` (after the Path `DetailRow`, before `Lines:`):

```tsx
<ProjectDetailRow input={input} />
```

Same one-liner in:

- `write-details.tsx` — after Path, before `Size:`
- `edit-details.tsx` — after Path, before `Changes:`
- `search-details.tsx` — after Path, before `Mode:`
- `notebook-details.tsx` — after `Notebook:`, before `Cell:`

Each file already has an `input` local; import `ProjectDetailRow` from `./shared`.

### 3. Bash — `src/components/tool-call/details/bash-details.tsx`

After the `Command:` row, before `Description:`:

```tsx
<DetailRow label="Command:" value={command} copyValue={command} mono />
<ProjectDetailRow input={input} />
{description ? <DetailRow label="Description:" value={description} /> : null}
```

### 4. Generic fallback — `src/components/tool-call/details/generic-details.tsx`

Add a `showProject` prop (default true) so the MCP wrapper can opt out, and render the row above the Input block:

```tsx
interface GenericDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  showProject?: boolean;
}

export function GenericDetails({ tool, result, showProject = true }: GenericDetailsProps) {
  const inputText = tool?.input ? safeJsonStringify(tool.input) : '';
  const resultText = getResultText(result);

  return (
    <div className="space-y-1">
      {showProject ? <ProjectDetailRow input={tool?.input} /> : null}
      {inputText ? <OutputBlock value={inputText} label="Input" copyValue={inputText} /> : null}
      {resultText ? <OutputBlock value={resultText} label="Output" copyValue={resultText} /> : null}
      {!inputText && !resultText ? <DetailRow label="Details:" value="No additional data" /> : null}
    </div>
  );
}
```

The project remains visible in the Input JSON too; that is fine — the row is the scannable summary, the JSON is the raw record.

### 5. MCP wrapper — `src/components/tool-call/details/mcp-details.tsx`

```tsx
import { isSetFilePreviewToolName, isSetPreviewToolName, parseMcpToolName } from '../mcp-utils';
import { ProjectDetailRow } from './shared';

export function McpDetails({ tool, result }: McpDetailsProps) {
  const parts = parseMcpToolName(tool.name);
  const isInternalPreviewTool =
    isSetPreviewToolName(tool.name) || isSetFilePreviewToolName(tool.name);

  return (
    <div className="space-y-1">
      {parts && <DetailRow label="MCP Server:" value={parts.displayServer} />}
      {isInternalPreviewTool ? <ProjectDetailRow input={tool.input} /> : null}
      <GenericDetails tool={tool} result={result} showProject={false} />
    </div>
  );
}
```

Note the bare-name `set_preview` (Pi passthrough) does not enter `McpDetails` — it falls to `GenericDetails` via the switch default and gets the row from change #4.

### 6. No other components change

`JavaScriptDetails`, `TaskDetails`, `WebDetails`, `TodoDetails`, `SkillDetails`, `AskUserQuestionDetails`, `TeamCreateDetails`, `task-notification.tsx`: their tools have no `project` input — do not add the row. The collapsed summary line (`src/lib/tool-activity-summary.ts`) is explicitly unchanged.

## Tests

New file `tests/tool-detail-project-row.test.tsx`, mirroring the setup in `tests/tool-detail-file-copy.test.tsx` (same `ChatPreviewProvider` wrapper, `makeTool` helper, clipboard mock; keep the `use-auth-data` mock since `ReadDetails` renders `FileLink`).

Cover:

1. `ReadDetails` with `{ location: 'project', project: 'menu-app', path: '/src/index.html' }` → text `Project:` and `menu-app` are rendered.
2. `ReadDetails` with `{ location: 'workspace', path: '/notes.md' }` → `Project:` is absent.
3. `ReadDetails` with `{ location: 'project', project: '   ' }` → `Project:` is absent (whitespace-only guard).
4. `BashDetails` with `{ command: 'bun run build', project: 'menu-app', description: 'Build' }` → row present.
5. `ToolCallDetails` with tool name `delete_project` and input `{ project: 'menu-app' }` → row present (proves the GenericDetails fallback path end to end).
6. `ToolCallDetails` with tool name `mcp__linear__create_issue` and input `{ project: 'external-thing' }` → `Project:` absent (external MCP guard).
7. `ToolCallDetails` with tool name `mcp__camelai__set_file_preview` and input `{ location: 'project', project: 'menu-app', path: 'index.html' }` → exactly one `Project:` row.
8. Copy flow: click `button, { name: 'Copy project name' }` on a `ReadDetails` render → clipboard receives the raw `menu-app` (not the `@slug - path` mention format).

**Existing-test guard:** `tests/tool-detail-file-copy.test.tsx:93` clicks `getByRole('button', { name: 'Copy' })` on a `ReadDetails` render whose input includes a project — that render will now also contain the project row's copy button. Because the new button is labeled `Copy project name` (not `Copy`), the exact-name query still matches only the Path row and the test passes unchanged. Do not name the new button `Copy`.

## Verification

```bash
bun run test:run -- tests/tool-detail-project-row.test.tsx tests/tool-detail-file-copy.test.tsx tests/tool-call-preview-link.test.tsx
bun run typecheck
```

## Acceptance Criteria

1. Expanded tool calls for `read`/`write`/`edit`/`grep`/`glob`/`bash`/`NotebookEdit` with a project input show `Project: <name>` in the specified position, visually identical in weight to the `Path:` row (same label color, same row spacing, mono value, hover copy button).
2. Any tool that renders through `GenericDetails` (including `ls`, `find`, `delete`, `scaffold_project`, `set_project_description`, `delete_project`, `set_preview`, `list_apps`, and historical `deploy_project`/`run_notebook`-style calls) shows the row when `input.project` is a non-empty string.
3. Tool calls without a project input render exactly as today — no empty row, no layout shift.
4. External MCP tool calls never show the row; internal `set_preview`/`set_file_preview` MCP variants do, exactly once.
5. The row's copy button copies the raw project name and is labeled "Copy project name".
6. Collapsed tool summaries, preview links, and path-copy behavior are unchanged; `tests/tool-detail-file-copy.test.tsx` passes without modification.
7. No changes under `workers/` and no tool schema changes.

## Intentionally Not Covered

- `clone_project` passes `sourceProject` (the project being cloned *from*) plus an optional new `name`; a bare `Project:` row would be ambiguous there. Its input JSON already shows both. If product wants it later, add a dedicated `Source project:` row — do not funnel `sourceProject` through `getToolInputProject`.
- `create_project` names the project via `name` (it does not exist yet); skipped for the same reason.
- `move` carries nested `source.project` / `destination.project`; it is js_exec-only today and the generic Input JSON shows both. Skipped.
- Tool calls made *inside* `js_exec` code are part of the code text, not separate tool rows — nothing to do.
- No project icon, no click-through to the project, no mention-chip rendering — the row is intentionally plain text.
