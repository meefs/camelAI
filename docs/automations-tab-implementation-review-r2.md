# Automations Tab Implementation Review R2

**Date:** 2026-05-28
**Scope:** second review of the current local diff in `automations-tab-plan`, after the first review's desktop Sheet and scheduled-prompt `busy` feedback were addressed.

## Findings

### P1: Stale action data can resurrect an old "running" status after selection changes

This matches the observed bug where an agent task correctly loses its status dot after completing, but later flips back to "in progress" after clicking around the automation list.

The issue is in the `fetcher.data` handling effect in `src/components/pages/automations/automations-client.tsx:176`. The effect depends on `selectedId` (`src/components/pages/automations/automations-client.tsx:216`) because delete handling checks whether the deleted row is selected. That means every selection change re-runs the effect with the last action response still held in `fetcher.data`.

For a `Run now` action, that stale response may contain the automation from the moment the run started. The loader/polling can later update local state to completed and remove the dot, but selecting another row replays the old `fetcher.data` branch at `src/components/pages/automations/automations-client.tsx:188` and writes the older running automation back into local state.

Recommended fix: make action response processing one-shot and independent of selection changes. Options:

- Change the effect dependency to only process new `fetcher.data`, and use a `selectedIdRef` or a separate delete-specific effect for clearing the selected search param.
- Or require `pendingAction.current` to be present before applying `fetcher.data`; if there is no pending action, ignore the stale response.
- Or include an action id/sequence number in `pendingAction` and in the response handling path, and skip already-processed action data.

The smallest patch is likely: remove `selectedId` from the effect dependency, keep a ref of the latest selected id for delete cleanup, and return early when `pendingAction.current` is null.

### P2: `Run now` reports success even when dispatch failed

`mutateAutomation()` treats any non-null scheduler run result as a successful route action (`src/lib/automations.server.ts:308`). That is not enough: both run RPCs can return a row plus a failed dispatch. For example, `runDeterministicAutomationNow()` returns `{ automation, dispatch: { status: "error", error: "Deterministic automation workflow binding is not configured" } }` when the workflow binding is missing (`workers/main/src/workspace-cron.ts:1611`). Scheduled prompt dispatch can likewise return `error` if chat startup fails.

The client then unconditionally shows `toast.success("Run started")` for every action response containing `automation` (`src/components/pages/automations/automations-client.tsx:188`). So a failed manual run can update the row to failed while still telling the user "Run started."

Recommended fix: make the `run` action inspect `result.dispatch.status`. If it is `error` or `busy`, return `{ error: result.dispatch.error ?? "Failed to start run" }` after the scheduler records the failure, or return a structured `{ success: false, automation, error }` shape so the UI can both update the row and show an error toast. Do not use the success toast unless the run was actually accepted/started.

## Resolved From R1

- Desktop split panel no longer opens the mobile Sheet overlay; `showMobileSheet` is gated by mount state and `useMediaQuery("(min-width: 1024px)")`.
- Accepted scheduled-prompt dispatches now return `success` again instead of reusing `busy`.

## Remaining Test Gaps

- Add a route/helper test for `run` when scheduler dispatch returns `error`, so the action cannot regress to a success toast on failed runs.
- Add UI/browser coverage for selecting an automation at desktop and mobile widths. This would lock in the split-panel vs. Sheet behavior.
- The existing scheduler test still manually calls `recordScheduledPromptRunResult()`, so it does not fully prove the `WorkspaceCronDO -> ChatThreadDO -> WorkspaceCronDO` lifecycle records terminal statuses.

## Verification Run

- `bun run typecheck` passed.
- `bun run test:workers -- workspace-cron.test.ts` passed.

---

## UI Review R2 (added 2026-05-28)

Visual/UX layer feedback. Additive to the codex P1/P2 findings above.

### P1: Push-split panel needs to be a full-height column, not nested inside the page-body scroll area

Current structure at `src/components/pages/automations/automations-client.tsx:396-490`:

```tsx
<>
  <PageHeader />                       ← top of page, ~48px
  <div className="min-h-0 flex-1">     ← starts BELOW the header
    <ScrollArea className="h-full">
      <div className="flex min-h-full">
        <section> ...list... </section>
        <aside>   ...panel... </aside>  ← lives inside the same scroll viewport
      </div>
    </ScrollArea>
  </div>
</>
```

