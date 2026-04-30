# @ Mention Menu — Iteration 2 Feedback

**Date:** 2026-04-29
**Branch:** `illianaa/at-menu-connections`
**Reviewing commit:** `89dcbfd8 Iterate on @-mention menu based on feedback`

---

## What was fixed

The previous round landed cleanly:

- ✅ Connections now load in `_app.chat.$id.tsx`'s loader and pipe through to `<Chat>` via a dedicated `connections?: Integration[]` prop, so the active-thread composer sees real data.
- ✅ Welcome screen passes `mentionableConnections` + `onMentionAddNewClick` through to its `<PromptInput>`.
- ✅ Both routes navigate to `/connections` (not `/settings/workspace/connections`).
- ✅ `rankMentionableConnections` extracted to `src/lib/connection-mentions.ts` and used by both the menu and the parent's keyboard handler — highlight and Enter-target now agree.
- ✅ Pending-message sessionStorage payload also carries `connections` for the welcome → new-thread navigation.

The user confirms that the menu now populates correctly. The remaining issues are visual / interaction polish.

---

## Issues to address (in priority order)

### Issue 1 — Menu pops below the textarea on the welcome screen

The welcome screen sits roughly in the vertical center of the viewport. Radix's collision detection sees the 240px popover wouldn't fit above on shorter viewports and **flips it below** the textarea. That looks wrong — the menu obscures content beneath the input and feels disconnected from the `@` the user just typed.

Two coordinated changes:

**(a) Reduce the popover max height** so it fits above the textarea even on the welcome screen.

`src/components/connection-mention-menu/index.tsx:104`:

```tsx
// before
<CommandList className="max-h-[240px] py-1">

// after
<CommandList className="max-h-[200px] py-1">
```

Each row at `px-2 py-1.5` + `text-sm` is ~32px tall. With `py-1` (8px total) on the list, `max-h-[200px]` fits exactly 6 rows visibly with the 6th showing a peek-of-overflow scroll affordance. That comfortably exceeds the user's "at least 5 connections" requirement.

**(b) Force the popover to anchor above** so it doesn't flip on viewport size:

`src/components/connection-mention-menu/index.tsx:81-83`:

```tsx
<PopoverContent
  side="top"
  align="start"
  sideOffset={4}
  avoidCollisions={false}        // ← add this
  collisionPadding={8}             // ← optional, see note
  ...
```

`avoidCollisions={false}` tells Radix to keep the menu on `side="top"` regardless of viewport space. Combined with the smaller `max-h-[200px]`, the menu always sits cleanly above the input.

**Note on extreme-edge case:** if the user's viewport is so short that 200px above the textarea would render off the top of the screen, the menu will clip. That's acceptable — it matches Slack's behavior, and the user already noted "we have some room on top because we already have that header and breadcrumb above." If you want to be defensive, leave `collisionPadding={8}` so the menu nudges down to stay on-screen but never flips to the bottom side.

---

### Issue 2 — Rendered chip in the **textarea** has no visual distinction

Today the textarea is a plain `<textarea>` showing literal `@my_prod_db` text — no chip, no bg, no weight differentiation. The user wants a chip rendered inline **inside the composer**, with:

- a **subtle background fill** (no outline)
- rounded corners
- minimal padding so line spacing isn't disturbed
- text one weight heavier than surrounding body text

A native `<textarea>` cannot render rich content. The standard pattern (used by react-mentions, Discord, Slack) is a **textarea + transparent-text overlay** that mirrors the textarea's text and renders chips on top. The textarea remains the source of truth for value/selection/IME — only the visible text is supplied by the overlay.

#### Implementation

Wrap the existing `<InputGroupTextarea>` in a positioned container and add an aria-hidden overlay div that renders the same string as styled tokens.

`src/components/prompt-input.tsx`, around line ~481 (the `InputGroupTextarea` call):

