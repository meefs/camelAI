# @ Mention Menu — Iteration 4 Feedback

**Date:** 2026-04-30
**Branch:** `illianaa/at-menu-connections`
**Reviewing commit:** `42e13750 Iterate on @-mention menu based on feedback`

---

## Summary

The caret alignment fix worked — chip glyphs and textarea glyphs now sit on top of each other. Click-to-select works, menu auto-scrolls, status indicator is honest. Remaining issues are visual polish + one persistence bug.

| # | Severity | Issue |
|---|---|---|
| 1 | Polish | Chip feels cramped — needs more breathing room without re-introducing caret drift. |
| 2 | Polish | Composer chip and sent-message chip render slightly differently. They should visually match. |
| 3 | **Bug** | After refresh, sent messages render the raw `⟦ref: ...⟧` annotation. Needs the same display-time stripping treatment we use for `[Name]: ` author prefixes. |
| 4 | Polish | In the @ menu, the gap between connection name and integration type looks like a tab — it's actually `ml-auto` flexing variable space. Should be a small fixed gap. |

---

## Issue 1 — Add breathing room to the chip without breaking caret alignment

The 2px `box-shadow` fix solved the caret drift, but it is not the right product-quality solution. It works by accepting the current architecture's limitation instead of removing the limitation.

The current composer uses a transparent native `<textarea>` for the real value/caret and an overlay that renders the visible text. That means the overlay and the textarea must have identical text metrics forever. Any visible chip treatment that changes inline layout — padding, margin, font weight, letter spacing, a different font size, an icon, etc. — makes the overlay's glyph positions diverge from the textarea's caret positions. The 4px box-shadow idea is only a larger paint-only fake padding. It cannot ever become a fully polished Slack-style chip because the visible text and the caret are being produced by different layers.

### Better fix: native textarea text + measured decoration layer

Keep the native textarea responsible for visible text, caret positioning, selection, copy/paste, IME, undo/redo, and screen-reader semantics. Draw the chip background as a separate measured decoration behind the textarea text.

In other words:

- The textarea renders the literal `@connection_slug` text normally, not transparent.
- A hidden mirror element uses the same text, same wrapping, same padding, and same font metrics to measure where each recognized `@slug` appears.
- A decoration layer draws rounded `bg-muted` rectangles behind those measured text rects, with real visual horizontal padding.
- A separate transparent hit layer sits above the textarea only over those chip rects so hover cards and click-to-select still work.

This gives the chip actual visual breathing room without changing the inline text flow that the textarea caret uses.

### Target result

- Composer chip looks like a real rounded inline token, not a cramped highlight.
- Horizontal breathing room is real visually, e.g. 5-6px on each side.
- The caret remains native and stays exactly aligned after one chip, multiple chips, and wrapped lines.
- The textarea value remains plain text (`@bigquery test`), with no hidden token syntax.
- Copy/paste, undo/redo, selection, IME, and form submission stay native textarea behavior.
- HoverCard still works on the chip.
- Clicking the chip still selects the `@slug` range in the textarea so Backspace deletes it.

### Implementation plan

#### Step 1 — Replace the visible overlay with a decoration component

Replace the current responsibility of `src/components/connection-mention-menu/composer-mention-overlay.tsx`. The component should no longer render visible overlay text. Rename it if helpful, e.g. `ComposerMentionDecorations`, or keep the file name and change the component internals.

New prop shape:

```tsx
interface ComposerMentionDecorationsProps {
  value: string;
  slugMap: Map<string, Integration>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  scrollTop: number;
  scrollLeft: number;
  onTextareaSelectionChange?: () => void;
}
```

`wrapperRef` should point at the `relative w-full` element that contains the textarea and the decoration layers.

#### Step 2 — Make the textarea visible again

In `src/components/prompt-input.tsx`, stop hiding the textarea glyphs:

```tsx
<InputGroupTextarea
  ...
  className={cn(
    'relative z-10 bg-transparent text-base md:text-base p-3.5 max-h-96 overflow-y-auto',
    'selection:bg-primary/30',
    isActiveRecording && 'opacity-50',
  )}
  style={{
    minHeight,
    caretColor: 'var(--foreground)',
  }}
/>
```

Remove:

```tsx
color: 'transparent'
```

Remove:

```tsx
selection:text-transparent
```

The textarea text should be the only visible text layer. The decoration layer sits behind it.

Suggested wrapper structure:

