# @ Mention Menu for Connections

**Date:** 2026-04-28
**Branch:** `illianaa/at-menu-connections`
**Primary files:** `src/components/prompt-input.tsx`, `src/components/Chat.tsx`, new `src/components/connection-mention-menu/`, `sandbox/control-plane.mjs` (system prompt), `workers/main/src/durable-objects.ts` (message bridging)

---

## Objective

When a user types `@` in the chat input, surface an inline menu of their configured connections (integrations). The user can keep typing to filter, use arrow keys / Enter to select, or Escape to dismiss. A selected connection becomes a textual mention (e.g. `@my_prod_db`) in the message, and the agent receives enough context to know exactly which connection the user referenced.

This mirrors the @-mention UX of Slack/Linear/GitHub and gives users a low-friction way to point the agent at a specific integration without typing its full configured name or remembering its env vars.

---

## Current state

- Chat input (`src/components/prompt-input.tsx`) is a plain `<InputGroupTextarea>` (a wrapped native `<textarea>`). No autocomplete, no popover, no mention parsing.
- Connections (`Integration[]`) are already loaded into the chat via `welcomeData.connections` in `Chat.tsx` (line 128). They include `id`, `integration_type`, `name`, `category`, `auth_method`, `has_credentials`.
- Agent access to connections goes through the virtual connections binding. The agent does **not** currently get a system-prompt listing of connections by user-given name.
- Slash commands (`/compact`, `/context`, …) are pure text — parsed server-side from message content. There is no per-message metadata channel today.

---

## Design

### 1. Visual

The menu is **Slack-style**: slim, dense, no header, no search field, no footer CTA in the default state. Typing after `@` is the search — there is no separate search input. The popover auto-dismisses when the query has zero matches (it does not show an empty state). The only exception is the **discovery moment** when the user has zero connections at all — then we show a single "+ Add a connection" row as a one-time onboarding nudge.

```
┌──────────────────────────────────────────────────────────┐
│ Chat                                                     │
│ ...                                                      │
│ ┌────────────────────────────────────────────────────┐   │
│ │ ╭──────────────────────────────────╮               │   │
│ │ │ 🐘  My Prod DB     postgres       │ ← highlight  │   │
│ │ │ 🐘  Staging DB     postgres       │              │   │
│ │ │ 💳  Stripe Live    stripe         │              │   │
│ │ │ 💬  Slack          slack          │              │   │
│ │ ╰──────────────────────────────────╯               │   │
│ │ ┌────────────────────────────────────────────────┐ │   │
│ │ │ Update sales dashboard from @                ↑ │ │   │
│ │ └────────────────────────────────────────────────┘ │   │
│ │ [+] [🎙]                [model ▾]              [↑] │   │
│ └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

Zero-connections state (discovery):

```
╭──────────────────────────────────╮
│  +  Add a connection             │
╰──────────────────────────────────╯
```

After selection, the textarea text becomes:

```
Update sales dashboard from @my_prod_db ▎
```

`@my_prod_db` renders inline as a styled chip (see Chip styling below) only after the message is sent — i.e. inside the rendered message bubble, **not** inside the textarea. Inside the textarea it remains plain `@my_prod_db` text.

### 1a. Chip styling (rendered message bubble)

The chip must be **colorless with an outline**, sized to sit seamlessly inline with surrounding text. No background fill, no colored text. On hover, an expanded tooltip surfaces a little metadata about the connection.

Exact classes (Tailwind, using existing shadcn tokens — do not introduce new colors):

```tsx
<span
  className="
    inline-flex items-center gap-1
    rounded-md border border-border
    px-1.5 py-0.5
    -my-0.5
    align-baseline
    text-[0.95em] font-medium leading-none
    text-foreground
    cursor-default
    transition-colors
    hover:bg-muted/50
  "
>
  <IntegrationIcon type={integration.integration_type} size={12} className="size-3 shrink-0 opacity-70" />
  <span>@{slug}</span>