```tsx
<div className="relative">
  {/* Overlay: shows the styled version of `value` */}
  <div
    aria-hidden
    ref={overlayRef}
    className={cn(
      // Must match the textarea's box exactly.
      'pointer-events-none absolute inset-0 overflow-hidden',
      'whitespace-pre-wrap break-words',
      'p-3.5 text-base md:text-base max-h-96',
      // Same font as the textarea so glyph widths align character-for-character.
      'font-[inherit] leading-[inherit] tracking-[inherit]',
      // Hide the overlay's own contribution to layout — the textarea below
      // is what determines height; the overlay just paints over it.
    )}
  >
    {renderComposerTokens(value, slugMap)}
  </div>

  <InputGroupTextarea
    ref={effectiveTextareaRef}
    value={value}
    onChange={...}
    onScroll={(e) => {
      // Keep overlay scrolled in lockstep with the textarea.
      if (overlayRef.current) {
        overlayRef.current.scrollTop = e.currentTarget.scrollTop;
      }
    }}
    style={{
      // Hide the textarea's own glyphs so the overlay shows through.
      // Caret stays visible because caret-color is independent.
      color: 'transparent',
      caretColor: 'var(--foreground)',
    }}
    className={cn(
      // Important: same padding, font, line-height, letter-spacing as overlay.
      'text-base md:text-base p-3.5 max-h-96 overflow-y-auto',
      // Selection highlight needs explicit color since text is transparent.
      'selection:bg-primary/30 selection:text-transparent',
      isActiveRecording && 'opacity-50'
    )}
    /* …all existing props… */
  />
</div>
```

Add `renderComposerTokens` to `src/lib/connection-mentions.ts` (or a small new file) — it walks the same token boundaries `parseMentions` uses and returns an array of strings + `<ComposerChip>` nodes:

```tsx
import { parseMentions, type MentionableIntegration } from '@/lib/connection-mentions';

export function renderComposerTokens(
  value: string,
  slugMap: Map<string, MentionableIntegration>,
): React.ReactNode[] {
  if (!value) return [];
  const matches = parseMentions(value, slugMap);
  const out: React.ReactNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.integration === null) continue;          // unmatched: leave as plain text
    if (match.index > cursor) {
      out.push(value.slice(cursor, match.index));
    }
    out.push(
      <ComposerChip
        key={`${match.index}-${match.slug}`}
        slug={match.slug}
        integration={match.integration}
      />,
    );
    cursor = match.index + match.length;
  }
  if (cursor < value.length) {
    out.push(value.slice(cursor));
  }
  return out;
}
```

**`<ComposerChip>` styling — exact classes:**

```tsx
'use client';

import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { IntegrationIcon } from '@/lib/integration-icons';
import type { Integration } from '@/types';

const COMPOSER_CHIP_CLASS =
  // No border, subtle bg, rounded, minimal padding so line-height doesn't shift.
  'rounded-md bg-muted px-1 py-0 -mx-0.5 ' +
  // One weight heavier than body — the textarea body is `font-normal`, so:
  'font-semibold text-foreground';

export function ComposerChip({ slug, integration }: { slug: string; integration: Integration }) {
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className={COMPOSER_CHIP_CLASS}>@{slug}</span>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        className="w-auto min-w-[200px] max-w-[280px] p-2"
      >
        <ChipHoverPreview integration={integration} />
      </HoverCardContent>
    </HoverCard>
  );
}
```

Critical styling rules (the implementation agent must not change these):