Two real problems fall out of this:

1. **Top edge:** the panel starts below the `PageHeader`, leaving the breadcrumb bar awkwardly cantilevered over the panel's left edge. The user explicitly wants the panel to extend up to the page's true top edge (so the breadcrumb bar is purely a property of the list column).
2. **Bottom edge:** the panel is inside the `ScrollArea` viewport, and the inner flex container only enforces `min-h-full`. When the list is short, the panel stops at content-bottom instead of viewport-bottom. When the list is long, the panel *scrolls with the list* — which is also wrong (the panel has its own internal `ScrollArea` and should be a stationary docked column).

Recommended fix — promote the layout to a top-level horizontal split so the panel is a sibling of the entire "header + scrollable list" stack:

```tsx
return (
  <div className="flex h-full min-h-0">
    <section className="flex min-w-0 flex-1 flex-col">
      <PageHeader breadcrumbs={[{ label: "Automations" }]} />
      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
            {/* title, search, AutomationList */}
          </div>
        </ScrollArea>
      </div>
    </section>
    <aside
      className={cn(
        "hidden shrink-0 overflow-hidden border-l bg-background transition-[width] duration-200 ease-out lg:flex lg:flex-col",
        selectedAutomation ? "w-[36rem]" : "w-0",
      )}
      aria-hidden={!selectedAutomation}
    >
      {selectedAutomation ? <AutomationPanel ... /> : null}
    </aside>
    {/* Sheet + AlertDialog stay siblings of the flex row */}
  </div>
);
```

That gives you:
- Panel column extends from the page's true top edge to its true bottom edge (the parent `SidebarInset` in `src/routes/_app.tsx:220` is `h-svh`, so `h-full` on the page root fills the viewport).
- `PageHeader` lives inside the left section, so it's naturally constrained to the list column's width.
- Panel is stationary while the list scrolls — its internal `ScrollArea` at `automation-panel.tsx:239` handles overflow inside the column.

Also drop `lg:max-w-[calc(100%-36rem)]` from the section (`automations-client.tsx:405`) — it's redundant once `flex-1` is doing the work. The width animation on the `<aside>` (`w-0` → `w-[36rem]`) will smoothly shrink the list section because of `flex-1`.

### P1: Remove the active-row left accent line

`src/components/pages/automations/automation-row.tsx:180`:

```tsx
isSelected &&
  "bg-muted/70 before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-foreground/40",
```

The `before:*` rule paints a 2px left-edge accent on the selected row. The user wants only the `bg-muted/70` tint — the accent is redundant.

Recommended fix:

```tsx
isSelected && "bg-muted/70",
```

