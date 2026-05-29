# Automations Tab — Implementation Plan

**Date:** 2026-05-27
**Primary route:** `/automations`
**Owner files (new):**
- `src/routes/_app.automations.tsx` — loader + page entry
- `src/components/pages/automations/automations-client.tsx` — top-level client
- `src/components/pages/automations/automation-list.tsx` — list + rows
- `src/components/pages/automations/automation-row.tsx` — single row + hover state
- `src/components/pages/automations/automation-panel.tsx` — push-split detail panel
- `src/components/pages/automations/automations-loading.tsx` — `HydrateFallback` skeleton
- `src/lib/automations-shared.ts` — schedule formatter, status-dot mapper, type unifier
- `src/lib/automations.server.ts` — server-only loader/action helpers that talk to `WorkspaceCronDO`, `WorkspaceDO`, `OrgDO`, and `UserDO`
- `workers/main/src/workspace-cron.ts` — additive run-history schema + recording helpers
- `workers/main/src/chat-thread-do.ts` — small runtime-status RPC for pending question/running state
- `src/routes/api/workspaces.$id.automations.*` — optional future JSON API; **do not build for the first pass** unless another consumer needs it. Prefer the consolidated `/automations` route loader/action.

**Files to modify:**
- `src/routes.ts` — register `/automations`
- `src/components/sidebar/app-sidebar.tsx` — add nav entry
- `src/lib/cloudflare.server.ts` — add the missing `WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>` binding type before using it in React Router loaders/actions
- `workers/main/tests/workspace-cron.test.ts` — extend scheduler tests for run history and deterministic completion recording

---

## 1. Objective

Build a single, quiet page that lets users **view, manage, and remove** the scheduled work running in the current workspace. Two flavors of scheduled work coexist in one undifferentiated list:

- **Agent tasks** — `WorkspaceScheduledPrompt` rows from `WorkspaceCronDO` (workers/main/src/workspace-cron.ts:133).
- **Workflows** — `WorkspaceDeterministicAutomation` rows from the same DO (workers/main/src/workspace-cron.ts:151).

This page is intentionally a **read-and-manage surface only**. Creation lives in chat; the "New automation" button on this page seeds a fresh chat that walks the user through setup (mirroring the `/apps` → "New chat" flow at src/components/pages/apps/apps-client.tsx:98).

This document started as **UI/UX-first**. The backend audit below patches the handoff so the implementing agent has the system design needed to make the UI truthful rather than just visually complete.

### 1.1 Backend audit summary

The proposed UI is achievable, but the initial plan would not fully deliver the desired behavior without backend work in three places:

- `WorkspaceCronDO` already owns both automation kinds and has list/create/update/delete/run RPCs. Reuse those RPCs through a server helper; do not duplicate the scheduler through ad hoc tables or HTTP round trips.
- `last_run_status` is not enough for row status. For scheduled prompts, `success` means "chat turn accepted", not "agent finished". Running state must be overlaid from workspace thread streaming state, and needs-input requires a `ChatThreadDO` runtime-status RPC or equivalent persisted signal.
- "Previous runs" does not exist today. Add an additive run-history table inside `WorkspaceCronDO`; keep it bounded so the DO does not grow forever.
- React Router loader/action code cannot currently type `env.WORKSPACE_CRON` because `src/lib/cloudflare.server.ts` omits that binding even though Wrangler defines it. Add the type before implementing the route.
- Cron expressions are evaluated in UTC today. The UI must either suffix/tooltip UTC or introduce a real user/workspace timezone setting. Do not silently display UTC as if it were local time.

---

## 2. Visual language

| Principle | How it shows up |
|---|---|
| Quiet by default | No status dot on healthy rows. No tabs. No filter chips. No type icons. |
| Status is exceptional | Dot only renders when something demands attention (failed / needs input / running). |
| Configuration is hidden | All detail (model, source version, runs, prompt body) lives behind a click into the panel. |
| Boring = scannable | Hairline rows, no cards, no alternating colors. |
| Motion is rare | Schedule↔actions crossfade on row hover; panel slides on selection; running-dot pulses. Nothing else. |

The page should look "almost boring on first glance" — that's the bar.

---

## 3. Page layout — ASCII

### 3.1 Resting state (no panel)

```
┌─ Sidebar ───────────┬──────────────────────────────────────────────────────────────┐
│ ☰ camelAI           │ ☰ │ Automations                                              │
│                     ├──────────────────────────────────────────────────────────────┤
│  + New chat         │                                                              │
│  ──── Chat Groups   │   Automations                          [+ New automation]   │
│  ...                │   Scheduled chats and workflows running on your behalf.     │
│  ──── Workspace     │                                                              │
│  Computer           │   ┌─────────────────────────────────────────────────────┐   │
│  Chat History       │   │ 🔍  Search automations…                              │   │
│  Connections        │   └─────────────────────────────────────────────────────┘   │
│  Apps               │                                                              │
│  Automations  ◀     │   Mentions of camelAI on Hacker News        Daily at 9:00 AM│
│                     │  ────────────────────────────────────────────────────────── │
│                     │   ● Daily revenue summary                   Daily at 8:00 AM│
│                     │  ────────────────────────────────────────────────────────── │
│                     │   Weekly product Q&A digest             Mondays at 10:00 AM │
│                     │  ────────────────────────────────────────────────────────── │
│                     │   ● Stripe payout reconciliation         Mondays at 6:00 AM │
│                     │  ────────────────────────────────────────────────────────── │
│                     │   ● Top 5 bugs from #support           Tue & Fri at 9:00 AM │
│                     │  ────────────────────────────────────────────────────────── │
│                     │   On-call handoff brief                             Paused  │
│                     │  ────────────────────────────────────────────────────────── │
│                     │   Sync Hubspot contacts to Postgres            Every 6 hours│
│                     │  ────────────────────────────────────────────────────────── │
│                     │   ● Fetch GitHub stars → Slack            Daily at 5:00 PM  │
│                     │  ────────────────────────────────────────────────────────── │
│                     │   Retry failed webhook deliveries              Every 15 min │
│                     │  ────────────────────────────────────────────────────────── │
│                     │   Archive old threads to S3                Sundays at 2:00 AM│
│                     │  ────────────────────────────────────────────────────────── │
│                     │   Refresh OpenAI usage cache                          Hourly│
│                     │                                                              │
└─────────────────────┴──────────────────────────────────────────────────────────────┘
```

Container: `max-w-2xl mx-auto` for the inner column. Same outer chrome (`PageHeader` + `ScrollArea`) as `/apps` and `/connections`.

### 3.2 Row hover — schedule swaps for icon buttons

The schedule (`Daily at 8:00 AM`) and the icon trio occupy the **same right-aligned slot**, stacked absolutely so the swap is a pure opacity crossfade with zero layout shift.