- `bg-muted` — the design-system "subtle gray" token. No outline, no border.
- `rounded-md` — matches the @ menu rows, looks like a related family.
- `px-1 py-0` — horizontal padding only; vertical padding is **zero** so the chip's box height equals the surrounding text's line-height. This is essential: any vertical padding breaks the line-by-line alignment between the overlay and the textarea, and the user will see jitter.
- `-mx-0.5` — pull the chip's edges back into the surrounding text by 2px so the chip's left/right padding doesn't visibly add space (the textarea has no equivalent inset, so the overlay would otherwise shift glyphs right of the chip).
- `font-semibold` — body text in the textarea is `font-normal` (per `prompt-input.tsx`'s `text-base` default). One step heavier = `font-semibold`. **Do not use `font-bold`.**
- The chip's text is the same `text-base` size as the surrounding text — do **not** scale it down. Identical glyph metrics are what keeps the overlay aligned with the hidden textarea.

**Hover state** — the user clarified that the hover state belongs on the **composer chip**, not the sent-message chip. Use shadcn `HoverCard` (install if not present: `bunx shadcn@latest add hover-card`). It's the right primitive — pointer hover + delay + collision-aware popover, no click required. See section "ChipHoverPreview" below for the content.

---

### Issue 3 — Sent-message chip looks bad and shouldn't have a tooltip

`src/components/connection-mention-menu/mention-chip.tsx` currently renders an outlined chip wrapped in a `<Tooltip>`. The user wants:

- **Remove the tooltip entirely** from the sent-message chip.
- **Restyle the chip** to use the same visual language as the @ menu rows (subtle bg, rounded), but kept inline-text-sized.

#### Replacement implementation

Replace the entire body of `mention-chip.tsx` with:

```tsx
'use client';

import { IntegrationIcon } from '@/lib/integration-icons';
import type { Integration } from '@/types';
import { cn } from '@/lib/utils';

interface MentionChipProps {
  slug: string;
  integration: Integration | null;
}

const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-md px-1 py-0 -mx-0.5 ' +
  'align-baseline text-[0.95em] font-semibold leading-[inherit] cursor-default';
const CHIP_LIVE = 'bg-muted text-foreground';
const CHIP_DELETED = 'bg-muted/60 text-muted-foreground';

export function MentionChip({ slug, integration }: MentionChipProps) {
  const isDeleted = integration === null;
  return (
    <span className={cn(CHIP_BASE, isDeleted ? CHIP_DELETED : CHIP_LIVE)}>
      {integration && (
        <IntegrationIcon
          type={integration.integration_type}
          size={12}
          className="size-3 shrink-0 opacity-70"
        />
      )}
      <span>@{slug}</span>
    </span>
  );
}
```

Styling rules:

- `bg-muted` (live) / `bg-muted/60` (deleted) — same family as the composer chip.
- **No border, no outline, no tooltip, no `<Tooltip>` wrapper** — the user explicitly asked for the tooltip removed.
- `font-semibold` — matches the composer chip.
- `py-0` keeps the chip from stretching the message bubble's line-height.
- Drop the `border-dashed` deleted-state treatment; use a slightly dimmer bg + muted text instead.
- Remove the unused imports (`Tooltip`, `TooltipContent`, `TooltipTrigger`, `getIntegrationDefinition`, `categoryLabel`, `CATEGORY_TAB_LABELS`, `IntegrationCategory`).

The `MentionChip` callers in `message-bubble.tsx` and the markdown renderer don't need to change — same component, smaller surface area.

---

### Issue 4 — `ChipHoverPreview`: what to show in the composer chip's hover popover

The user is happy with the existing fields (icon + connection name + integration type + category) and asks what other queryable fields exist on `Integration`.

From `src/types.ts:408-419`:

```ts
export interface Integration {
  id: string;
  integration_type: string;
  name: string;
  category: IntegrationCategory;
  auth_method: IntegrationAuthMethod;     // 'oauth2' | 'api_key'
  config: Record<string, unknown>;        // ← skip: may contain secrets
  created_by: string;
  created_at: number;                     // unix ms
  updated_at: number;                     // unix ms
  has_credentials: boolean;
}
```

**Recommended additions** (already-loaded, no new query needed):

| Field | Why it's useful in a hover preview | Display |
|---|---|---|
| `has_credentials` | Tells the user at a glance whether the agent can actually use this connection right now. High signal, low cost. | Small status row: green dot "Ready" / amber dot "Credentials missing" |
| `updated_at` | "Updated 3 days ago" — gives recency context, useful when the user has multiple similar connections. | Right-aligned muted text |
| `auth_method` | Borderline. Useful for technical users to know whether it's OAuth or an API key. | Optional small text; can omit |

**Skip:**

- `config` — may contain secrets (host, db name OK; api key embedded is not). Don't render arbitrary fields.
- `created_by` — would require a user-id → display-name lookup that isn't in scope today.
- `id` — internal.

#### Suggested `ChipHoverPreview` component

```tsx
import { formatDistanceToNow } from 'date-fns'; // already a dep — verify
import { IntegrationIcon } from '@/lib/integration-icons';
import { getIntegrationDefinition } from '@/lib/integration-registry';
import { CATEGORY_TAB_LABELS } from '@/components/connection-picker/use-connection-filter';
import type { Integration } from '@/types';

export function ChipHoverPreview({ integration }: { integration: Integration }) {
  const def = getIntegrationDefinition(integration.integration_type);
  const category = def?.category ?? integration.category;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <IntegrationIcon
          type={integration.integration_type}
          size={16}
          className="size-4 shrink-0"
        />
        <span className="text-sm font-medium">{integration.name}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {def?.displayName ?? integration.integration_type}
        {category ? ` · ${CATEGORY_TAB_LABELS[category] ?? category}` : ''}
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <span
          className={cn(
            'inline-block size-1.5 rounded-full',
            integration.has_credentials ? 'bg-emerald-500' : 'bg-amber-500',
          )}
        />
        <span className="text-muted-foreground">
          {integration.has_credentials ? 'Ready' : 'Credentials missing'}
        </span>
        <span className="ml-auto text-muted-foreground">
          Updated {formatDistanceToNow(integration.updated_at, { addSuffix: true })}
        </span>
      </div>
    </div>
  );
}
```

Visual outcome:

```
╭──────────────────────────────────────────╮
│ 🐘  My Prod DB                            │
│ PostgreSQL · Databases                    │
│ 🟢 Ready                Updated 3 days ago│
╰──────────────────────────────────────────╯
```

The popover itself uses `<HoverCardContent>` so it inherits the same `bg-popover`, `border`, `rounded-md`, `shadow-md` family as the @ menu — making the hover state feel like a smaller cousin of the menu (which is exactly what the user asked for).

If `date-fns` is not already a dependency, just format manually:

```ts
function formatRelative(ts: number): string {
  const days = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}
```

(verify with `grep "date-fns" package.json` first; don't add a new dep if a local helper exists in `src/lib/date-utils.ts` or similar)

---

## Implementation order

1. **Issue 1** — two-line popover change. Smallest, highest leverage.
2. **Issue 3** — replace `mention-chip.tsx` body. No new dependencies, no new layout work.
3. **Issue 2** — overlay + `ComposerChip` + `HoverCard`. The largest piece. Test scroll-sync, line-wrap, IME composition, and selection highlight after.
4. **Issue 4** — drops into the `HoverCard` content from Issue 2.

After each issue, eyeball it in dev mode — these are visual changes that no test will catch.

## Verification checklist

- [ ] On `/chat` (welcome screen), the @ menu renders **above** the textarea, never below.
- [ ] The @ menu fits at least 5 rows visibly without scrolling.
- [ ] Typing `@my_prod_db ` in the textarea shows a subtle-gray rounded chip with bold-er text, **inline with the surrounding text, no line-jitter**.
- [ ] Hovering that chip in the textarea opens a small popover with the connection's name, type · category, ready/missing-creds status, and "Updated X ago." Popover styling is visually a smaller sibling of the @ menu.
- [ ] Hovering a chip in a sent message bubble does **nothing** — no tooltip, no popover.
- [ ] The sent-message chip uses subtle-bg styling (no outline) consistent with the textarea chip.
- [ ] Caret in the textarea is visible (not transparent).
- [ ] Selecting text in the textarea shows a visible selection highlight.
- [ ] Scrolling a long composer keeps the overlay chips aligned with the underlying text glyphs.
- [ ] CJK / IME composition still works in the textarea.
- [ ] Deleted-connection chips render without a popover and do not crash on hover.