The `relative` on the row wrapper at line 178 can stay (other styling doesn't need it, but removing it changes nothing visible).

### P1: Panel header — remove the separator under the chip

`src/components/pages/automations/automation-panel.tsx:207`:

```tsx
<div className="flex shrink-0 items-center justify-between gap-3 border-b px-6 py-5">
  <AutomationTypeChip automation={automation} />
  ...kebab + close...
</div>
```

The `border-b` paints a horizontal divider between the chip row and the automation name below. The user wants the chip and title to feel like one block, not separated by a line.

Recommended fix: drop `border-b` from line 207. The existing `space-y-7` on the content wrapper at line 240 already provides ample vertical breathing room between the chip and the title.

### P1: Type chip needs a flatter, more muted style

The user attached a reference screenshot showing the desired chip:

- Less rounded corners (roughly `rounded-md`, not `rounded-full`).
- Subtle border instead of a filled secondary background.
- Muted foreground tone (text + icon both in `text-muted-foreground`).
- Taller and slightly more padded than the current `h-5`.

Current implementation at `automation-panel.tsx:119-135` uses `Badge variant="secondary"` which inherits `h-5 rounded-full bg-secondary text-secondary-foreground` plus a forced `[&>svg]:size-2.5!` from the Badge base CVA (`src/components/ui/badge.tsx:8`). That CVA's `!` defeats className overrides for the icon size, so trying to fix the chip by overriding Badge classes leads to a fight with the base styles.

Recommended fix: drop the `Badge` primitive for this chip and inline a small custom pill. That sidesteps the CVA fight and matches the screenshot directly:

```tsx
function AutomationTypeChip({ automation }: { automation: AutomationListItem }) {
  const Icon = automation.kind === "agent_task" ? MessageSquare : Code2;
  const label = automation.kind === "agent_task" ? "Agent task" : "Workflow";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2.5 py-1 text-xs font-normal text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        {TYPE_COPY[automation.kind]}
      </TooltipContent>
    </Tooltip>
  );
}
```

Knobs to tune against the screenshot:
- Border opacity — `border-border/60` is a softer hairline than the default `border` token. Bump to `border-border` if the border disappears against the panel background in light mode.
- Background — `bg-background/40` gives the subtle "card on card" feel from the screenshot. `bg-transparent` is also valid if you'd rather lean all-the-way muted.
- Padding — `px-2.5 py-1` puts it at ~28px tall, matching the screenshot's chip height.

### P1: Previous Runs — pulse the in-progress dot green, and center the dot row vertically

`src/components/pages/automations/automation-panel.tsx:82-92`:

```tsx
function RunDot({ status }: { status: AutomationRunSummary["status"] }) {
  const color =
    status === "success"
      ? "bg-emerald-500"
      : status === "error"
        ? "bg-red-500"
        : status === "question"
          ? "bg-amber-500"
          : "bg-muted-foreground";   ← "busy" and "started" fall here
  return <span className={cn("mt-1 size-1.5 rounded-full", color)} />;
}
```

And the row at `automation-panel.tsx:107`:

```tsx
<div key={run.id} className="flex items-start gap-2 text-sm">
```

Two bugs:

1. In-progress runs (`busy` / `started`) render a steady gray dot. They should be a pulsing green dot, matching the row-level `StatusDot` at `automation-row.tsx:39-43`.
2. The wrapper uses `items-start` and the dot uses `mt-1` to fake vertical centering against a single line of text. The math is slightly off (dot center sits ~3px above the text's optical center), which is what the user is seeing.

Recommended fix — split `RunDot` into the in-progress pulsing case + the static cases, and switch the wrapper to `items-center`:

```tsx
function RunDot({ status }: { status: AutomationRunSummary["status"] }) {
  if (status === "busy" || status === "started") {
    return (
      <span className="relative inline-flex size-1.5 shrink-0">
        <span className="absolute inset-0 inline-flex animate-ping rounded-full bg-emerald-500 opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
      </span>
    );
  }
  const color =
    status === "success"
      ? "bg-emerald-500"
      : status === "error"
        ? "bg-red-500"
        : status === "question"
          ? "bg-amber-500"
          : "bg-muted-foreground";
  return <span className={cn("size-1.5 rounded-full shrink-0", color)} />;
}
```

And at line 107:

```tsx
<div key={run.id} className="flex items-center gap-2 text-sm">
```

The `truncate` on the label span keeps it single-line, so `items-center` is safe and gives true vertical centering. Drop the `mt-1` from the dot since the wrapper now handles alignment.

While you're there: `runLabel` at line 74-80 returns `"Running"` for `busy` and `"Started"` for `started`. With a pulsing green dot they probably read better as `"Running"` for both — consider unifying.

### Nits

- The panel's title is `text-xl` (`automation-panel.tsx:242`); on a 36rem-wide panel a slightly bigger `text-2xl` reads more like a section heading. Optional.
- After the structural fix above, double-check the `width` transition on the `<aside>`. Going from `w-0` to `w-[36rem]` (`automations-client.tsx:471`) animates the chrome but the content inside renders only when `selectedAutomation` is truthy. There's a small pop on open as the panel's content appears. If it feels jarring, keep `<AutomationPanel>` mounted always (it's cheap) and let the parent's `w-0` clip it; the `overflow-hidden` you already have on the aside handles the visual.
- `MANAGE_DISABLED_MESSAGE` is referenced in `automation-row.tsx` and `automation-panel.tsx` — confirm it's defined in a shared location and not duplicated.

### What I verified looks good

- The R1 sheet/overlay fix landed cleanly: `showMobileSheet` at `automations-client.tsx:116` is correctly gated by `mounted && Boolean(selectedAutomation) && !isDesktop`, and `SheetContent` keeps its `lg:hidden`. ✓
- Inner column width was raised to `max-w-4xl` in both the client and the loading skeleton. ✓
- Disabled `Rename`/`Delete` menu items now wrap in a tooltip that surfaces the permission message via `ManagedMenuItem`. ✓
- Schedule formatter no longer appends `" UTC"` to every row's schedule string. ✓