```
At rest:
   ● Daily revenue summary                            Daily at 8:00 AM
   ─────────────────────────────────────────────────────────────────

On hover (background tints to muted/50, schedule fades out, icons fade in):
   ● Daily revenue summary                            [▶]  [↗]  [⋯]
   ─────────────────────────────────────────────────────────────────
                                                       │    │    └─ More (Rename / Delete)
                                                       │    └────── Open thread / Open in chat
                                                       └─────────── Run now
```

Icons: Lucide `Play`, `ExternalLink`, `MoreHorizontal`. Each is a `<Button variant="ghost" size="icon">` with `size-7` and a tooltip.

### 3.3 Status dots — only three states render

```
   ● Daily revenue summary           ← green pulsing dot: currently running
   ● Stripe payout reconciliation    ← amber dot: agent paused with a question
   ● Top 5 bugs from #support        ← red dot: most recent run errored

   Mentions of camelAI on HN         ← no dot: success or never-run, healthy
   On-call handoff brief             ← no dot: paused (paused is shown in the schedule slot)
```

**No reserved gutter** for the dot. Rows without a status start flush with the list's left edge. Rows with a dot are naturally indented by the dot's ~14px width. The visual jitter is intentional — the dot reads as an annotation, not a column.

Hovering the dot opens a `Tooltip` with a one-line description (the error message, "Waiting for your input", or "Running now").

### 3.4 Paused row

```
   On-call handoff brief                                       Paused
```

The schedule text is replaced by the word **Paused** in `text-muted-foreground`. The row stays at full opacity. The status dot is still drawn if a previous run errored or asked a question (e.g. paused + last run failed → red dot + "Paused"). Pause does not erase status.

### 3.5 Panel open — push-split

The list does **not** get overlaid. It compresses to make room. The panel docks at fixed `36rem` (576px) on the right. The page header (Automations / subtitle / "+ New automation") stays put in the compressed area.

```
┌─ Sidebar ──┬───────────── List (compressed) ─────────────┬──────── Panel (36rem) ────────┐
│            │ ☰ │ Automations                              │                                │
│            ├──────────────────────────────────────────────┤  [💬 Agent task]    [⋯]  [✕]  │
│            │ Automations          [+ New automation]      │                                │
│            │ Scheduled chats…                             │  Stripe payout reconciliation  │
│            │                                              │                                │
│            │ 🔍 Search…                                   │  PROMPT                        │
│            │                                              │  Compare yesterday's Stripe    │
│            │ Mentions of camelAI on HN   Daily at 9:00 AM │  payouts against ledger        │
│            │ ───────────────────────────────────────────  │  entries in Postgres. Flag any │
│            │ ● Daily revenue summary     Daily at 8:00 AM │  deltas > $25 and open a       │
│            │ ───────────────────────────────────────────  │  Linear ticket.                │
│            │ Weekly product Q&A digest Mondays at 10:00AM │                                │
│            │ ───────────────────────────────────────────  │  [↗ Open thread] [▶ Run now]   │
│            │ ▸ Stripe payout reconc.  Mondays at 6:00 AM  │                       Active ●─│
│            │ ───────────────────────────────────────────  │                                │
│            │ ● Top 5 bugs from #support  Tue&Fri 9:00 AM  │  SCHEDULE                      │
│            │ ───────────────────────────────────────────  │  Repeats        Mondays 6:00 AM│
│            │ On-call handoff brief             Paused     │  Next run             Mon 6:00 │
│            │ ───────────────────────────────────────────  │  Last ran                3d ago│
│            │ Sync Hubspot to Postgres     Every 6 hours   │                                │
│            │ ...                                          │  DETAILS                       │
│            │                                              │  Model        🟠 claude-opus-4 │
│            │                                              │  Created by      Sam Kowalski  │
│            │                                              │                                │
│            │                                              │  PREVIOUS RUNS                 │
│            │                                              │  ● Asked a question   just now │
│            │                                              │  ● Asked a question     1h ago │
│            │                                              │  ● Asked a question     5h ago │
│            │                                              │  ● Completed            1d ago │
│            │                                              │  ● Asked a question     2d ago │
└────────────┴──────────────────────────────────────────────┴────────────────────────────────┘
```

`▸` denotes the selected row in the list. Selected rows get `bg-muted/70` and a left accent — see §6.2.

### 3.6 Panel header — type chip with tooltip

```
┌─────────────────────────────────────────────────────────┐
│ [💬 Agent task]                            [⋯]   [✕]   │
│ ┌───────────────────────────────────────────┐           │
│ │ An agent task is a scheduled prompt that  │           │  ← hover tooltip on the chip
│ │ wakes up a chat thread on a cadence. The  │           │
│ │ agent runs in a thread you can join,      │           │
│ │ nudge, or correct — and your edits carry  │           │
│ │ into the next run.                        │           │
│ └───────────────────────────────────────────┘           │
│                                                         │
│ Stripe payout reconciliation                            │
│                                                         │
│ PROMPT                                                  │
│ Compare yesterday's Stripe payouts against ledger…      │
└─────────────────────────────────────────────────────────┘
```

The chip itself is `[💬 Agent task]` / `[</> Workflow]` — leading Lucide glyph + label only, no info icon. The tooltip is plain text with no leading icon.

Workflow chip tooltip copy: *"A workflow is deterministic JavaScript that runs on a schedule. It executes exactly the same way every time — no model in the loop. Good for retries, exports, and integrations."*

The label switches to `DESCRIPTION` (instead of `PROMPT`) for workflows.

### 3.7 Failed automation in the panel — Last error band

```
[↗ Open thread] [▶ Run now]                  Active ●─

SCHEDULE
Repeats              Daily at 5:00 PM
Next run                   Today 5:00 PM
Last ran                          5h ago

LAST ERROR
┌───────────────────────────────────────────────┐
│ TypeError: Cannot read properties of          │
│ undefined (reading 'data') at line 42         │
└───────────────────────────────────────────────┘

DETAILS
Model                   🟠 claude-opus-4
Created by                 Sam Kowalski
…
```

Use `bg-destructive/10 border-destructive/30 text-destructive` for the error band, font-mono, `text-xs`, scrollable if long. Only renders when `last_run_status === 'error'` and `last_run_error` is truthy.

### 3.8 Empty state (zero automations)

```
┌──────────────────────────────────────────────────────────────┐
│ ☰ │ Automations                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Automations                          [+ New automation]    │
│  Scheduled chats and workflows running on your behalf.      │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🔍  Search automations…                              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│                                                              │
│                       ┌──────────┐                           │
│                       │    ⏱     │                           │
│                       └──────────┘                           │
│                                                              │
│                  No automations yet                          │
│      Schedule a chat or workflow to run on its own.          │
│           Describe what you want in a chat.                  │
│                                                              │
│                  [+ New automation]                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Centered, matches the `EmptyState` pattern at `src/components/history/chats-list.tsx:52`. Icon: Lucide `Clock` in a `rounded-full bg-muted p-4`. Page header and search input still render (per spec §8).

### 3.9 Filtered empty state (search returns nothing)

```
   ┌─────────────────────────────────────────────────────┐
   │ 🔍  webhook                                       ✕ │
   └─────────────────────────────────────────────────────┘

   No automations match "webhook".
