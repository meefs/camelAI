# Automations Tab Implementation Review

**Date:** 2026-05-28
**Scope:** local diff in `automations-tab-plan` workspace, including new `/automations` route, UI components, `WorkspaceCronDO` run history, and `ChatThreadDO` runtime status changes.

## Findings

### P1: Desktop row selection opens an invisible mobile Sheet overlay

`src/components/pages/automations/automations-client.tsx:469` opens the `Sheet` whenever `selectedAutomation` exists. On desktop, the split-panel `<aside>` is visible, but the Sheet is still mounted/open; only `SheetContent` has `lg:hidden` at `src/components/pages/automations/automations-client.tsx:475`. The shared Sheet implementation always renders `SheetOverlay` inside the portal (`src/components/ui/sheet.tsx:56`), and that overlay is fixed `inset-0 z-50` (`src/components/ui/sheet.tsx:37`).

Result: selecting a row on desktop will show the intended push-split panel behind a modal overlay/focus trap. The user will not be able to interact with the list/panel the way the spec requires.

Recommended fix: only render/open the Sheet below `lg`. Use a media-query hook or CSS-backed state, for example `const isDesktop = useMediaQuery("(min-width: 1024px)")`, then `open={Boolean(selectedAutomation) && !isDesktop}`. Alternatively render the Sheet subtree only in a mobile-only component that is not mounted at desktop widths.

### P1: Accepted scheduled-prompt runs are reported as `busy`

`WorkspaceCronDO.dispatchPrompt()` maps `ChatThreadDO.startInitialUserMessage()` status `"accepted"` to scheduler status `"busy"` at `workers/main/src/workspace-cron.ts:953`. That value is then persisted as `scheduled_prompts.last_run_status` and returned from `runScheduledPromptNow()` at `workers/main/src/workspace-cron.ts:1567`. It also flows into the existing code-mode/MCP tool response at `workers/main/src/code-mode-scheduled-prompts.ts:123`.

This changes the public meaning of `busy`. Before this diff, `busy` meant "thread is busy with another run." After this diff, a successfully accepted run is reported as busy until the async completion callback records success. That can mislead agents/tools calling `run_scheduled_prompt_now`, and it leaves persisted state wrong if the completion callback is missed.

Recommended fix: do not reuse `busy` for accepted work. Either:

- add a real `started` status to scheduled prompt run state and update all type unions/formatters/tool output to understand it, or
- keep dispatch status as `success` for "accepted" and rely on the new runtime overlay/run-history row to show "running now" in the Automations UI.

The second option is the smaller compatibility-preserving fix.

## Test Gaps

- The new scheduler test manually calls `recordScheduledPromptRunResult()`, so it does not prove the `WorkspaceCronDO -> ChatThreadDO -> WorkspaceCronDO` lifecycle actually records success/question/error for a real scheduled prompt turn.
- There is no UI/browser coverage for the desktop push-split plus mobile Sheet fallback. A simple Playwright check that selects a row at desktop width would catch the overlay issue above.
- The disabled `Rename`/`Delete` menu items do not provide the same explicit permission tooltip that Run/Pause controls do. This is minor, but it misses the plan's "clear tooltip" acceptance criterion for mutating controls.

## Verification Run

- `bun run typecheck` passed.
- `bun run test:workers -- workspace-cron.test.ts` passed.

---

## UI Review (added 2026-05-28)

These notes focus on the visual/UX layer. They are additive to the codex P1 findings above — none of them repeat what's already flagged there.

### P1: Inner column width should match the chat history page

`src/components/pages/automations/automations-client.tsx:385` and `src/components/pages/automations/automations-loading.tsx:12` cap the inner column at `max-w-2xl` (672px). The chat history page (`src/components/pages/history/history-client.tsx:383`) uses `max-w-4xl` (896px) and is the visual peer we want to match — both are vertical lists of workspace artefacts.

The plan I authored originally specified `max-w-2xl`, but on real screens that feels noticeably narrower than `/history` and breaks the "this is the same kind of page" expectation set by the sidebar grouping.

Recommended fix:

- `src/components/pages/automations/automations-client.tsx:385`: change `max-w-2xl` → `max-w-4xl`.
- `src/components/pages/automations/automations-loading.tsx:12`: change `max-w-2xl` → `max-w-4xl`.
- Re-check `src/components/pages/automations/automations-client.tsx:382` (`lg:max-w-[calc(100%-36rem)]`) — it should still behave correctly because the new `max-w-4xl` is the dominant constraint inside the calc, but verify the slide animation still feels right when the panel opens at 1280–1440px widths.

### P0 (acknowledged, defer): push-split panel not visually testable yet

Per codex's P1 finding above, the desktop Sheet overlay is currently hiding the push-split panel on every selection. I was not able to visually evaluate the panel-open state, the panel header alignment, the schedule-row vs. action-row crossfade with the panel showing, or the responsive transition between split and Sheet modes.

Expect a separate iteration of panel-specific UI feedback once the Sheet is gated by `(min-width: 1024px)`. **Do not** rework the panel preemptively — fix the overlay first, then we'll review.

### P2: Every schedule string carries a redundant " UTC" suffix

`formatCronExpression` in `src/lib/automations-shared.ts:60` defaults `timezoneLabel` to `"UTC"`, and both call sites (`automation-row.tsx:116`, `automation-panel.tsx:283`) use the default. Result: every row reads `"Daily at 9:00 AM UTC"` and the panel's `Repeats` row reads the same. The spec screenshots show no timezone tag — just `"Daily at 9:00 AM"`.