```tsx
const textareaWrapperRef = useRef<HTMLDivElement | null>(null);
const [textareaScroll, setTextareaScroll] = useState({ top: 0, left: 0 });

<div ref={textareaWrapperRef} className="relative w-full">
  <ComposerMentionDecorations
    value={value}
    slugMap={slugMap}
    textareaRef={effectiveTextareaRef}
    wrapperRef={textareaWrapperRef}
    scrollTop={textareaScroll.top}
    scrollLeft={textareaScroll.left}
    onTextareaSelectionChange={updateCaretPos}
  />

  <InputGroupTextarea
    ref={effectiveTextareaRef}
    ...
    onScroll={(e) => {
      setTextareaScroll({
        top: e.currentTarget.scrollTop,
        left: e.currentTarget.scrollLeft,
      });
    }}
  />
</div>
```

If there is concern about setting React state on every scroll event, store the scroll position in refs and schedule a `requestAnimationFrame` update. The composer is small enough that direct state is probably fine, but keep the handler cheap.

#### Step 3 — Build a hidden mirror for measurement only

Inside `ComposerMentionDecorations`, render an invisible mirror that lays out the exact same text as the textarea. It must not be `display: none`; `getClientRects()` needs real layout boxes.

Important mirror rules:

- Same width as the textarea's `clientWidth`, not the wrapper's full width when a vertical scrollbar is present.
- Same `padding`, `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`, `tab-size`, `text-align`, `box-sizing`, and wrapping behavior as the textarea.
- `white-space: pre-wrap`.
- `overflow-wrap: break-word`.
- `visibility: hidden`.
- `pointer-events: none`.
- Absolute positioned so it does not affect layout.

Prefer copying the runtime computed styles from the textarea into the mirror instead of relying only on duplicated Tailwind classes. That avoids future class drift.

Useful helper shape:

```ts
const MIRROR_STYLE_PROPS = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'textAlign',
  'textIndent',
  'textTransform',
  'tabSize',
] as const;

function syncMirrorStyles(
  textarea: HTMLTextAreaElement,
  mirror: HTMLDivElement,
) {
  const computed = window.getComputedStyle(textarea);
  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style[prop] = computed[prop];
  }
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
}
```

When rendering mirror content, use the original source substring for each mention, not `@${match.slug}`. This preserves exact casing and metrics if the user typed a slug manually:

```tsx
const mentionText = value.slice(match.index, match.index + match.length);
```

Add a zero-width sentinel at the end of the mirror content (`'\u200b'`) so trailing newlines and trailing spaces do not collapse in surprising ways while measuring.

Suggested mirror rendering shape:

```tsx
function renderMirrorTokens(
  value: string,
  matches: MentionMatch[],
): ReactNode[] {
  const output: ReactNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.index > cursor) {
      output.push(value.slice(cursor, match.index));
    }

    const sourceText = value.slice(match.index, match.index + match.length);
    const key = `${match.index}-${match.length}-${match.slug}`;

    output.push(
      <span key={key} data-mention-key={key}>
        {sourceText}
      </span>,
    );

    cursor = match.index + match.length;
  }

  if (cursor < value.length) {
    output.push(value.slice(cursor));
  }

  output.push('\u200b');
  return output;
}
```

The mirror spans do not get visible styling, padding, margin, font weight, or pointer handlers. They only mark source ranges so the decoration layer can measure their text boxes.

#### Step 4 — Measure mention rects from the mirror

Use `parseMentions(value, slugMap)` and only decorate matches with a non-null `integration`.

Suggested data shape:

```ts
interface MentionDecorationRect {
  key: string;
  slug: string;
  integration: Integration;
  startIndex: number;
  endIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
}
```

Measurement details:

- Run measurement in `useLayoutEffect` after the mirror renders.
- Use `span.getClientRects()` instead of `getBoundingClientRect()` so a long mention that wraps across lines gets one decoration rect per visual line fragment.
- Convert rects into content coordinates relative to the mirror content box.
- Render the decorations inside a content plane that is translated by `-scrollLeft` / `-scrollTop`, so scrolling moves the backgrounds without needing to remeasure on every scroll.
- Re-measure when `value`, `slugMap`, textarea width, font loading, or textarea computed styles change.
- Attach a `ResizeObserver` to the textarea or wrapper so window resizing and responsive width changes recalculate rects.

Pseudo-code:

