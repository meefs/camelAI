# Default Tooltip Restyle

## Context

The default tooltip component (used by icon-button hovers across the app)
currently inverts the user's theme: in light mode it renders a near-black
surface with white text; in dark mode the opposite. It was originally styled
that way to be eye-catching, but in practice it reads as sloppy and
inconsistent with the rest of the UI, which uses themed popovers/cards.

We also want a smaller, tighter tooltip with no pointer arrow.

**Out of scope.** Custom hover cards (e.g. the chat-group hover card,
context-indicator preview, etc.) are NOT tooltips — do not touch them.
Positioning/sizing logic (Radix portal, side detection, animations, max-width,
fit-content) is correct — do not touch it. We are only changing surface
colors, removing the arrow, and tightening the typography/padding/radius.

## File to change

Only [src/components/ui/tooltip.tsx](../src/components/ui/tooltip.tsx).
~300 `<TooltipContent>` call sites across ~73 files pick up the new defaults
automatically. A grep confirms no caller overrides colors, radius, padding, or
font size — overrides in the tree are limited to `max-w-xs break-words` /
`font-mono`, all of which compose cleanly with the new defaults.

## Visual target

```
BEFORE (light mode)                      AFTER (light mode)
┌───────────────────────┐                ┌─────────────────────┐
│  [ # ]  ← icon btn    │                │  [ # ]  ← icon btn  │
│    ╲                  │                │   ┌─────────────┐   │
│  ┌──▼──────────────┐  │                │   │ Open chat   │   │
│  │ ▲ dark bg       │  │   ───►         │   └─────────────┘   │
│  │   light text    │  │                │     ↑ themed         │
│  │   px-3 py-1.5   │  │                │       popover bg     │
│  │   rounded-md    │  │                │       border + shadow│
│  │   text-xs       │  │                │       px-2 py-1      │
│  └─────────────────┘  │                │       rounded-sm     │
│   ↑ arrow             │                │       text-[11px]    │
│   ↑ inverted colors   │                │       no arrow       │
└───────────────────────┘                └─────────────────────┘
```

In dark mode, "themed popover bg" means `--popover` (dark surface) with
`--popover-foreground` (light text) — i.e. it matches the surrounding chrome
instead of inverting away from it.

## Implementation

### 1) Update `TooltipContent` className