```

Small inline message in the list area. Header unchanged.

### 3.10 Loading skeleton

```
   ┌────────────────────────────────────────────────────┐
   │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │   ← Skeleton search input
   └────────────────────────────────────────────────────┘

   ░░░░░░░░░░░░░░░░░░░░░░░░                ░░░░░░░░░░░░░
   ──────────────────────────────────────────────────────
   ░░░░░░░░░░░░░░░░░░                      ░░░░░░░░░░░░░
   ──────────────────────────────────────────────────────
   ░░░░░░░░░░░░░░░░░░░░░░░░░░              ░░░░░░░░░░░░░
   ──────────────────────────────────────────────────────
   (5 rows total, each row matches the height of a real row)
```

Heights:
- Search input skeleton: `h-9 w-full`
- Each row: `py-3` with two `Skeleton` blocks (name + schedule) so the page doesn't reflow when data lands.

---

## 4. shadcn + Lucide component inventory

| Need | Component | Source | Notes |
|---|---|---|---|
| Page chrome | `PageHeader` | `src/components/page-header.tsx:26` | Used by `/apps`, `/connections` — exact same pattern. |
| Scroll container | `ScrollArea` | `src/components/ui/scroll-area.tsx` | Wrap the inner column like `/connections`. |
| Title button | `Button` | `src/components/ui/button.tsx` | Primary `+ New automation`. |
| Search input | `Input` | `src/components/ui/input.tsx` | Same idiom as connections-client.tsx:510 (`pl-9 pr-8` with absolute Search/X). |
| Row divider | `Separator` | `src/components/ui/separator.tsx` | Hairline between rows, matches `chats-list.tsx:127`. |
| Hover-icon buttons | `Button variant="ghost" size="icon"` + `Tooltip` | `src/components/ui/{button,tooltip}.tsx` | `size-7` per icon. |
| Status dot (static) | Plain `<span>` with `bg-amber-500` / `bg-red-500` | — | No new component; just a styled span. |
| Status dot (pulsing) | Same span + `relative` + `<span class="animate-ping…">` | Tailwind | See §6.3 for snippet. |
| Status tooltip | `Tooltip` | `src/components/ui/tooltip.tsx` | Wraps the dot. |
| Row overflow menu | `DropdownMenu` | `src/components/ui/dropdown-menu.tsx` | Rename / Delete (divider) — Delete in `text-destructive`. |
| Inline rename | `Input` + `Button` (Save/Cancel) | — | Mirror `chat-row.tsx:269-340` exactly. |
| Delete confirm | `AlertDialog` | `src/components/ui/alert-dialog.tsx` | Destructive confirm — match `/apps` delete pattern. |
| Type chip in panel | `Badge variant="secondary"` + `Tooltip` | `src/components/ui/badge.tsx` | Small, with leading icon. |
| Pause/resume toggle | `Switch` | `src/components/ui/switch.tsx` | Right-aligned in the panel actions row. |
| Model logo + name | `ModelLogo` + label | `src/components/model-logo.tsx:6` | Drop-in. |
| Push-split layout | Plain flex with conditional render + CSS transition | — | **Do not** use `ResizablePanelGroup` — see §6.6. |
| Panel close | `Button variant="ghost" size="icon"` + Lucide `X` | — | |
| Skeleton | `Skeleton` | `src/components/ui/skeleton.tsx` | |
| Toast on action result | `toast` from `sonner` (already wired) | — | Match `apps-client.tsx` usage. |

Lucide icons used: `Plus`, `Search`, `X`, `Play`, `ExternalLink`, `MoreHorizontal`, `MessageSquare` (agent-task chip), `Code2` (workflow chip), `Clock` (empty state), `Pause`, `RotateCcw`.

No new shadcn primitives need to be installed.

---

## 5. Page architecture

### 5.1 Route + loader

`src/routes/_app.automations.tsx` follows the `_app.apps.tsx:150` and `_app.connections.tsx` template:

```ts
export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const workspaceId = authContext.currentWorkspace?.id;
  if (!workspaceId) return { hasWorkspace: false, automations: [] };

  const data = await buildAutomationsPageData({
    context,
    workspaceId,
    orgId: authContext.currentOrg.id,
    userId: authContext.user.id,
    orgs: authContext.orgs,
  });

  return { hasWorkspace: true, ...data, renderedAt: Date.now() };
}

export default function AutomationsPage() {
  const data = useLoaderData<typeof loader>();
  if (!data.hasWorkspace) return <NoWorkspacesError />;
  return <AutomationsClient initialAutomations={data.automations} initialNow={data.renderedAt} />;
}

export function HydrateFallback() { return <AutomationsLoadingSkeleton />; }
```

`buildAutomationsPageData()` belongs in `src/lib/automations.server.ts`, not in `automations-shared.ts`, so client bundles do not import Durable Object types or server helpers.

Required loader joins:

- Get `env.WORKSPACE_CRON.get(env.WORKSPACE_CRON.idFromName(workspaceId))` and call `listScheduledPrompts(workspaceId)` plus `listDeterministicAutomations(workspaceId)`.
- Get the workspace stub and call `listStreamingThreadStatuses()` once. Use its thread ids as the authoritative running overlay for agent tasks.
- Get the org stub and call `getThreadsByIds(workspaceId, scheduledPromptThreadIds)` once. Use this for `model`, `thread_exists`, and stale-thread handling.
- Get creator profiles from `UserDO.getProfile()` for all distinct `created_by` ids. Missing users should show `created_by_name: null` and render "Unknown" in the panel rather than failing the whole page.
- Get recent run history from the new `WorkspaceCronDO.listAutomationRuns(workspaceId, { limitPerAutomation: 5 })` helper described in §11.2.

### 5.2 Sidebar entry

Add in `src/components/sidebar/app-sidebar.tsx` after the `Apps` item (line 180), and add `isAutomations` to the pathname checks at line 43:

```tsx
const isAutomations = pathname === "/automations";
// ...
<SidebarMenuItem>
  <SidebarMenuButton asChild tooltip="Automations" isActive={isAutomations}>
    <Link to="/automations">
      <Clock />
      <span>Automations</span>
    </Link>
  </SidebarMenuButton>