```tsx
const CHIP_X_PAD = 6;
const CHIP_Y_PAD = 2;

useLayoutEffect(() => {
  const textarea = textareaRef.current;
  const mirror = mirrorRef.current;
  const mirrorContent = mirrorContentRef.current;
  if (!textarea || !mirror || !mirrorContent) return;

  syncMirrorStyles(textarea, mirror);

  const contentBox = mirrorContent.getBoundingClientRect();
  const nextRects: MentionDecorationRect[] = [];

  for (const element of mirrorContent.querySelectorAll<HTMLElement>('[data-mention-key]')) {
    const key = element.dataset.mentionKey;
    const match = key ? mentionByKey.get(key) : null;
    if (!match || !match.integration) continue;

    for (const fragment of element.getClientRects()) {
      if (fragment.width <= 0 || fragment.height <= 0) continue;
      nextRects.push({
        key: `${key}-${nextRects.length}`,
        slug: match.slug,
        integration: match.integration as Integration,
        startIndex: match.index,
        endIndex: match.index + match.length,
        left: fragment.left - contentBox.left - CHIP_X_PAD,
        top: fragment.top - contentBox.top - CHIP_Y_PAD,
        width: fragment.width + CHIP_X_PAD * 2,
        height: fragment.height + CHIP_Y_PAD * 2,
      });
    }
  }

  setRectsIfChanged(nextRects);
}, [value, slugMap, textareaRef, wrapperRef]);
```

Do not call `setRects` unconditionally if the numbers are unchanged; repeated layout reads followed by state writes can create avoidable render loops. Round rect numbers to device pixels or compare with a small epsilon.

#### Step 5 — Draw background rectangles behind the textarea text

Render a non-interactive background layer below the textarea:

```tsx
<div
  aria-hidden
  className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
>
  <div
    className="absolute left-0 top-0"
    style={{
      transform: `translate(${-scrollLeft}px, ${-scrollTop}px)`,
    }}
  >
    {rects.map((rect) => (
      <span
        key={rect.key}
        className="absolute rounded-md bg-muted"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }}
      />
    ))}
  </div>
</div>
```

Visual constants to start with:

- `CHIP_X_PAD = 6`
- `CHIP_Y_PAD = 2`
- `rounded-md`
- `bg-muted`

Because this background is independent of text layout, the coding agent can tune `CHIP_X_PAD` between 5 and 7px without risking caret drift. If it visually crowds adjacent words, reduce the horizontal pad to 5px. Do not solve that by changing textarea text metrics.

#### Step 6 — Add transparent hit targets for hover/select

Since the background layer is behind the textarea, it cannot receive pointer events. Add a separate hit layer above the textarea, but only over the measured chip rects:

```tsx
<div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
  <div
    className="absolute left-0 top-0"
    style={{
      transform: `translate(${-scrollLeft}px, ${-scrollTop}px)`,
    }}
  >
    {rects.map((rect) => (
      <HoverCard key={`hit-${rect.key}`} openDelay={200} closeDelay={100}>
        <HoverCardTrigger asChild>
          <span
            aria-hidden
            className="pointer-events-auto absolute cursor-default rounded-md"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              const textarea = textareaRef.current;
              if (!textarea) return;
              textarea.focus();
              textarea.setSelectionRange(rect.startIndex, rect.endIndex);
              onTextareaSelectionChange?.();
            }}
          />
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="start"
          className="w-auto min-w-[200px] max-w-[280px] rounded-md border border-border p-2 shadow-md ring-0"
        >
          <ChipHoverPreview integration={rect.integration} />
        </HoverCardContent>
      </HoverCard>
    ))}
  </div>
</div>
```

This preserves the previous "click chip to select the token" behavior without allowing overlay text selection, because there is no overlay text anymore. The transparent hit target is only a pointer target.

If a mention wraps onto multiple visual lines, each fragment can have its own hit target and HoverCard. All fragments should select the same source range (`startIndex` → `endIndex`).

#### Step 7 — Keep textarea selection and editing native

With this approach:

- Single-clicking regular text behaves exactly like a textarea.
- Drag-selecting regular text behaves exactly like a textarea.
- Clicking a chip selects just the `@slug` range.
- Backspace/Delete removes the selected slug natively.
- Copying selected text copies the raw slug, not hidden markup.
- IME composition is unaffected because the textarea remains the only editable surface.

Make sure the hit layer uses `pointer-events-none` at the container level and `pointer-events-auto` only on the measured chip spans. Otherwise it will block normal textarea interaction.