Current ([src/components/ui/tooltip.tsx:49](../src/components/ui/tooltip.tsx#L49)):

```tsx
className={cn(
  "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 rounded-md px-3 py-1.5 text-xs **:data-[slot=kbd]:rounded-md bg-foreground text-background z-50 w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin)",
  className
)}
```

New:

```tsx
className={cn(
  "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 rounded-sm border border-border bg-popover text-popover-foreground shadow-md px-2 py-1 text-[11px] leading-tight **:data-[slot=kbd]:rounded-sm z-50 w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin)",
  className
)}
```

Concrete diffs to make in that one className string:

- Replace `bg-foreground text-background` → `bg-popover text-popover-foreground`.
  - These are the existing shadcn theme tokens for "popover surface that
    matches the current theme." Both `:root` and `.dark` already define
    `--popover` and `--popover-foreground` in
    [src/styles/globals.css:146-147,180-181](../src/styles/globals.css#L146-L147).
- Add `border border-border shadow-md`.
  - In light mode, `--popover` is white; without a border + soft shadow it
    would dissolve into white parents. `shadow-md` matches what
    [src/components/ui/popover.tsx](../src/components/ui/popover.tsx) and
    `dropdown-menu.tsx` use, so tooltips will read as the same surface family
    as the rest of the chrome.
- Replace `rounded-md` → `rounded-sm`.
- Replace `px-3 py-1.5` → `px-2 py-1`.
- Replace `text-xs` → `text-[11px] leading-tight`.
  - `text-xs` is 12px; `text-[11px]` drops one notch. `leading-tight` keeps
    the box visually tight at the smaller size.
- Replace `**:data-[slot=kbd]:rounded-md` → `**:data-[slot=kbd]:rounded-sm`
  to keep nested `<kbd>` chips matching the new tooltip radius.

### 2) Remove the arrow

Delete this line at
[src/components/ui/tooltip.tsx:55](../src/components/ui/tooltip.tsx#L55):

```tsx
<TooltipPrimitive.Arrow className="size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground z-50 translate-y-[calc(-50%_-_2px)]" />
```

`TooltipPrimitive.Arrow` is a leaf element; removing it has no positioning
side effects on `TooltipPrimitive.Content`.

### 3) Bump `sideOffset` default from `0` → `4`

At [src/components/ui/tooltip.tsx:39](../src/components/ui/tooltip.tsx#L39):

```tsx
sideOffset = 0,
```

→

```tsx
sideOffset = 4,
```

Why: with the arrow present, the arrow itself created visual separation
between the tooltip rect and the trigger. With the arrow gone and
`sideOffset=0`, the rectangle sits flush against the icon, which reads as
glued-on. `4` (px) matches the spacing shadcn uses for `dropdown-menu` /
`popover` and gives the small breathing room the user described as "close to
the icon" without being touching.

This is overridable per call site (and a handful do pass their own
`sideOffset`), so it stays a default.

### Resulting file

After the edits, [src/components/ui/tooltip.tsx](../src/components/ui/tooltip.tsx)
should look like:

```tsx
function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 rounded-sm border border-border bg-popover text-popover-foreground shadow-md px-2 py-1 text-[11px] leading-tight **:data-[slot=kbd]:rounded-sm z-50 w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin)",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}
```

(Imports and the other exported pieces — `TooltipProvider`, `Tooltip`,
`TooltipTrigger` — are unchanged.)

## Tokens / design references

- Surface colors: `--popover` / `--popover-foreground`
  ([globals.css:146-147](../src/styles/globals.css#L146-L147) light;
  [globals.css:180-181](../src/styles/globals.css#L180-L181) dark).
- Border token: `--border`
  ([globals.css:157](../src/styles/globals.css#L157),
  [globals.css:191](../src/styles/globals.css#L191)).
- Same surface treatment as
  [src/components/ui/popover.tsx](../src/components/ui/popover.tsx) and
  [src/components/ui/dropdown-menu.tsx](../src/components/ui/dropdown-menu.tsx)
  — tooltips will now sit in the same visual family.

## Don't do this

- Don't change `TooltipProvider`, `Tooltip`, or `TooltipTrigger`.
- Don't change the animation classes, `data-[side=...]` slide-in classes,
  `max-w-xs`, `w-fit`, `z-50`, or `origin-(--radix-tooltip-content-transform-origin)`.
- Don't add `delayDuration` changes; current `delayDuration={0}` is intentional.
- Don't hunt down individual `<TooltipContent>` call sites to update them —
  the goal is for the new defaults to apply uniformly. The two existing
  className overrides in the tree (`max-w-xs break-words`,
  `max-w-xs break-words font-mono`) are still valid and should remain.
- Don't touch any of the bespoke hover cards (e.g.
  [src/components/chat-group-hover-card.tsx](../src/components/chat-group-hover-card.tsx)).
  These are not built on `TooltipContent` and are out of scope.

## Verification

1. `bun run typecheck` — must be clean.
2. `bun run lint` — must be clean.
3. `bun run dev` and visually spot-check tooltips in both light and dark mode
   on at least:
   - Chat tab bar icon buttons
     ([src/components/chat-tab-bar.tsx](../src/components/chat-tab-bar.tsx))
   - Prompt input toolbar buttons
     ([src/components/prompt-input.tsx](../src/components/prompt-input.tsx))
   - Sidebar collapse/new-chat affordances
     ([src/components/ui/sidebar.tsx](../src/components/ui/sidebar.tsx))
   - Message bubble action row
     ([src/components/message-bubble.tsx](../src/components/message-bubble.tsx))

   Confirm: (a) tooltip background matches current theme (light surface in
   light mode, dark surface in dark mode); (b) no arrow; (c) tooltip is
   visibly smaller — tighter padding, smaller text, smaller corner radius;
   (d) a small gap remains between tooltip and trigger; (e) positioning still
   flips sides correctly near viewport edges (this is Radix's behavior and
   should be unaffected, but worth eyeballing).
4. Spot-check the two existing className-overridden tooltips render fine:
   - [src/components/tool-call/details/shared.tsx](../src/components/tool-call/details/shared.tsx)
     (tool-call truncated text tooltips)
   - [src/routes/_admin.apps.tsx](../src/routes/_admin.apps.tsx)
     (admin apps page, font-mono tooltip)