</SidebarMenuItem>
```

Add `Clock` to the Lucide import at line 4.

### 5.3 Route registration

In `src/routes.ts` after the `/apps` line (line 36):

```ts
route("automations", "routes/_app.automations.tsx"),
```

### 5.4 Client component tree

```
<AutomationsClient>
  <PageHeader breadcrumbs={[{ label: 'Automations' }]} />
  <ScrollArea>
    <div className="flex h-full">                                  ← push-split flex
      <section className="flex-1 transition-[max-width] duration-200">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
          <Header />                                               ← title, subtitle, "+ New automation"
          <SearchInput />
          <AutomationList>
            <AutomationRow />                                      ← × N
          </AutomationList>
        </div>
      </section>
      {selected && (
        <aside className="w-[36rem] shrink-0 border-l">
          <AutomationPanel automation={selected} onClose={…} />
        </aside>
      )}
    </div>
  </ScrollArea>
  <RenameDialog />
  <DeleteConfirmAlertDialog />
</AutomationsClient>
```

When `selected` is set, the left section's `max-width` collapses from `none` to `calc(100% - 36rem)` so the inner `max-w-2xl mx-auto` re-centers in the narrower area. The `transition-[max-width]` provides the slide.

---

## 6. Detailed behavior

### 6.1 List row markup (sketch)

```tsx
<div
  className={cn(
    "group/row relative flex items-center gap-2 cursor-pointer rounded-md px-3 py-3",
    "transition-colors",
    "hover:bg-muted/50",
    isSelected && "bg-muted/70"
  )}
  onClick={() => onSelect(automation.id)}
  role="button"
  tabIndex={0}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(automation.id);
    }
  }}
>
  {statusKind && <StatusDot kind={statusKind} message={statusMessage} />}
  <span className="flex-1 min-w-0 truncate text-sm">{automation.name}</span>
  <div className="relative h-7 min-w-[140px] flex items-center justify-end">
    {/* Schedule — fades out on row hover */}
    <span
      className={cn(
        "absolute inset-0 flex items-center justify-end text-sm text-muted-foreground",
        "transition-opacity duration-100",
        "group-hover/row:opacity-0 pointer-events-none"
      )}
    >
      {automation.enabled ? humanSchedule : 'Paused'}
    </span>
    {/* Actions — fade in on row hover */}
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-end gap-0.5",
        "opacity-0 transition-opacity duration-100",
        "group-hover/row:opacity-100"
      )}
    >
      <RowAction icon={Play} label="Run now" onClick={…} />
      <RowAction icon={ExternalLink} label="Open" onClick={…} />
      <RowOverflowMenu onRename={…} onDelete={…} />
    </div>
  </div>
</div>
```

Each row is wrapped in a `<div>` with a `<Separator />` between (mirror `chats-list.tsx:104-130`). No separator after the last row.

### 6.2 Selected row affordance

When a row is selected (panel open), give it `bg-muted/70` and a `before:` pseudo accent on the left edge (`before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-foreground/40 before:rounded-full`). Subtle — just enough to anchor the eye when the panel is showing.

### 6.3 Status dot

`src/components/pages/automations/status-dot.tsx`:

```tsx
const dotClass = {
  running:    'bg-emerald-500',
  needs_input:'bg-amber-500',
  failed:     'bg-red-500',
} as const;