### Relationship to Issue 2

This plan changes the composer chip implementation model. Do **not** make the composer and sent-message chip share one literal CSS class that uses box-shadow padding. The composer no longer has a visible inline chip span at all; it has measured background rectangles plus native textarea text.

For Issue 2, interpret "composer and sent-message chips must look identical" as **same visual language**, not the exact same implementation:

- Composer: native textarea text + measured `bg-muted` rounded decoration rects.
- Sent message: normal inline `<span>` can use real CSS padding because it is not tied to textarea caret metrics.

Recommended sent-message chip styling, if Issue 2 is implemented in the same pass:

```tsx
const SENT_MESSAGE_CHIP_CLASS =
  'inline rounded-md bg-muted px-1.5 py-0.5 -my-0.5 align-baseline text-foreground cursor-default';
```

If that renders too tall in message bubbles, reduce to `px-1 py-px -my-px`. The sent-message chip should visually match the composer decoration's radius, background, and horizontal breathing room, but it does not need the measurement machinery.

### Longer-term alternative

The fully Slack-like architecture is a rich-text composer with contenteditable and inline atomic mention nodes, using something like Lexical or ProseMirror. In that architecture, the browser selection model knows the padded mention chip is part of the editable document, so real padding and richer chip contents are natural.

That is a larger composer rewrite and not necessary for this iteration. The measured decoration layer is the right middle ground: native textarea reliability with a product-quality chip background.

### Do not do these

- Do not bump the current `box-shadow` from 2px to 4px as the final fix. It is a small visual patch, not a real solution.
- Do not make the textarea text transparent anymore. The visible text should come from the textarea.
- Do not render visible replacement text in an overlay.
- Do not add `font-semibold`, padding, margin, letter spacing, icon glyphs, or a different font size to any visible overlay text.
- Do not insert hidden spacer characters into `value`.
- Do not switch the composer to contenteditable in this iteration unless the team explicitly decides to take on that larger refactor.

### Verification

1. Type `@bigquery just testing the bigquery integration` and confirm the caret stays exactly after the typed text.
2. Type two chips on one line: `@bigquery and @stripe both work`; confirm the caret does not drift after either chip.
3. Type a chip near the right edge so the line wraps; confirm the chip background and textarea text wrap together.
4. Make the composer tall enough to scroll; confirm chip backgrounds and hit targets stay aligned while scrolling.
5. Click a chip; confirm the textarea selects exactly `@slug`, and Backspace deletes it.
6. Hover a chip; confirm the existing HoverCard content still appears.
7. Drag-select text that crosses through a chip; confirm selection remains native textarea selection.
8. Copy selected text containing a chip; confirm the clipboard receives plain `@slug` text.
9. Test mobile/narrow width and desktop width; confirm measurement recalculates after resize.
10. Run `bun run typecheck`.

---

## Issue 2 — Composer and sent-message chips should visually match

Issue 1 changes the composer architecture: the composer no longer renders a visible inline chip span. It renders native textarea text plus measured rounded background rectangles behind recognized `@slug` ranges. That means the composer chip and sent-message chip **must not** share one literal CSS class. They have different implementation constraints.

The design goal is visual parity:

- same `bg-muted` family
- same `rounded-md` radius
- same normal text weight
- same full text size
- same approximate horizontal breathing room
- no outline, no border, no icon inline

### Current mismatch

The sent-message chip in `src/components/connection-mention-menu/mention-chip.tsx` is still smaller and heavier than the composer text:

```ts
const CHIP_BASE =
  'inline rounded-sm align-baseline text-[0.95em] font-semibold leading-[inherit] cursor-default';
```

That should change. Sent messages are not tied to textarea caret metrics, so they can use normal CSS padding. The composer gets its breathing room from measured decoration rectangles; sent messages get equivalent breathing room from inline padding.

### Fix

Update `src/components/connection-mention-menu/mention-chip.tsx` to use a padded inline span that visually matches the composer decoration. Do not create a shared composer/sent-message chip style module.

Recommended implementation:

```tsx
'use client';

import { cn } from '@/lib/utils';
import type { Integration } from '@/types';

interface MentionChipProps {
  slug: string;
  integration: Integration | null;
}

const CHIP_BASE =
  'inline rounded-md px-1.5 py-0.5 -my-0.5 align-baseline font-normal leading-[inherit] cursor-default';
const CHIP_LIVE = 'bg-muted text-foreground';
const CHIP_DELETED = 'bg-muted/60 text-muted-foreground';

export function MentionChip({ slug, integration }: MentionChipProps) {
  const isDeleted = integration === null;

  return (
    <span className={cn(CHIP_BASE, isDeleted ? CHIP_DELETED : CHIP_LIVE)}>
      @{slug}
    </span>
  );
}
```