</span>
```

Spacing rules (these matter — the chip must not push line-height around):

- `px-1.5 py-0.5` for tight horizontal padding, minimal vertical padding.
- `-my-0.5` negative vertical margin to absorb the chip's added height back into the surrounding text line so line-height stays uniform.
- `text-[0.95em]` — slightly smaller than body text; relative to parent so it scales with bubble text.
- `leading-none` so the chip's internal line-height does not stretch the row.
- `align-baseline` keeps the chip's text baseline aligned with surrounding prose.
- `gap-1` between the icon and the slug text.
- The icon is `size-3` (12px) with `opacity-70` so it reads as a subtle prefix, not a loud badge.

Surround the chip with a single literal space on each side in the rendered output (do not add any non-breaking-space hacks).

### 1b. Chip hover tooltip

Wrap the chip in a shadcn `<Tooltip>` (already in `src/components/ui/tooltip.tsx`). Tooltip content is small, two-line, and shows just enough metadata to confirm what the connection is.

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <span className="...chip classes above...">
      <IntegrationIcon ... />
      <span>@{slug}</span>
    </span>
  </TooltipTrigger>
  <TooltipContent side="top" align="start" className="max-w-[260px] px-3 py-2">
    <div className="flex items-center gap-2">
      <IntegrationIcon type={integration.integration_type} size={14} className="size-3.5 shrink-0" />
      <span className="text-sm font-medium">{integration.name}</span>
    </div>
    <div className="mt-0.5 text-xs text-muted-foreground">
      {registryDisplayName} · {categoryLabel}
    </div>
  </TooltipContent>
</Tooltip>
```

Tooltip behavior:

- Use the existing `<TooltipProvider delayDuration={300}>` wrapper that the app already mounts at the route level — do not nest a new provider per chip.
- `side="top"`, `align="start"`. shadcn handles edge-flipping automatically.
- For deleted connections: tooltip shows `Connection no longer available` in `text-muted-foreground`. The chip itself renders with `text-muted-foreground` and `border-dashed` as its only visual difference.

### 1c. Mention menu styling (popover)

The menu lives in a shadcn `<Popover>` anchored to the textarea wrapper, opening **upward** (`side="top"`, `align="start"`, `sideOffset={4}`).

`<PopoverContent>` overrides:

```tsx
<PopoverContent
  side="top"
  align="start"
  sideOffset={4}
  onOpenAutoFocus={(e) => e.preventDefault()}  // keep focus in textarea
  className="
    w-[280px] p-0
    overflow-hidden
    rounded-md border border-border
    bg-popover text-popover-foreground
    shadow-md
  "
>
  <Command shouldFilter={false} className="bg-transparent">
    <CommandList className="max-h-[240px] py-1">
      <CommandGroup className="p-0">
        {filtered.map((c) => (
          <CommandItem
            key={c.id}
            value={c.id}
            onSelect={() => onSelect(c)}
            className="
              flex items-center gap-2
              px-2 py-1.5
              text-sm
              cursor-pointer
              data-[selected=true]:bg-accent
              data-[selected=true]:text-accent-foreground
            "
          >
            <IntegrationIcon type={c.integration_type} size={16} className="size-4 shrink-0" />
            <span className="truncate font-medium">{c.name}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {c.integration_type}
            </span>
          </CommandItem>
        ))}
      </CommandGroup>
    </CommandList>
  </Command>
</PopoverContent>
```

Key style notes:

- **No `<CommandInput>`** — typing happens in the textarea, not in the menu. Pass `shouldFilter={false}` and feed `filtered` from `useMentionTrigger`'s `query`.
- Width is fixed at `280px` so the popover doesn't reflow as the textarea text changes width.
- Row padding is `px-2 py-1.5` — slim, Slack-like. Not the default shadcn `CommandItem` padding which is taller.
- Row layout: 16px icon, name (bold weight via `font-medium`), then integration type pushed to the right (`ml-auto`) in `text-xs text-muted-foreground`.
- Selected/highlighted row uses `data-[selected=true]:bg-accent` — `cmdk` sets that data attribute on the active row automatically.
- `max-h-[240px]` with `CommandList`'s built-in scroll. Roughly 6 visible rows at 36px each.
- `onOpenAutoFocus={(e) => e.preventDefault()}` is **critical**: without it, Radix Popover steals focus from the textarea when it opens, breaking the typing flow.

