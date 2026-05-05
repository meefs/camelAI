# Connection Mention Menu — Restyle Plan

**Date:** 2026-05-01
**Branch:** `illianaa/connection-menu-restyle` (suggested)
**Primary files:**
- [src/components/connection-mention-menu/index.tsx](../src/components/connection-mention-menu/index.tsx) — popover + Command list
- [src/components/prompt-input.tsx](../src/components/prompt-input.tsx) — anchor wrapper, width measurement
- (no changes expected to) [src/components/connection-mention-menu/use-mention-trigger.ts](../src/components/connection-mention-menu/use-mention-trigger.ts), [src/components/connection-mention-menu/composer-mention-overlay.tsx](../src/components/connection-mention-menu/composer-mention-overlay.tsx)

---

## Objective

Restyle the `@`-mention connection menu (popover that appears above the chat composer) so it:

1. **Spans the full width of the chat input field**, dynamically — the input width changes when the user resizes the app preview pane, and the menu must follow.
2. **Right-aligns the connection type label** so each row reads as `[icon] [name] ........................ [type]`, mirroring the file/path layout in the inspiration screenshot ([VSCode native extension's `@` file picker](https://code.visualstudio.com/) — file name on left, path on right).

Behavior (filter, keyboard nav, selection, dismissal, zero-state, slug insert) does not change. This is a **styling-only** pass.

---

## Current state

The menu renders as a fixed-width Slack-style popover anchored to the composer's wrapper:

- [src/components/connection-mention-menu/index.tsx:118](../src/components/connection-mention-menu/index.tsx#L118) — `<PopoverContent className="w-[280px] ...">` — fixed 280px width regardless of composer width.
- [src/components/connection-mention-menu/index.tsx:148](../src/components/connection-mention-menu/index.tsx#L148) — `<CommandItem className="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer">` — three children laid out with `gap-2`:
  - Icon (`size-4 shrink-0`)
  - Name (`min-w-0 truncate font-medium`)
  - Type label (`shrink-0 text-xs text-muted-foreground`)
- The type label sits **immediately after** the name (separated by `gap-2`), not pushed to the right edge — because the name span is not `flex-1`.

The popover is anchored via a `<PopoverAnchor virtualRef={anchorRef}>` where `anchorRef` is the wrapper `<div>` around the entire `InputGroup` ([src/components/prompt-input.tsx:449-458](../src/components/prompt-input.tsx#L449-L458)). That wrapper already spans the full composer width, so the popover *positioning* is already aligned to the composer's left edge — only its **width** is fixed.

---

## Visual design

### Goal layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ Chat                                                                   │
│ ...                                                                    │
│ ╭──────────────────────────────────────────────────────────────────╮   │
│ │ 🐘  My Prod DB                                          Postgres │ ← highlighted row
│ │ 🐘  Staging DB                                          Postgres │
│ │ 💳  Stripe Live                                          Stripe  │
│ │ 💬  Slack                                                Slack   │
│ │ 📊  Looker production warehouse                          Looker  │ ← long name truncates with ellipsis before pushing type off-screen
│ ╰──────────────────────────────────────────────────────────────────╯   │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ Update sales dashboard from @                                  ↑ │   │ ← composer textarea
│ └──────────────────────────────────────────────────────────────────┘   │
│ [+] [/]                                          [model ▾]   [↑ send] │
└────────────────────────────────────────────────────────────────────────┘
```

Key visual changes versus today:

| Property | Today | New |
|---|---|---|
| Width | Fixed `280px` | Matches composer wrapper width (dynamic) |
| Type label position | Adjacent to name | Right-aligned to row's trailing edge |
| Name truncation | Truncates only when row width forces it | Truncates before colliding with the type label |
| Padding (horizontal) | `px-2` | `px-3` (matches the textarea's visual gutter better at full width) |
| Row vertical padding | `py-1.5` | unchanged (`py-1.5`) |
| Row height | ~32px | unchanged |
| Max visible rows | `max-h-[200px]` | unchanged |
| Border radius / shadow | `rounded-md` + `shadow-md` | unchanged |
| Add-connection (zero-state) row | unchanged | unchanged |

### Narrow / wide states

When the user shrinks the preview pane and the composer is very narrow (e.g. <320px), the menu still spans the full composer width. When very wide (e.g. >800px), the menu is also that wide — accept that this is wider than typical autocomplete menus; the screenshot inspiration explicitly does this and the user has asked for it.

A small **floor** is sensible to prevent the menu becoming unusably narrow: `min-w-[240px]`. A **ceiling** is intentionally not applied — match composer width without capping.

---

## Implementation

### 1. Make the popover width track the composer width

The `<PopoverAnchor virtualRef={anchorRef}>` is mounted on the composer wrapper. Two options:

**Option A — preferred: ResizeObserver + inline style.**

In `ConnectionMentionMenu`, add a `useState<number | null>` for `anchorWidth`. On open, observe the anchor element with `ResizeObserver` and write its `clientWidth` into state. Pass it as inline style on `<PopoverContent>`:

```tsx
const [anchorWidth, setAnchorWidth] = useState<number | null>(null);

useLayoutEffect(() => {
  if (!open) return;
  const el = anchorRef.current;
  if (!el || typeof ResizeObserver === 'undefined') return;
  const update = () => setAnchorWidth(el.clientWidth);
  update();
  const observer = new ResizeObserver(update);
  observer.observe(el);
  return () => observer.disconnect();
}, [open, anchorRef]);

// ...
<PopoverContent
  // existing props...
  style={anchorWidth ? { width: `${anchorWidth}px` } : undefined}
  className="min-w-[240px] p-0 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
>
```

Notes:
- Replace `w-[280px]` with `min-w-[240px]` in the className. The inline `width` style takes precedence and will set the actual width once measured. The `min-w-[240px]` is the safety floor for the first paint frame before the observer fires.
- Use `useLayoutEffect` (not `useEffect`) so the first measurement happens before paint — avoids a one-frame flash at 240px when the menu opens.
- Prefer `clientWidth` over `getBoundingClientRect().width` so the value is whole pixels (no subpixel popover edges).
- Tear down the observer in the cleanup. Re-create it on every `open` toggle (the effect dep on `open` handles this).

**Option B — fallback: Radix CSS variable.**

Radix exposes `--radix-popover-trigger-width` based on the anchor element. With `<PopoverAnchor virtualRef={...}>` this *should* still be set. If the implementer confirms the variable is populated by Radix's current version (`radix-ui` package — see [src/components/ui/popover.tsx:4](../src/components/ui/popover.tsx#L4)), they can use:

```tsx
className="w-[var(--radix-popover-trigger-width)] min-w-[240px] ..."
```

…and skip the ResizeObserver entirely. **Verify in the browser before committing** — the variable being unset would silently collapse the popover to its `min-w` floor.

If the variable is reliably set, prefer Option B for simplicity. If not, ship Option A. Either is acceptable.

### 2. Right-align the type label inside each row

In [src/components/connection-mention-menu/index.tsx:148-159](../src/components/connection-mention-menu/index.tsx#L148-L159), change the row markup:

```tsx
<CommandItem
  key={c.id}
  value={c.id}
  onSelect={() => onSelect(c)}
  className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
>
  <IntegrationIcon
    type={c.integration_type}
    size={16}
    className="size-4 shrink-0"
  />
  <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
  <span className="shrink-0 pl-3 text-xs text-muted-foreground">
    {def?.displayName ?? c.integration_type}
  </span>
</CommandItem>
```

What changed and why:

- Name span: added `flex-1`. This makes the name grow to fill the available row width, pushing the type label to the right edge. `min-w-0 truncate` continues to clip long names with an ellipsis instead of overflowing.
- Type span: added `pl-3` to give a guaranteed visible gap between the truncated name's ellipsis and the type label (the ellipsis can sit very close to the trailing edge of the name span otherwise). `gap-2` between flex children stays in place; `pl-3` is additional only on this side.
- Row padding: `px-2` → `px-3`. The wider menu makes `px-2` feel pinched at the edges; `px-3` aligns the icon roughly with the textarea's visible left edge at most composer widths. (If after visual review this looks misaligned, fall back to `px-2`. This is a judgment call — verify in the browser.)
- `gap-2` between icon and name is preserved.

The zero-state "Add a connection" row ([src/components/connection-mention-menu/index.tsx:128-139](../src/components/connection-mention-menu/index.tsx#L128-L139)) also gets the `px-3` change for consistency, but no `flex-1` / right-alignment work — it has only an icon and a label.

### 3. Nothing else changes

Explicitly **do not** modify:
- `useMentionTrigger` behavior or open/close conditions.
- The slug insertion logic in `prompt-input.tsx`.
- The composer's chip overlay (`composer-mention-overlay.tsx`) — it is layered on the textarea, not the menu, and is unrelated to this restyle.
- The mention chip styling inside sent message bubbles ([src/components/connection-mention-menu/mention-chip.tsx](../src/components/connection-mention-menu/mention-chip.tsx)).
- The keyboard nav / focus / `onOpenAutoFocus` plumbing.
- The `onPointerDownOutside` handling that lets the textarea stay clickable while the menu is open.

---

## Edge cases & verification

| Case | Expected behavior |
|---|---|
| Composer width changes mid-typing (user drags the preview pane divider) | Menu width updates within one frame as the `ResizeObserver` fires. |
| Composer is very narrow (e.g. 220px during a heavy resize) | Menu width clamps to `min-w-[240px]`. May extend slightly past the composer's right edge during the brief transient — acceptable. |
| Long connection name (e.g. `"Looker production warehouse — read replica"`) | Name truncates with ellipsis. Type label remains pinned to the right edge, fully readable. |
| Long type display name (rare — `displayName` is short for all current registry entries) | Type label keeps its full width (`shrink-0`). Name truncates earlier to make room. |
| Zero-connections (Add-a-connection row) | Row uses the same `px-3` padding; layout is unchanged otherwise. Width still tracks the composer. |
| Menu opens just after composer mount (anchor not yet in DOM) | First paint uses `min-w-[240px]`; observer fires within a frame and the menu jumps to full width. Acceptable since the menu is only visible once the user types `@`, after the composer has long mounted. |
| Dark mode / light mode | No new colors introduced; uses existing `bg-popover`, `text-popover-foreground`, `text-muted-foreground`, `border-border`, `bg-accent`. No visual regressions. |
| Tooltips / hover behavior | Untouched — the menu rows have no tooltips. Composer chips and message-bubble chips already have their own hover content via `composer-mention-overlay.tsx` / `mention-chip.tsx`. |

---

## Verification checklist

- [ ] With the composer at default width, the menu spans the full visible width of the composer wrapper (left edge of menu aligned with composer's left edge; right edge aligned with composer's right edge — modulo the menu's border).
- [ ] Resizing the preview pane while the menu is open causes the menu to resize in lockstep (visually smooth, no lag beyond the next paint).
- [ ] At every menu width, each row shows the connection name on the left and the type label flush against the right edge (with `pl-3` of breathing room).
- [ ] A long connection name truncates with an ellipsis instead of pushing the type label off-screen or wrapping the row.
- [ ] At very narrow composer widths the menu honors `min-w-[240px]`.
- [ ] Zero-connections "Add a connection" row matches the new horizontal padding.
- [ ] Selected/highlighted row still uses `data-[selected=true]:bg-accent` styling — unchanged.
- [ ] Keyboard navigation (`↑/↓/Enter/Escape/Tab`), filter typing, slug insertion, and outside-click dismiss are all unchanged.
- [ ] `bun run typecheck` passes (no new type errors introduced by this change).
- [ ] `bun run lint` passes.
- [ ] Existing mention tests still pass: `bun run test:run tests/connection-mentions.test.ts tests/markdown-renderer.test.ts tests/message-bubble-content-to-string.test.ts` (no test changes expected since this is purely visual).

---

## Out of scope

- Any change to the **chip overlay inside the textarea** while typing (`composer-mention-overlay.tsx`).
- Any change to the **rendered chip in sent message bubbles** (`mention-chip.tsx`).
- Adding a header, search input, footer, or grouping to the menu.
- Adding row metadata beyond `[icon] [name] [type]` (no "last used", no credentials warning, no description).
- Changing the popover's open/close conditions or anchor.
- Restyling the composer itself.