export function StatusDot({ kind, message }: { kind: 'running'|'needs_input'|'failed'; message: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex size-2 shrink-0" aria-label={message}>
          {kind === 'running' && (
            <span className="absolute inset-0 inline-flex animate-ping rounded-full bg-emerald-500 opacity-75" />
          )}
          <span className={cn('relative inline-flex size-2 rounded-full', dotClass[kind])} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{message}</TooltipContent>
    </Tooltip>
  );
}
```

Status precedence (when more than one signal applies): **needs_input > failed > running**. (`needs_input` wins because it's the most actionable — the user can resolve it; the other two are informational.) A successful or never-run automation passes `kind={null}` and renders no dot.

### 6.4 Schedule formatter

There is no human-cron formatter in the repo today. The existing `parseCronExpression` / `getNextCronRunAt` (workers/main/src/cron-schedule.ts) handles math but not language.

**Recommendation:** add a small client helper `src/lib/automations-shared.ts:formatCronExpression(expr: string, options?: { timezoneLabel?: string }): string` rather than pulling in `cronstrue` (~15 KB gzip — overkill for the limited patterns we need). The helper recognizes the canonical patterns the agent will produce.

Important backend detail: scheduler math is UTC (`CodeModeScheduledPrompts` and deterministic automation tool responses already return `timezone: "UTC"`). Until the product has a persisted user/workspace timezone, the formatted string should include a compact UTC signal in the panel (`Mondays at 6:00 AM UTC`) and may use a tooltip or visually muted suffix in the row if design wants to preserve the screenshot's quieter look. Do not convert with the browser timezone unless creation/storage also changes.

| Pattern matched | Output |
|---|---|
| `0 9 * * *` | `Daily at 9:00 AM UTC` |
| `0 6 * * 1` | `Mondays at 6:00 AM UTC` |
| `0 9 * * 2,5` | `Tue & Fri at 9:00 AM UTC` |
| `0 */6 * * *` | `Every 6 hours` |
| `*/15 * * * *` | `Every 15 min` |
| `0 * * * *` | `Hourly` |
| `0 2 * * 0` | `Sundays at 2:00 AM UTC` |
| Fallback | The raw expression in `font-mono text-xs` |

Render the fallback if no pattern matches — better than lying. Backend agent should normalize cron expressions to the canonical 5-field UTC form before storing (the DO already does this at workspace-cron.ts:965 via `normalizeCronExpression`).

### 6.5 Row hover icon buttons — exact behavior

| Icon | onClick | After |
|---|---|---|
| `Play` "Run now" | `fetcher.submit({ intent: 'run' }, { method: 'post', action: '/automations' })` | `toast.success("Run started")` on success. The action returns a normalized item; the runtime overlay/workflow `started` state surfaces the green pulsing dot on the row. |
| `ExternalLink` "Open" | Agent task: `navigate(\`/chat/\${automation.thread_id}\`)`. Workflow: `submit({ intent: 'createThreadAndStart', firstMessage: <seeded>, … }, { method: 'post', action: '/chat' })`. | See §8 for the exact seeded message. |
| `MoreHorizontal` "More" | Opens `DropdownMenu` with Rename and Delete (red, separated by `DropdownMenuSeparator`). | Rename opens inline edit (§6.7). Delete opens `AlertDialog` confirm (§6.8). |

Stop click propagation on every action button (`e.stopPropagation()`) so the icons don't also open the panel.

### 6.6 Push-split layout — implementation note

**Do not** use `ResizablePanelGroup` (src/components/ui/resizable.tsx). The spec says "slides the list compressed and the panel into place" — that implies a deterministic move, not a user-resizable handle. Use a plain flex container with a conditional `<aside>` and `transition-[max-width]` on the list section. The slide is just CSS.

```tsx
<div className="flex h-full min-h-0">
  <section
    className={cn(
      "flex-1 min-w-0 transition-[max-width] duration-200 ease-out",
      selected ? "max-w-[calc(100%-36rem)]" : "max-w-none"
    )}
  >
    {/* list */}
  </section>
  <aside
    className={cn(
      "shrink-0 border-l border-border bg-background overflow-hidden",
      "transition-[width] duration-200 ease-out",
      selected ? "w-[36rem]" : "w-0"
    )}
    aria-hidden={!selected}
  >
    {selected && <AutomationPanel … />}
  </aside>
</div>
```

The list stays mounted and clickable while the panel is open. Clicking a different row replaces the panel content but does not close the panel — wire `setSelectedId` on row click regardless of current selection.

For viewports narrower than `lg` (≤ 1024px), fall back to overlaying the panel as a `Sheet` (slide from right). The push-split only makes sense when there's room to push.

### 6.7 Inline rename

Mirror `src/components/history/chat-row.tsx:269-340` exactly:

- Triggered from the overflow menu's "Rename" item (or the kebab in the panel).
- Replaces the row name with an `<Input>` + `[Save] [Cancel]` buttons.
- Enter saves, Escape cancels. Outside-click saves if changed, otherwise cancels.
- Disabled state when name is empty or unchanged.
- On save: `fetcher.submit({ intent: 'rename', id, name }, …)`. Optimistic — update local state, revert on error with a toast.

### 6.8 Delete confirm

Use `AlertDialog`. Copy:

> **Delete "Stripe payout reconciliation"?**
>
> This automation will stop running and its history will be removed. The underlying chat thread will not be deleted. *(For workflows: "The automation source will no longer appear in your workspace automation files.")*
>
> [Cancel]  [Delete automation] ← destructive

On confirm: `fetcher.submit({ intent: 'delete', id, kind }, …)`. On success: close the panel if open, remove the row from local state, toast "Automation deleted".

### 6.9 Pause / resume

The "Active / Paused" `Switch` in the panel actions row. When toggled:

```ts
fetcher.submit(
  { intent: 'setEnabled', id, kind, enabled: String(next) },
  { method: 'post', action: '/automations' }
);
```

Optimistic update on the row (the schedule text in the list flips to "Paused" or back to the human schedule immediately). Revert on error.

### 6.10 Keyboard

- `Esc` while a panel is open: close the panel (`setSelectedId(null)`). Bind to the `aside` via `onKeyDown` or a `useEffect` window listener that's only active when `selected`.
- `Esc` while inline rename is open: cancel rename (handled by the existing rename pattern).
- `Enter` / `Space` on a row: open the panel for that row.
- `/` (forward slash) anywhere on the page: focus the search input. (Don't render a kbd hint per spec, but the binding is cheap and matches platform conventions.)

### 6.11 Live updates ("running now" dot)

The spec requires the running-now dot to pulse, implying live data. There are two existing signals:

- Agent tasks: `ChatThreadDO` records streaming state into `WorkspaceDO.thread_streaming_status`. The loader can call `WorkspaceDO.listStreamingThreadStatuses()` and mark scheduled prompts whose `thread_id` is present as running.
- Workflows: `WorkspaceCronDO` sets deterministic automation `last_run_status = "started"` and clears it to `success`/`error` through `recordDeterministicAutomationRunResult()`.

Two UI refresh options:

- **A. Poll on a short interval.** Use `useRevalidator` from React Router; revalidate every 10 s while any row has a computed in-flight status, and once on tab visibility change. Simpler.
- **B. Workspace status WebSocket.** `WorkspaceDO.fetch('/status')` already broadcasts running thread changes for chat sidebar state. This could update agent-task rows without polling, but it will not cover deterministic workflow completion unless the scheduler also broadcasts or the client still polls.

**Recommendation:** start with option A. Poll when any unified item has `runtime_status === 'running'`, `runtime_status === 'needs_input'`, `last_run_status === 'busy'`, or `last_run_status === 'started'`; also revalidate on `visibilitychange`. Keep the interval to 10 s and stop polling when everything is idle/healthy. This avoids coupling the first implementation to another WebSocket.

---

## 7. Data model

### 7.1 Unified loader shape

The loader returns one array, regardless of kind. The UI never branches on kind except in the panel.

```ts
// src/lib/automations-shared.ts (types co-located with formatter)
export type AutomationKind = 'agent_task' | 'workflow';
export type AutomationStatusDot = 'running' | 'needs_input' | 'failed' | null;
export type AutomationRuntimeStatus = 'idle' | 'running' | 'needs_input';

export interface AutomationListItem {
  id: string;
  kind: AutomationKind;
  name: string;
  cron_expression: string;
  timezone: 'UTC';
  enabled: boolean;
  can_manage: boolean;

  // Detail body — `prompt` for agent tasks, `description` for workflows.
  body: string;
  body_label: 'Prompt' | 'Description';

  // Schedule + last-run state.
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: 'success' | 'busy' | 'question' | 'error' | 'started' | null;
  last_run_error: string | null;

  // Runtime overlay, derived from WorkspaceDO/ChatThreadDO instead of the
  // scheduler row. This is what makes "running now" truthful for agent tasks.
  runtime_status: AutomationRuntimeStatus;
  runtime_message: string | null;
  runtime_updated_at: number | null;

  // For "Open" routing.
  thread_id: string | null;          // present for agent_task, null for workflow
  thread_exists: boolean | null;     // agent_task only. false disables "Open thread".

  // For the panel's Details section.
  created_by_id: string;
  created_by_name: string | null;    // resolved by loader
  model: string | null;              // present for agent_task (joined from thread's OrgDO record)
  source_version: number | null;     // present for workflow

  // For "Previous runs" — backed by §11.2 automation_runs history.
  recent_runs: AutomationRunSummary[];
}

export interface AutomationRunSummary {
  id: string;
  status: 'started' | 'success' | 'error' | 'question' | 'busy';
  started_at: number;
  completed_at: number | null;
  trigger: 'schedule' | 'manual';
  message: string | null;
  thread_id?: string | null;
  instance_id?: string | null;
}

export function statusDotKind(item: AutomationListItem): AutomationStatusDot { /* see §7.2 */ }
export function statusDotMessage(item: AutomationListItem): string { /* tooltip copy */ }
export function formatCronExpression(expr: string, options?: { timezoneLabel?: string }): string { /* §6.4 */ }
```

### 7.2 Status dot mapping

```ts
export function statusDotKind(item: AutomationListItem): AutomationStatusDot {
  // Precedence: needs_input > failed > running.
  if (item.runtime_status === 'needs_input' || item.last_run_status === 'question') return 'needs_input';
  if (item.last_run_status === 'error') return 'failed';
  if (item.runtime_status === 'running' || item.last_run_status === 'busy' || item.last_run_status === 'started') return 'running';
  return null; // 'success' or null both render as no dot.
}

export function statusDotMessage(item: AutomationListItem): string {
  const kind = statusDotKind(item);
  if (kind === 'needs_input') return item.runtime_message ?? 'Waiting for your input';
  if (kind === 'failed') return item.last_run_error?.split('\n')[0] ?? 'Most recent run failed';
  if (kind === 'running') return item.runtime_message ?? 'Running now';
  return '';
}
```

Do not derive agent-task running status from `last_run_status === "success"`. Today scheduled prompts write `"success"` when `ChatThreadDO.startInitialUserMessage()` accepts the turn, while the agent may still be running for minutes.

### 7.3 Sorting

Default sort: rows that demand attention first, then alphabetical. Specifically:

1. `needs_input`
2. `failed`
3. `running`
4. Everything else (alphabetical by name, case-insensitive)

Paused automations are not pushed to the bottom — they sort within group 4. (Per spec: paused should remain "legible and discoverable", not "feel like dead weight".)

---

## 8. Routing and chat handoff

### 8.1 "+ New automation"

Mirror `apps-client.tsx:handleStartChat` (line 98) exactly. Seed a fresh chat with a system message that primes the agent to walk the user through creating an automation:

```ts
const systemMessage =
  `<camelai system message>I'd like to create a new scheduled automation. ` +
  `Help me set one up — ask me what I want it to do, how often it should run, ` +
  `and what kind of automation makes sense (scheduled agent task vs deterministic workflow). ` +
  `When ready, create it for me using your automation tools.</camelai system message>`;

submit(
  {
    intent: 'createThreadAndStart',
    clientBuildId: APP_BUILD_ID,
    initialTitle: 'New automation',
    firstMessage: systemMessage,
  },
  { method: 'post', action: '/chat' }
);
```

Reuses `/chat` action at `src/routes/_app.chat._index.tsx:431` which calls `chatDO.createThread()` and starts the initial agent turn. No new server work.

### 8.2 "Open thread" — agent tasks

Agent tasks already have `thread_id`, but the loader must verify it still exists through `OrgDO.getThreadsByIds(workspaceId, ids)`.

```ts
navigate(`/chat/${automation.thread_id}`);
```

If `thread_exists === false`, disable the button and show muted helper text in the Details section: `Original thread is unavailable. Run now will create a replacement thread.` This matches `WorkspaceCronDO.ensureRunnableThread()`, which recreates a missing scheduled-prompt thread on the next run and updates `thread_id`.

### 8.3 "Open in chat" — workflows

Workflows don't have a thread of origin. Seed one fresh, mirroring `handleStartChat` but with a different system message:

```ts
const systemMessage =
  `<camelai system message>I'd like to work on the automation "${automation.name}". ` +
  `Automation id: ${automation.id}. ` +
  `Its source lives at /home/claude/.camelai/automations/${automation.id}.js. ` +
  `Its current schedule is ${automation.cron_expression} UTC. ` +
  `Read it first, then ask me what I want to change.</camelai system message>`;

submit(
  {
    intent: 'createThreadAndStart',
    clientBuildId: APP_BUILD_ID,
    initialTitle: `Edit: ${automation.name}`,
    firstMessage: systemMessage,
  },
  { method: 'post', action: '/chat' }
);
```

The source path is the canonical agent-visible location per `docs/deterministic-automations-architecture.html` (`/home/claude/.camelai/automations/<id>.js`).

### 8.4 Deep linking the panel

Use a URL search param so refreshing or sharing a link keeps the panel open:

- `/automations` — panel closed
- `/automations?selected=<id>` — panel showing that automation

On row click: `setSearchParams({ selected: id })`. On close: `setSearchParams({})`. Use `useSearchParams` from `react-router`. If the loader runs and `selected` doesn't match any returned item, drop the param silently.

---

## 9. API surface (for the backend agent)

Use the `/automations` route loader/action for the first implementation. These operations are page-owned, and the existing `/apps` route already uses this consolidated pattern. Add separate `src/routes/api/workspaces.$id.automations.*` routes only if a non-page client needs JSON endpoints later.

`src/routes/_app.automations.tsx` action intents:

| Intent | Form fields | Scheduler RPC |
|---|---|---|
| `run` | `kind`, `id` | `runScheduledPromptNow(workspaceId, id)` or `runDeterministicAutomationNow(workspaceId, id)` |
| `setEnabled` | `kind`, `id`, `enabled` | `updateScheduledPrompt({ enabled })` or `updateDeterministicAutomation({ enabled })` |
| `rename` | `kind`, `id`, `name` | Existing update RPC with `name` only |
| `delete` | `kind`, `id` | Existing delete RPC |

Action auth and validation:

- Use `requireSessionWorkspaceAccess(request, context, undefined, { requireWrite: true })` for every mutation. This keeps route auth aligned with chat creation and workspace writes.
- Enforce org membership through that helper, then fetch the automation row from `WorkspaceCronDO` before mutating. Return `{ error: "Automation not found" }` for missing/wrong-kind ids.
- Permission recommendation for first pass: any member with full workspace access can run/pause/rename/delete workspace automations, matching current workspace-scoped surfaces like connections/apps. If product wants creator-only controls later, add a `created_by === userId || orgStub.isAdmin(userId)` check in `automations.server.ts`.
- Return a normalized `automation` item after `run`, `setEnabled`, and `rename` so the client can update local state without guessing. Return `{ success: true, id, kind }` for delete.
- Surface backend `Error.message` to the toast verbatim. Do not turn scheduler/DO failures into empty success states.

Server helper functions:

```ts
getWorkspaceCronStub(env, workspaceId): DurableObjectStub<WorkspaceCronDO>
buildAutomationsPageData(input): Promise<{ automations: AutomationListItem[] }>
normalizeScheduledPrompt(prompt, joins): AutomationListItem
normalizeDeterministicAutomation(automation, joins): AutomationListItem
mutateAutomation(input): Promise<AutomationActionResult>
```

Keep `src/lib/automations-shared.ts` limited to serializable types and pure formatting/status helpers. Keep DO access, auth checks, profile joins, and mutation logic in `src/lib/automations.server.ts`.

---

## 10. Acceptance criteria

### Page chrome
- [ ] `/automations` is reachable from the sidebar (between Apps and Get Help) with a `Clock` icon and active-state highlight.
- [ ] The page shows the breadcrumb header with `Automations`.
- [ ] The title `Automations`, the subtitle `Scheduled chats and workflows running on your behalf.`, and the `+ New automation` button render in a row matching the `/connections` header.
- [ ] The inner content column is centered with `max-w-2xl`.

### List
- [ ] Each row shows: optional status dot, the name, and the human schedule on the right.
- [ ] Healthy / never-run rows render no dot and start flush with the left edge.
- [ ] Failed rows render a red dot; needs-input rows render an amber dot; running rows render a softly pulsing green dot.
- [ ] When more than one applies, precedence is **needs_input > failed > running**.
- [ ] Hovering the dot shows a `Tooltip` with: the error message, "Waiting for your input", or "Running now".
- [ ] Rows are separated by a `Separator` (hairline). No alternating background colors.
- [ ] Hovering a row tints the background to `bg-muted/50` and crossfades the schedule out and three icon buttons in **with zero layout shift**.
- [ ] The three icons in order: `Play` (Run now), `ExternalLink` (Open), `MoreHorizontal` (More).
- [ ] Each icon has a `Tooltip` on hover.
- [ ] Clicking an icon does not also open the panel.
- [ ] The overflow menu has only `Rename` and `Delete` (red, with `DropdownMenuSeparator` above).

### Paused
- [ ] Toggling pause from the panel flips the row's schedule text to `Paused` (muted) in real time and back when resumed.
- [ ] Paused rows do not dim. They remain at full opacity.
- [ ] Status dot still renders on paused rows when applicable (paused + last failed → red dot + "Paused").

### Search
- [ ] Search input filters by `name` (case-insensitive, substring).
- [ ] Clearing search restores the full list.
- [ ] Filtered-empty state shows `No automations match "<query>".` inline. The page header is unchanged.

### Push-split panel
- [ ] Clicking a row opens the panel. The list compresses (CSS transition on `max-width`) and the `36rem` panel slides in from the right.
- [ ] Clicking a second row updates panel content without closing the panel.
- [ ] Closing the panel (`X` or `Esc`) returns the list to full width.
- [ ] On viewports < `lg`, the panel renders as an overlay `Sheet` instead.
- [ ] The URL reflects `?selected=<id>` and refresh restores the panel.

### Panel content
- [ ] A small type chip reading `Agent task` or `Workflow` renders at the top, with a `Tooltip` explaining the difference (copy in §3.6).
- [ ] The automation's name is the large heading.
- [ ] A labeled block (`PROMPT` or `DESCRIPTION`) shows the body text plain — no quotes, no card, no left rule.
- [ ] Kebab and Close buttons sit to the right of the header.
- [ ] Action row: primary `Open thread` (agent task) or `Open in chat` (workflow), secondary `Run now`, right-aligned `Active`/`Paused` `Switch`.
- [ ] `SCHEDULE` section shows Repeats / Next run / Last ran.
- [ ] `LAST ERROR` section renders **only** when the most recent run errored; styled with `bg-destructive/10`, font-mono error text.
- [ ] `DETAILS` section shows the model (with `ModelLogo` + name) for agent tasks, or the source version for workflows, plus the creator's name in both cases.
- [ ] `PREVIOUS RUNS` shows up to ~5 recent runs with a tiny status dot, label, and relative time.
- [ ] The panel scrolls independently of the list.
- [ ] Mutating controls respect `can_manage`: disable Run/Pause/Rename/Delete with a clear tooltip if the route says the user cannot manage the automation.

### Creation flow
- [ ] `+ New automation` submits to `/chat` with `intent: 'createThreadAndStart'` and a seeded system message (§8.1) and lands the user in the new chat thread.

### "Open" routing
- [ ] Agent task: navigates to `/chat/<thread_id>` when `thread_exists !== false`; disabled with stale-thread helper text when the linked thread is unavailable.
- [ ] Workflow: creates a new chat seeded with the workflow's source path (§8.3) and lands the user there.

### Empty / loading
- [ ] Empty state shows centered `Clock` icon, "No automations yet", and the `+ New automation` CTA. The header and search input are still visible.
- [ ] `HydrateFallback` renders a skeleton search input + 5 skeleton rows whose heights match real rows (no layout shift on hydration).

### A11y
- [ ] Every icon button has an `aria-label`.
- [ ] Status dots have `aria-label` describing the state.
- [ ] Rows are keyboard-activatable (Enter / Space).
- [ ] Tooltips appear on focus, not just hover.
- [ ] The push-split panel sets `aria-hidden` when collapsed.

### Motion (per spec §7)
- [ ] Schedule ↔ icons crossfade is ≤ 100ms.
- [ ] Panel slide is ~200ms `ease-out`.
- [ ] Running dot pulse uses `animate-ping`.
- [ ] Menu open/close is ≤ 150ms with a small Y offset (shadcn `DropdownMenu` default is fine).

---

## 11. Backend Architecture Patch

This is the implementation detail the UI plan needs. Without these patches, the page can render rows but cannot truthfully show running, needs-input, or previous-run states.

### 11.1 Binding and helper plumbing

Add `WorkspaceCronDO` to the React Router Cloudflare env type:

```ts
// src/lib/cloudflare.server.ts
import type { WorkspaceCronDO } from "../../workers/main/src/workspace-cron";

export interface CloudflareEnv {
  WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>;
  // existing bindings...
}
```

Then keep all scheduler access in `src/lib/automations.server.ts`:

```ts
function getWorkspaceCronStub(env: CloudflareEnv, workspaceId: string) {
  return env.WORKSPACE_CRON.get(
    env.WORKSPACE_CRON.idFromName(workspaceId),
  ) as DurableObjectStub<WorkspaceCronDO>;
}
```

The Wrangler configs already bind `WORKSPACE_CRON`; the missing piece is TypeScript visibility in the app-side loader/action.

### 11.2 Run-history storage

Add one bounded history table to `WorkspaceCronDO` schema version 5:

```sql
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- scheduled_prompt | deterministic_automation
  automation_id TEXT NOT NULL,
  trigger TEXT NOT NULL,           -- schedule | manual
  status TEXT NOT NULL,            -- started | success | error | question | busy
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  message TEXT,
  thread_id TEXT,
  instance_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_lookup
  ON automation_runs(kind, automation_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_runs_instance
  ON automation_runs(kind, automation_id, instance_id)
  WHERE instance_id IS NOT NULL;
```

Add these `WorkspaceCronDO` RPCs:

```ts
type AutomationRunKind = "scheduled_prompt" | "deterministic_automation";

listAutomationRuns(
  workspaceId: string,
  input?: { limitPerAutomation?: number },
): Promise<Record<`${AutomationRunKind}:${string}`, AutomationRunRecord[]>>

recordScheduledPromptRunResult(input: {
  workspaceId: string;
  promptId: string;
  runId: string;
  status: "success" | "error" | "question" | "busy";
  message?: string | null;
  completedAt?: number | null;
}): Promise<boolean>
```

Internal helpers should insert/update runs and then trim per automation:

```sql
DELETE FROM automation_runs
WHERE kind = ? AND automation_id = ?
  AND id NOT IN (
    SELECT id FROM automation_runs
    WHERE kind = ? AND automation_id = ?
    ORDER BY started_at DESC
    LIMIT 20
  );
```

Use one table instead of two. Both automation kinds live in the same DO and the UI wants one normalized shape.

### 11.3 Scheduled-prompt lifecycle

Current behavior: `WorkspaceCronDO.dispatchPrompt()` returns `success` when `ChatThreadDO.startInitialUserMessage()` returns `accepted`. That is only a dispatch outcome. It does not mean the agent completed.

Patch the lifecycle:

1. In `runScheduledPromptNow()` and `alarm()`, create an `automation_runs` row with `status = "started"` before dispatching the chat turn.
2. Extend `InitialUserMessageRequest` in `workers/main/src/chat-thread-do.ts` with optional automation metadata:

```ts
automationRun?: {
  workspaceId: string;
  automationId: string;
  runId: string;
};
```

3. Pass that metadata from `WorkspaceCronDO.dispatchPrompt()` into `startInitialUserMessage()`.
4. In `ChatThreadDO`, store the active automation run while the scheduled message is streaming. A small KV record is enough; clear it when the turn completes.
5. When `askUserQuestion()` creates a pending prompt for that active run, call `WorkspaceCronDO.recordScheduledPromptRunResult({ status: "question" })` via `ctx.waitUntil`. This powers the amber dot and the "Asked a question" history row.
6. When `setChatIsStreaming(false, { markUnread: true, completedAt })` ends that active run, call `recordScheduledPromptRunResult({ status: "success", completedAt })` unless the run already ended with `error`.
7. When the runner path emits a turn-level error for that active run, call `recordScheduledPromptRunResult({ status: "error", message })`.
8. If enqueue fails or the runner is busy, record `error` or `busy` immediately with the message returned from `ChatThreadDO`.

Also update the scheduled prompt row's `last_run_status`, `last_run_error`, and `last_run_at` from these lifecycle callbacks. Keep backward compatibility by preserving the existing statuses, but make their meaning terminal/current rather than merely "accepted".

### 11.4 Runtime overlay

The loader must build row status from runtime state plus scheduler state:

- Agent task running: `WorkspaceDO.listStreamingThreadStatuses()` contains the prompt's `thread_id`.
- Agent task needs input: add `ChatThreadDO.getRuntimeStatus()` and call it for scheduled-prompt threads that are currently streaming. Return:

```ts
{
  isStreaming: boolean;
  pendingQuestionCount: number;
  oldestPendingQuestion: string | null;
  updatedAt: number | null;
}
```

`ChatThreadDO` already has `chatIsStreaming` and `browserPrompts.pendingQuestionPrompts()`. This RPC should expose only status metadata, not message transcripts or full question bodies beyond a short first-question summary.

- Workflow running: `last_run_status === "started"` until `recordDeterministicAutomationRunResult()` marks success/error.

If there are many scheduled prompts, only call `getRuntimeStatus()` for thread ids that are streaming according to `WorkspaceDO`. That keeps loader fan-out bounded in the common idle case.

### 11.5 Deterministic workflow lifecycle

Patch `WorkspaceCronDO.runDeterministicAutomationNow()`, the scheduled deterministic branch in `alarm()`, and `recordDeterministicAutomationRunResult()`:

- Use the workflow `instanceId` as `automation_runs.instance_id`.
- Insert a `started` run row before `workflow.create()`.
- If `workflow.create()` throws, update the run row to `error`.
- When `recordDeterministicAutomationRunResult()` receives `success`/`error`, update both the automation row and matching run row by `(kind, automation_id, instance_id)`.
- Keep `deterministic_automation_versions` on delete. Already-started workflow instances may still need historical source. Deleting the automation should remove the current row and run history, while the virtual file disappears from the agent-visible `/home/claude/.camelai/automations/<id>.js` listing.

### 11.6 Loader normalization

Normalize in this order:

1. Fetch scheduled prompts and workflows from `WorkspaceCronDO`.
2. Fetch streaming thread statuses once from `WorkspaceDO`.
3. Batch-fetch scheduled prompt threads with `OrgDO.getThreadsByIds(workspaceId, ids)` for model and stale-thread detection.
4. Fetch creator profiles from `UserDO`.
5. Fetch recent runs from `WorkspaceCronDO.listAutomationRuns()`.
6. Compute `runtime_status`, `statusDotKind`, formatted schedule text, `can_manage`, and sorted order.

Sorting remains the UI plan's order: needs input, failed, running, then alphabetical. Use the computed status dot, not raw `last_run_status`, for this sort.

### 11.7 Mutation semantics

- `run`: allowed even when `enabled === false`; it should start one manual run without resuming the schedule. Existing scheduler RPCs already behave this way by preserving `next_run_at = null` for disabled rows.
- `setEnabled`: use existing update RPCs. Enabling recomputes `next_run_at`; disabling clears it.
- `rename`: update only `name`. Do not mutate scheduled prompt `prompt` or workflow `description`.
- `delete scheduled prompt`: delete scheduler row and run history; do **not** delete the underlying chat thread.
- `delete workflow`: delete current scheduler row and run history; keep version snapshots as noted above.

### 11.8 Tests

Add/extend tests before wiring the UI:

- `workers/main/tests/workspace-cron.test.ts`: run-history insert/list/trim for scheduled prompts and workflows.
- `workers/main/tests/workspace-cron.test.ts`: deterministic `recordDeterministicAutomationRunResult()` updates the matching history row and ignores stale instance ids.
- A focused route/action test if the existing app route test harness supports React Router actions; otherwise cover the server helper directly with a mocked env/stub shape.
- `bun run typecheck` must pass after adding `WORKSPACE_CRON` to `CloudflareEnv`.
- For UI changes, run the relevant Vitest tests plus `bun run typecheck`.

## 12. Backend Acceptance Criteria

- [ ] `src/lib/cloudflare.server.ts` includes the `WORKSPACE_CRON` binding type.
- [ ] `/automations` loader reads both scheduler tables through `WorkspaceCronDO` and performs batch joins for thread model, thread existence, creators, streaming state, and recent runs.
- [ ] Agent-task running dots are based on `WorkspaceDO.listStreamingThreadStatuses()`, not raw scheduled-prompt `last_run_status`.
- [ ] Needs-input dots are backed by a `ChatThreadDO` runtime signal and/or scheduled-prompt lifecycle update, not a status value that is never written.
- [ ] Previous runs come from bounded `automation_runs` history in `WorkspaceCronDO`.
- [ ] Deleting an automation removes its current scheduler row and history but does not delete scheduled-prompt chat threads or deterministic version snapshots needed by in-flight workflow instances.
- [ ] Mutations require full workspace access and return explicit errors for wrong-kind/missing ids.
- [ ] Schedule text does not imply local time unless a real timezone conversion/storage story is added.

## 13. Out of scope (intentional — see spec §9)

- No tabs (type / status / anything).
- No filter chips.
- No type icon, badge, or chip on rows (only in the panel header).
- No avatars, run counts, last-run timestamps, sparklines, or owner info on rows.
- No bulk-select.
- No in-page creation form.
- No persistent toolbar of actions.

Keep these decisions firm. They are the difference between a tab that feels like a control panel and a tab that feels like a calm overview.