The zero-connections discovery row uses the same `CommandItem` shape but with a `Plus` icon and the label `Add a connection`, and `onSelect` navigates to `/connections`.

### 2. Interaction model

| Trigger | Behavior |
|---|---|
| User types `@` at start-of-word (preceded by whitespace, newline, or input start) | Open menu, query = `""`, highlight first item |
| User types `@` mid-word (e.g. `email@host`) | **Do not open** — only treat `@` as a trigger when it follows whitespace/start |
| User keeps typing after `@` | Update query (case-insensitive substring match against `name`, `integration_type`, registry `displayName`) |
| User presses `↑` / `↓` | Move highlight, wrap around |
| User presses `Enter` or `Tab` | Insert `@<slug>` + trailing space, close menu, focus stays in textarea |
| User presses `Escape` | Close menu, leave textarea text untouched, focus stays in textarea |
| User clicks outside / blurs textarea | Close menu |
| User types a space | Close menu (mention is implicitly committed if there's an exact match, otherwise nothing inserted) |
| User deletes the `@` | Close menu |
| User has zero connections (entire workspace) | Show single "+ Add a connection" row that navigates to `/connections` on select. This is the only state where an "Add a connection" affordance appears. |
| Query has zero matches | **Auto-dismiss the menu.** No empty state, no "no matches" text. The user just keeps typing as if no menu was ever there. (Matches Slack.) |
| User presses `Enter` with menu open | Selects current item — does **not** submit the message |
| User presses `Enter` with menu closed | Submits message as today |

The menu is "easy to ignore": typing a normal `@` followed by a space (e.g. `email@example.com` with a space before it would actually trigger — but typing the address in one motion past the `@` immediately closes it on space). The menu never blocks message submission.

### 3. Mention serialization

The mention syntax in raw text needs to be:
- Human-readable in the textarea
- Unambiguously parseable server-side
- Stable when the user edits the message

**Format:** `@<slug>` where `slug` is a deterministic, server-reproducible transformation of `Integration.name`:

```
slug(name) = name.toLowerCase()
                 .replace(/[^a-z0-9]+/g, '_')
                 .replace(/^_+|_+$/g, '')
```

So `"My Prod DB"` → `@my_prod_db`. The client computes the slug at insert time. The server (and the agent context) computes the same slug for matching.

**Collision handling:** if two connections produce the same slug, append `-2`, `-3` etc., ordered by `created_at` ascending. The slug map is built once per turn from the integration list.

**Why not richer in-textarea tokens (e.g. `@[Name](id)`):** keeps the textarea pure text, no contenteditable, no token-walking on backspace, no ref state to keep in sync with the string. Matches the existing slash-command "text-only" approach.

### 4. Communicating to the agent

Two coordinated changes:

**(a) Always include a connections section in the agent's system prompt** (per-turn context, in `sandbox/control-plane.mjs` where the system prompt is built). Add:

```
## Available connections

The user has the following connections (integrations) configured. They may
reference them by `@<slug>` in messages. If they do, prefer using that
specific connection's env vars for the request.

- @my_prod_db  — postgres "My Prod DB"
    env: POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD,
         POSTGRES_DATABASE
- @stripe_live — stripe "Stripe Live"
- @slack       — slack "Slack"
```

Feed `{slug, integration_type, name, id}` into the system prompt.

**(b) Inline expand mentions in the user message before it reaches the agent.** When `ChatThreadDO` (or, more naturally, the sandbox control-plane on receipt) processes a user message, replace each `@<slug>` token with:

```
@<slug>  ⟦ref: postgres "My Prod DB" id=abc123⟧
```

This makes the reference unambiguous in the transcript without changing the WebSocket message protocol or adding a metadata channel. The expanded form is what gets persisted to message history (so re-loading a thread preserves the reference).

**Recommended location for expansion:** `sandbox/control-plane.mjs` `handleMessage(content)` (around line 2015) — right before yielding the user message to the SDK. This keeps the Worker side simple and lets the sandbox use its already-loaded integration list.

**Open question for the implementer:** should the textarea raw text persist as `@<slug>` and the *expanded* form only exist in the agent transcript? Recommendation: **yes**. The user sees `@my_prod_db` in their input, the message bubble (post-send) shows a styled chip `@my_prod_db`, and only the agent's view of the message has the `⟦ref: ...⟧` annotation. This keeps the displayed UX clean.

---

## UI implementation

### Components / library

Use shadcn primitives. Two are not yet in `src/components/ui/`:

- **`popover.tsx`** — install via `bunx shadcn@latest add popover`. Wraps `@radix-ui/react-popover`.
- **`command.tsx`** — install via `bunx shadcn@latest add command`. Wraps `cmdk`.

Already present and reused as-is: `tooltip.tsx`.

Notes for the implementer:

- We use `Command` **headlessly** — no `<CommandInput>`. The textarea is the input. Pass `shouldFilter={false}` and feed pre-filtered items.
- Keyboard navigation (`↑/↓`, `Enter`, `Escape`) is handled by `cmdk` automatically once the popover is open. **However**, because focus stays in the textarea (`onOpenAutoFocus={(e) => e.preventDefault()}`), `cmdk`'s key handlers will not fire from textarea keypresses. Instead, lift key handling into the textarea's `onKeyDown` and forward to a `<Command>` ref via the `cmdk` imperative API (or, simpler: track `selectedIndex` in the parent and pass `value` to `<Command value={...}>` — `cmdk` supports controlled active item).
- The recommended controlled pattern: keep `selectedId` in `useMentionTrigger`, drive `<Command value={selectedId} onValueChange={setSelectedId}>`, and on `↑/↓/Enter/Escape` from the textarea, update `selectedId` / call `onSelect` / call `onClose`. This avoids the focus-stealing problem entirely.
- `Popover` provides positioning and outside-click dismissal. Use `<PopoverAnchor>` on the textarea wrapper rather than `<PopoverTrigger>` (the trigger isn't a click target).

### New files

```
src/components/connection-mention-menu/
  index.tsx              ← <ConnectionMentionMenu> popover + Command list
  use-mention-trigger.ts ← detects "@" trigger in textarea, computes query + position
  mention-utils.ts       ← slug() and parseMentions()
```

### `<ConnectionMentionMenu>` props

```tsx
interface ConnectionMentionMenuProps {
  open: boolean;
  query: string;                       // text after the "@", drives filter
  connections: Integration[];          // from welcomeData.connections
  anchorRef: React.RefObject<HTMLElement>; // textarea wrapper for positioning
  onSelect: (connection: Integration) => void;
  onClose: () => void;
  onAddNewClick: () => void;           // navigate to /connections
}
```

Internal behavior:

- Computes `filtered` from `connections` using a case-insensitive substring match on `name`, `integration_type`, and the registry `displayName`. Pass `shouldFilter={false}` to `<Command>` so cmdk's own filter is bypassed (we control filtering and order).
- Sort: exact prefix match on `name` first, then prefix match on `integration_type`, then substring matches, all alphabetically by `name` within each tier.
- **No `<CommandInput>`** — there is no search field in the menu. The textarea is the input.
- **No footer**. The "+ Add a connection" row only appears when `connections.length === 0` (the discovery state).
- Auto-dismiss: when `connections.length > 0` and `filtered.length === 0`, call `onClose()` immediately (in a `useEffect`). The popover does not render an empty state.
- Renders a shadcn `<Popover open={open}>` with `<PopoverAnchor>` set to `anchorRef.current` (lets us anchor on the textarea wrapper without using a `<PopoverTrigger>` button). See exact `<PopoverContent>` markup in section 1c.
- Each row is a `<CommandItem>` styled per section 1c. Icons come from `IntegrationIcon` in `@/lib/integration-icons` (same source `ConnectionChip` uses).

### `useMentionTrigger` hook

Watches `value` and `selectionStart` from the textarea. Returns:

```ts
{
  open: boolean;
  query: string;       // empty string when "@" was just typed
  triggerStart: number; // index of the "@" in `value`
}
```

Open conditions (must all hold):
1. There is an `@` to the left of the caret.
2. Between that `@` and the caret there is no whitespace.
3. The character to the left of the `@` is whitespace, newline, or the very start of the string.
4. The textarea is focused.

Close = any of those become false, or `Escape` is pressed.

### `mention-utils.ts`

```ts
export function slug(name: string): string;
export function buildSlugMap(integrations: Integration[]): Map<string, Integration>;

// Parse "@foo @bar" out of a message body. Returns matched mentions only.
export function parseMentions(
  body: string,
  slugMap: Map<string, Integration>,
): Array<{ slug: string; integration: Integration; index: number }>;
```

`slug` and `buildSlugMap` are used in **both** the client (insert + render highlight) and the server (system-prompt build + transcript expansion). Place the utility in `src/lib/connection-mentions.ts` instead of inside the component dir so workers can import it (workers can import from `src/lib/`; check existing imports for precedent — `src/lib/integration-registry.ts` is shared today).

### Wiring into `prompt-input.tsx`

Add (additive — do not break the existing API):

```tsx
interface PromptInputProps {
  // ...existing...
  mentionableConnections?: Integration[];
  onMentionAddNewClick?: () => void;
}
```

Inside `PromptInput`:

1. Wrap the textarea in a `<div ref={anchorRef} className="relative">` (the menu anchors here).
2. Track `caretPos` via `onSelect` / `onKeyUp` / `onClick` on the textarea.
3. Call `useMentionTrigger({ value, caretPos })` to derive `{open, query, triggerStart}`.
4. Render `<ConnectionMentionMenu open query connections={mentionableConnections ?? []} … />`.
5. Intercept `keyDown` to:
   - Suppress `Enter` submit while menu is open (Command's own handler selects).
   - Forward `↑/↓/Enter/Escape/Tab` to the Command via a programmatic ref OR let Radix Popover + cmdk handle them natively (preferred — `cmdk` listens to keys when the popover is open and focused).
6. On select: replace the substring from `triggerStart` to `caretPos` with `@<slug> ` and update `value` via `onChange`.

`Chat.tsx` change: pass `mentionableConnections={welcomeData.connections}` and `onMentionAddNewClick={() => navigate('/connections')}`.

### Rendering mentions in sent messages

Create a new component `src/components/connection-mention-menu/mention-chip.tsx`:

```tsx
'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { IntegrationIcon } from '@/lib/integration-icons';
import { getIntegrationDefinition } from '@/lib/integration-registry';
import type { Integration } from '@/types';

interface MentionChipProps {
  slug: string;
  integration: Integration | null; // null if connection was deleted
}

export function MentionChip({ slug, integration }: MentionChipProps) {
  const def = integration ? getIntegrationDefinition(integration.integration_type) : null;
  const isDeleted = integration === null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={
            isDeleted
              ? 'inline-flex items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5 -my-0.5 align-baseline text-[0.95em] font-medium leading-none text-muted-foreground cursor-default'
              : 'inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 -my-0.5 align-baseline text-[0.95em] font-medium leading-none text-foreground cursor-default transition-colors hover:bg-muted/50'
          }
        >
          {integration && (
            <IntegrationIcon
              type={integration.integration_type}
              size={12}
              className="size-3 shrink-0 opacity-70"
            />
          )}
          <span>@{slug}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[260px] px-3 py-2">
        {isDeleted ? (
          <div className="text-xs text-muted-foreground">Connection no longer available</div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <IntegrationIcon
                type={integration!.integration_type}
                size={14}
                className="size-3.5 shrink-0"
              />
              <span className="text-sm font-medium">{integration!.name}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {def?.displayName ?? integration!.integration_type}
              {def ? ` · ${categoryLabel(def.category)}` : ''}
            </div>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
```

`categoryLabel` is a small helper that maps `IntegrationCategory` → human label (`databases` → "Databases", etc.). If a similar map exists in `connection-picker/use-connection-filter.ts` (`CATEGORY_TAB_LABELS`), reuse it.

In `src/components/message-bubble.tsx`: after the existing slash-command parsing pass, add a second pass that tokenizes `@<slug>` (only when preceded by whitespace or start-of-string) and replaces each known match with `<MentionChip slug={slug} integration={integration} />`. Build the slug→Integration map once per render via `buildSlugMap(connections)`. Unmatched `@words` render as plain text — important so emails/handles don't get accidentally highlighted.

The `<TooltipProvider>` is already mounted at the app shell level (verify in the app's root layout — if not, wrap the chat surface in one with `delayDuration={300}`). Do not add a provider per chip.

---

## Backend / agent changes

### `sandbox/control-plane.mjs`

Two edits, both small.

**(1) System prompt**: where the system prompt is assembled (search for the existing prompt build site), append a `## Available connections` section built from the workspace's integrations. Format per the design above.

**(2) Inline expansion in `handleMessage`** (around line 2015): before yielding the user message, run:

```js
const expanded = expandMentions(message.content, slugMap);
yield { type: 'user', message: { role: 'user', content: expanded } };
```

`expandMentions` walks each `@<slug>` token (only those preceded by whitespace/start) and appends ` ⟦ref: <integration_type> "<name>" id=<id>⟧`. Unknown slugs are left untouched.

Persist the **expanded** form in the agent transcript history. Persist the **raw** form (pre-expansion) in the user-visible message history (the existing `messages` table for the chat — what the UI loads back when you reopen a thread). If those are the same store today, decide once: store raw, expand on read for the agent. Pick whichever is cheaper given current `sandbox-host` chat-message API shape.

### `workers/main/src/durable-objects.ts` (`ChatThreadDO`)

No protocol change required. The `'message'` payload is still `{ type, content, sessionId, threadId }` and the content is the raw `@<slug>` text.

If we later want richer behavior (e.g. server-side validation that mentioned connections exist, or analytics on which connections are mentioned), add `mentions?: string[]` to the payload — but **not in v1**. v1 stays text-only to match slash-command precedent.

---

## Edge cases & decisions

| Case | Behavior |
|---|---|
| User has zero connections | Menu still opens with only the "+ Add a connection…" row. Fine. |
| Connection name renames mid-thread | Old messages keep their old `@<slug>`; agent sees a `⟦ref: …⟧` with the **current** name resolved by id (server keeps id, looks up live name). If the connection is deleted, expansion shows `⟦ref: deleted⟧` and agent is told it's no longer available. |
| Two connections slug-collide | Append `-2`, `-3` deterministically by `created_at`. UI shows the suffix in the menu so the user knows which is which. |
| User types `@@` | Menu does not open (the `@` is not preceded by whitespace). Treat as literal text. |
| User pastes a long email containing `@` | Trigger only fires on keystrokes, not paste. Even if it did, the second char after `@` is non-whitespace and matches no slug, so menu shows "No matches" and closes on the first space. |
| Backspacing over a mention | The mention is plain text, so backspace deletes characters one at a time. Acceptable for v1. (Future: detect a full `@<slug>` token and delete it whole.) |
| Mobile / touch | Popover and Command both work touch-fine. Tap to select. No special mobile work. |
| IME composition (CJK input) | Use `compositionstart` / `compositionend` to suppress trigger detection during composition — `cmdk` handles this internally for its own input, but our trigger detection on the textarea must too. |
| Submit while menu is open | Enter selects; does not submit. Cmd/Ctrl+Enter still submits (escape hatch). |
| A `@slug` is stale (deleted connection) when re-opening an old thread | Render as plain `@slug` (no chip), and at expansion time the agent sees `⟦ref: deleted⟧`. |
| Performance with many connections | Workspaces typically have <50 connections. `cmdk` filters in-memory; no concern. |

---

## Implementation steps (in order)

1. **Add shadcn primitives**: `bunx shadcn@latest add popover command`. Verify `cmdk` lands in `package.json`.
2. **Create `src/lib/connection-mentions.ts`** with `slug`, `buildSlugMap`, `parseMentions`, `expandMentions`. Unit-test with Vitest.
3. **Create `src/components/connection-mention-menu/`** (`index.tsx`, `use-mention-trigger.ts`).
4. **Wire into `src/components/prompt-input.tsx`** as additive props. Default behavior (no `mentionableConnections`) is unchanged.
5. **Wire from `src/components/Chat.tsx`** — pass `welcomeData.connections` and a navigate callback.
6. **Render mentions in `src/components/message-bubble.tsx`** — extend the existing parsing pass.
7. **System prompt update in `sandbox/control-plane.mjs`** — append `## Available connections` block.
8. **Inline expansion in `sandbox/control-plane.mjs`** `handleMessage` — call `expandMentions` before yielding to the SDK / app-server.
9. **Persist + replay**: confirm raw form is stored in chat history (so the textarea can show `@slug` on re-render of past turns) and expanded form is what the agent sees.
10. **Tests**:
    - Vitest: `slug`, `buildSlugMap`, `parseMentions`, `expandMentions` (collisions, missing slugs, mid-word `@`).
    - Vitest (component): trigger opens/closes per the rules table; selection inserts `@<slug> `.
    - Optional Playwright: type `@`, select first item, send, verify chip rendered in bubble.
11. **Typecheck + lint + relevant unit tests** before handoff.

---

## Out of scope (v1)

- Rich token rendering inside the textarea (chip pill while typing). Plain `@<slug>` text only.
- Backspace-deletes-whole-mention behavior.
- Analytics on mention usage.
- Mentioning anything other than connections (files, threads, apps) — but the architecture leaves room: `useMentionTrigger` is generic and `<ConnectionMentionMenu>` is the only connection-specific layer.
- Per-message metadata channel for mentions on the WebSocket. Stay text-only.

---

## Verification checklist

- [ ] Typing `@` after whitespace opens the menu.
- [ ] Typing `email@x.com` does **not** open the menu.
- [ ] Arrow keys, Enter, Escape work as specified — focus never leaves the textarea while the menu is open.
- [ ] Selection inserts `@<slug> ` and closes the menu.
- [ ] Menu has no search input, no header, no footer in the default state.
- [ ] Menu auto-dismisses when query has zero matches (no empty state shown).
- [ ] When the workspace has zero connections, a single `+ Add a connection` row appears and navigates to `/connections` on select.
- [ ] In a sent message bubble, `@my_prod_db` renders as a colorless outlined chip with the integration icon prefix, sitting on the same line height as surrounding text (no row stretching).
- [ ] Hovering the chip shows a tooltip with the connection's name on line 1 and `<displayName> · <category>` on line 2.
- [ ] Deleted-connection chip uses `border-dashed` + `text-muted-foreground` and tooltip says `Connection no longer available`.
- [ ] Textarea raw text only ever contains `@<slug>`; the `⟦ref: ...⟧` expansion never appears in the UI.
- [ ] Sending a message with `@my_prod_db` causes the agent to reference that specific connection's env vars in its response (smoke-test by asking it "what's the host of the DB I just mentioned?").
- [ ] Renaming a connection updates the resolved name the agent sees on next turn (id-based resolution).
- [ ] Deleting a connection while a thread has historic mentions doesn't crash; agent gets `⟦ref: deleted⟧`.
- [ ] Slug collisions render with `-2` / `-3` suffix.
- [ ] `bun run typecheck`, `bun run lint`, `bun run test:run` all pass.