Why this matters: in the row, the schedule is the only thing to the right of the name, and `" UTC"` lengthens it just enough to crowd the action-icon slot when names are long. In the panel's `Repeats` row, it's redundant because the `Next run` line right below already prints the absolute time *with* the timezone via `Intl.DateTimeFormat`.

Recommended fix: drop the timezone from `formatCronExpression`'s default. Either:

- Pass `{ timezoneLabel: undefined }` (or `""`) at both call sites, **or**
- Flip the default to `undefined` in the helper and let callers opt in.

Prefer changing the default — it matches the design and there's currently no surface that asks for the suffix.

### P2: Panel header chip and icon buttons are vertically misaligned

`src/components/pages/automations/automation-panel.tsx:167` uses `flex items-start` on the panel header. The left child is a `Badge` (height ≈ 22px); the right cluster is two `size="icon"` `Button`s (height ≈ 36px). With `items-start` they're anchored at the top edge, which leaves the chip looking floated up versus the buttons' optical centers.

Recommended fix: change `items-start` to `items-center` at `automation-panel.tsx:167`. The kebab and X then sit on the chip's horizontal axis.

### P2: Empty-state CTA is missing the leading `+` icon

The header `New automation` button at `automations-client.tsx:393` renders `<Plus />` + label. The empty-state CTA at `automation-list.tsx:58` is the same destination action but is just `<Button>New automation</Button>` — no icon.

Recommended fix: import `Plus` from `lucide-react` in `automation-list.tsx` and put `<Plus />` before `New automation` so the two entry points read as the same affordance.

### P3: Inline rename keyed by `id` only when reading the value

`automation-list.tsx:83` reads `renameValue={renaming?.id === automation.id ? renaming.value : automation.name}` — it doesn't also check `renaming.kind`. The activation check at line 80 correctly uses `id && kind`, but the value lookup doesn't. If a workflow and an agent task ever share an id (rare today; not enforced by the type system), the wrong row could flash the rename buffer.

Recommended fix: also check kind when reading the value: `renaming?.id === automation.id && renaming.kind === automation.kind ? renaming.value : automation.name`.

### P3: Permission-disabled `Rename`/`Delete` menu items don't surface a reason

Codex's Test Gaps section already calls this out. To be explicit on the UI side: the `DropdownMenuItem`s at `automation-row.tsx:240` and `:250` (and the panel equivalents at `automation-panel.tsx:177` and `:184`) become greyed-out when `manageDisabled` is true, but there's no tooltip explaining *why*. Row-level `Run`/`Open` and panel-level `Switch`/`Run now`/`Open` all use a wrapping `<span>` + disabled-only `TooltipContent` pattern; the menu items should follow suit.

Recommended fix: in both files, wrap the disabled `DropdownMenuItem` in a `Tooltip` whose `TooltipContent` reads `"You do not have permission to manage this automation"` and only renders when `manageDisabled`. Radix `DropdownMenuItem` propagates `pointer-events: none` while disabled, so the trigger needs to be the wrapping `<span>` like elsewhere.

### Nits (no action required unless they bother you)

- `automation-list.tsx:50` uses `mt-24` for the empty state — generous, but works. The history page's empty state uses `py-16`; either is fine.
- `automation-list.tsx:51` uses `size-20` (80px) for the empty-state icon wrapper; the plan suggested `p-4` (~56px). Both read as "centered illustration" — the larger size is fine but slightly more assertive than `/history`'s pattern.
- `automation-panel.tsx:202` uses `text-xl` for the automation name; the spec screenshots use slightly larger — `text-2xl` would match `/connections` and `/apps` H1 visual weight. Minor.
- `automation-panel.tsx:286` shows `"Paused"` in the `Next run` row when the automation is disabled, which duplicates the `Active`/`Paused` indicator above. Could be `—` instead to avoid restating state.
- `formatRelativeTime` at `automation-panel.tsx:34` uses `Intl.RelativeTimeFormat` which produces `"in 3 days"` for future times. The `Last ran` row should never see a future timestamp, so this is fine — but if you ever feed `next_run_at` through it, watch for the "in N" prefix.

### What I verified looks good

- Sidebar entry at `app-sidebar.tsx:182` is wired with `Clock` icon and `isActive` check, ordered after `Apps`. ✓
- Status dot precedence in `automations-shared.ts:123` correctly resolves `needs_input > failed > running`, matching the spec. ✓
- The `running` dot uses `animate-ping` overlaid on a solid dot — pulse is soft, not jarring. ✓
- The row's schedule↔actions crossfade uses absolute-positioned siblings and `transition-opacity duration-100`, so there's no layout shift. ✓
- `Sheet` content includes `SheetTitle`/`SheetDescription` (sr-only) for screen-reader compliance. ✓
- Inline rename mirrors the chat-row pattern (Enter saves, Esc cancels, outside-pointerdown commits). ✓
- `body_label` (`"Prompt"` vs `"Description"`) is data-driven, not branch-on-kind in the JSX. ✓
- `AlertDialog` delete-confirm copy correctly varies by kind. ✓
- Deep-link via `?selected=<id>` works and the loader-mismatch effect at `automations-client.tsx:104` cleans up stale selections without flashing the panel. ✓