Drop:

- `rounded-sm` — composer decoration uses `rounded-md`; sent message should match.
- `text-[0.95em]` — sent chip should use the same text size as surrounding message text, matching the composer textarea text.
- `font-semibold` — sent chip should not be heavier than composer text.
- any icon — icons belong in the menu and hover card, not inline in sent messages.
- any tooltip wrapper — the user already asked for no tooltip on the sent-message chip.

If `py-0.5 -my-0.5` makes message line-height look too tight or too tall in practice, reduce to `py-px -my-px`. Keep `px-1.5` unless it visually overhangs too much near punctuation.

### Important non-goal

Do not make the sent-message chip pixel-identical to the composer via box-shadow. The composer decoration is measured background geometry; the sent-message chip is normal inline markup. They should look like the same component family to the user, but they should not share the old overlay-era implementation.

### Verification

Side-by-side visual test:

1. Type `@bigquery test message` in the composer.
2. Before sending, confirm the composer decoration reads as a rounded muted chip around normal-weight textarea text.
3. Send it.
4. Confirm the sent-message chip uses the same visual language: muted fill, rounded corners, normal-weight full-size text, and similar horizontal breathing room.
5. Confirm sent-message line-height does not jump awkwardly when a line contains a chip.

---

## Issue 3 — `⟦ref: ...⟧` annotation reappears on page refresh

### Root cause

`workers/main/src/connection-mention-context.ts:applyConnectionMentionContext` runs in `ChatThreadDO` *before* the message is persisted. It rewrites the user message body from `Hello @camel` to `Hello @camel ⟦ref: other "Camel" id=858d...⟧`. That rewritten body is what gets saved to the message store.

During the live session, the client optimistically renders the **pre-send** content (which never had the annotation), so it looks fine. After a refresh, the message body the client loads is the **stored** (expanded) form — annotation included. The display layer doesn't know to strip it.

This is exactly the same problem the `[Name]: ` author prefix has, and the codebase already solves that one in `src/components/message-bubble.tsx`:

```ts
// message-bubble.tsx:100
function stripSystemMessageTags(text: string): string {
  return text.replace(/<camelai system message>[\s\S]*?<\/camelai system message>/g, '').trim();
}
```

…and `parseMessageAuthor` strips `[Name]:` via regex on the raw content before display. We need to do the same for `⟦ref: ...⟧`.

### Fix

Add a sibling stripping function and call it at the same points `stripSystemMessageTags` is called.

#### Step 1 — Add the strip function

In `src/components/message-bubble.tsx`, near `stripSystemMessageTags` (~line 100):

```ts
const MENTION_ANNOTATION_REGEX = /\s*⟦ref:[^⟧]*⟧/g;

/**
 * Strip the inline `⟦ref: …⟧` annotations the server adds after each
 * recognized @-mention. The annotation is for the agent's benefit only —
 * users should never see it.
 */
function stripMentionAnnotations(text: string): string {
  return text.replace(MENTION_ANNOTATION_REGEX, '');
}
```

#### Step 2 — Apply it in the same places `stripSystemMessageTags` runs

`stripSystemMessageTags` is called in several spots in `message-bubble.tsx` (~lines 105, 221, 225, 234, 237, 265, 291). Compose the two stripping passes — the simplest move is to update `stripSystemMessageTags` itself to also strip mention annotations, since they have the same audience (server-only, hidden from users):

```ts
function stripSystemMessageTags(text: string): string {
  return text
    .replace(/<camelai system message>[\s\S]*?<\/camelai system message>/g, '')
    .replace(MENTION_ANNOTATION_REGEX, '')
    .trim();
}
```

That's a 2-line change and fixes every call site at once.

#### Step 3 — Apply it in the other strip helpers used elsewhere

The annotation can also leak into thread previews and notifications. Apply the same regex strip in:

- `src/lib/thread-preview.ts:8` — `stripSystemMessageTags` (already exists; add the `.replace(MENTION_ANNOTATION_REGEX, '')` line)
- `src/lib/task-notification.ts:14` — same function exists; same edit
- `src/lib/teammate-message.ts:12` — same function exists; same edit

All four use copies of the same `stripSystemMessageTags` shape. Recommend extracting both regexes + the helper into a shared module (e.g. `src/lib/message-display.ts`) and importing from there, but if that refactor is out of scope, just apply the 2-line edit in each.

### Verification

1. Send a message containing `@camel test`.
2. While the page is still open, confirm no annotation visible in the bubble. ✓ (already works)
3. **Refresh the page.** Confirm the bubble still shows `@camel test` and not `@camel ⟦ref: other "Camel" id=...⟧`.
4. Confirm the chip itself still renders (because `parseMentions` finds `@camel` even after the annotation strip).
5. Sidebar/recent-thread previews of that message should also not show the annotation.

### Note on storage shape

This fix is the right call for now — strip on display, keep the expansion in storage. The agent benefits from the annotation being persistent (it's available for any reload of conversation history into the agent's context window). The display layer has to know to hide it, which it now does.

The cleaner long-term answer is "store the raw form, expand on load when sending to the agent." That's a bigger refactor (separate the user-visible body from the agent-context body in storage). Not in scope for this round.

---

## Issue 4 — Menu name/type gap looks arbitrary

`src/components/connection-mention-menu/index.tsx:148-150`:

```tsx
<span className="truncate font-medium">{c.name}</span>
<span className="ml-auto shrink-0 text-xs text-muted-foreground">
  {def?.displayName ?? c.integration_type}
</span>
```

`ml-auto` pushes the integration-type label to the right edge of the popover, so the gap between name and type is *whatever is left over* in the 280px-wide row. A short name like "Camel" leaves a huge gap; a long name like "MySQL testdb 4" leaves a small one. The user reads this as visually arbitrary.

### Fix

Drop `ml-auto` and let the parent's `gap-2` (8px ≈ two character spaces at this font size) control the spacing. Add `min-w-0` to the name so `truncate` works inside a flex child:

```tsx
<span className="truncate font-medium min-w-0">{c.name}</span>
<span className="shrink-0 text-xs text-muted-foreground">
  {def?.displayName ?? c.integration_type}
</span>
```

Result: name and type sit next to each other with a consistent 8px gap. Long names truncate with ellipsis. Short names leave the right side of the row empty (acceptable — better than the inconsistent floating-right look).

If the user still wants the type slightly distanced for visual hierarchy, change the parent's `gap-2` to `gap-3` (12px). I'd recommend trying `gap-2` first and only bumping if it reads as too tight.

### Visual outcome

```
Before                                  After
┌────────────────────────────────┐     ┌────────────────────────────────┐
│ 🐘 BigQuery     Google BigQuery│     │ 🐘 BigQuery  Google BigQuery   │
│ ⚙️  Camel                  Other│     │ ⚙️  Camel  Other                │
│ 🐬 MySQL testdb           MySQL│     │ 🐬 MySQL testdb  MySQL          │
│ 🐬 MySQL testdb 2         MySQL│     │ 🐬 MySQL testdb 2  MySQL        │
└────────────────────────────────┘     └────────────────────────────────┘
   ^ variable gap                          ^ consistent 8px gap
```

---

## Implementation order

1. **Issue 4** — one line change, smallest blast radius. Eyeball.
2. **Issue 3** — display-time strip. Verify by sending a mention and refreshing the page.
3. **Issue 1** — replace the transparent visible overlay with the native-textarea + measured-decoration layer. Verify caret alignment, wrapping, scrolling, hover, and click-to-select.
4. **Issue 2** — update the sent-message chip to visually match the composer decoration. Do not share the old box-shadow overlay class.

---

## Verification checklist

- [ ] Composer chip has visible breathing room around the slug text — looks intentional, not just a highlight.
- [ ] Caret in the textarea remains exactly at the correct position regardless of how many chips are on the line (no regression from Issue 1).
- [ ] Composer chip and sent-message chip use the same visual language: muted fill, rounded corners, normal-weight full-size text, and similar horizontal breathing room.
- [ ] After sending a message with `@camel`, refreshing the page shows the chip cleanly with no `⟦ref: …⟧` text.
- [ ] Thread preview / recent-chats sidebar of a mention-bearing message also shows clean text.
- [ ] In the @ menu, the gap between connection name and integration type is consistent and small (~8px) regardless of name length.
- [ ] Long connection names truncate cleanly with an ellipsis.
