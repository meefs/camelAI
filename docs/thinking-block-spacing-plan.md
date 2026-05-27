# Trace Spacing — Intermediary Messages Plan

**May 26, 2026**

---

## Problem

In the redesigned trace (see `docs/thinking-block-redesign-plan.md`), intermediary text messages — the assistant's natural-language asides between tool calls — sit visually too close to their neighboring trace rows. The gap above a text aside frequently reads as smaller than the gap below it, and overall the prose paragraphs feel "stuck" to whatever trace row precedes them.

From the user's screenshot (chiridion-app, expanded trace inside `TurnSummaryBar`):

```
Updated tasks                                       ← task_notification (trace, py-1)
Now let me build all the pieces in parallel:        ← TEXT (no own padding) — feels jammed up
  ● Read wrangler.jsonc                              ← tool (trace, py-1)
  ● Read app.ts                                      ← tool (trace, py-1)
  ● Read routes.ts                                   ← tool (trace, py-1)
  ● Thought                                          ← thinking (trace, py-1)
Now let me build the full app in parallel…         ← TEXT — also feels tight at top
  …
Ran cd booking-page && bun run typ…                ← tool (trace, py-1)
Good — only pre-existing template errors remain.   ← TEXT — feels jammed up against the tool above
Updated tasks                                       ← task_notification (trace, py-1)
```

The user wants:

- **More breathing room around intermediary text** (top AND bottom), in a way that reads as deliberate breaks between the trace rows and the model's prose interjections.
- **Tool / thinking / task / teammate rows unchanged.** They already have the right density.

This document audits where the spacing comes from and patches the one place that's missing — the text section wrapper inside `ContentBlockRenderer`.

---

## Spacing audit (current state)

Walking from outermost to innermost.

| # | Layer                                                           | Contributes (vertical) | Where                                                                                          |
| - | ---------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| 1 | `MessageBubble` (assistant) wrapper                              | `gap-1` (4px) between content + action row | `src/components/message-bubble.tsx:815` `<div className="flex flex-col gap-1">`               |
| 2 | Outer content wrapper                                            | `space-y-4` on a single child (no-op)      | `src/components/message-bubble.tsx:817` `<div className="max-w-none space-y-4">` — only wraps `ContentBlockRenderer`, so has no siblings to space |
| 3 | `ContentBlockRenderer` sections wrapper                          | **`space-y-4` (16px)** between sections    | `src/components/message-bubble.tsx:586` `<div className="space-y-4">{sections}</div>`         |
| 4 | Trace group (consecutive `tool_use` / `thinking` / `task_notification` / `teammate_message` items) | `space-y-1` (4px) between trace items | `src/components/message-bubble.tsx:566, 580` `<div className="space-y-1">{traceGroup}</div>`  |
| 5 | Individual trace row (`ToolCall`, `ThinkingBlock`, `TaskNotification`) | `py-1` (4px top + 4px bottom)              | `src/components/tool-call/tool-call.tsx:141`, `thinking-block.tsx` (post-redesign), `task-notification.tsx:44` |
| 6 | Individual **text section** wrapper                              | **0 (no padding, no margin)**              | `src/components/message-bubble.tsx:574` `<div key={item.key}>{item.node}</div>` ← the problem  |
| 7 | Markdown `<p>` inside text section                               | `mb-4 last:mb-0`; **no top margin**        | `src/components/markdown-renderer.tsx:382` `<p className="mb-4 last:mb-0 leading-relaxed">`   |
| 8 | Trailing `<p>` (last paragraph of a section)                     | `last:mb-0` → no bottom margin             | same as above                                                                                  |

**Effective gap calculations** (current code, after the thinking-block redesign):

| Boundary                                                     | Effective visual gap         |
| ------------------------------------------------------------ | ---------------------------- |
| Trace row (`py-1` bottom) → trace row (`py-1` top), same group | `4 + 4 + 4` (space-y-1 = 4) = **12px** between glyph rows |
| Trace row (`py-1` bottom) → **text section**                 | `4 + 16 + 0` = **20px** above first glyph                |
| **Text section** → trace row (`py-1` top)                    | `0 + 16 + 4` = **20px** below last glyph                 |
| Single-paragraph text section                                | nothing inside — relies entirely on outer 16px           |
| Multi-paragraph text section                                 | `mb-4` (16px) between paragraphs internally             |

The math is symmetric. But the perceived gap isn't symmetric, for two reasons:

1. **Line-height asymmetry across the boundary.** Tool rows use `text-sm` with the default Tailwind line-height; markdown text uses `text-base leading-relaxed` (line-height 1.625 → ~26px for 16px text). The text contributes ~5px of half-leading above its first glyph and ~5px below its last glyph. That's invisible padding that *only* the text side has, and it makes the optical gap between a tool row and the text below look smaller than the gap between a text and the tool below it.
2. **Identical 16px gap matches the internal `<p>` paragraph spacing.** When a text section happens to be multi-paragraph, the 16px above/below the section reads exactly like another paragraph break — the text section visually bleeds into its surroundings.

In other words: even though the math says symmetric, the *intended* hierarchy isn't visible. The trace → text → trace transitions should read as a distinct break, not just one more 16px paragraph gap.

---

## Fix

Add vertical padding to the **text section wrapper** inside `ContentBlockRenderer`. This is the one layer (#6 in the audit) that currently contributes zero.

### Visual target

```
BEFORE                                AFTER
─ Updated tasks ─                     ─ Updated tasks ─
                  ↑ 20px (incl 4px    
Now let me build all the pieces:        ↑ ~32px (incl new py-2)
                  ↑ 20px               Now let me build all the pieces:
─ Read wrangler.jsonc ─                                  ↑ ~32px (incl new py-2)
                                      ─ Read wrangler.jsonc ─
```

Concretely: the text section wrapper grows from `0` padding to `py-2` (8px top + 8px bottom). Tool calls and thinking blocks are untouched.

Effective new gaps:

| Boundary                                  | New visual gap                                                |
| ----------------------------------------- | ------------------------------------------------------------- |
| Trace row → text section                  | `4 (tool py-1) + 16 (space-y-4) + 8 (text py-2) = ` **28px**  |
| Text section → trace row                  | `8 (text py-2) + 16 (space-y-4) + 4 (tool py-1) = ` **28px**  |
| Trace row → trace row (same group)        | **unchanged** (12px)                                          |
| Inside trace group spacing                | **unchanged**                                                 |
| Tool row internal `py-1`                  | **unchanged**                                                 |
| Thinking row internal `py-1`              | **unchanged** (matches tool calls per redesign)               |

The result: 28px of breathing room on either side of intermediary text, vs. 12px between trace rows in the same group. The hierarchy reads as `(text) >> (trace group)` which matches the model: the prose interjection is a higher-level break, the trace items within a group are tightly related.

`py-2` (8px) is the right step. `py-1` (4px) is too subtle (only adds 8px combined, so text gap goes 20 → 24 — barely noticeable). `py-3` (12px) over-pads and starts to feel like a section break. `py-2` lands the gap at ~28px above and below, distinctly larger than the 12px trace-row gap.

---

## File-by-file changes

### `src/components/message-bubble.tsx`

Two-line change inside `ContentBlockRenderer`'s section loop, plus the trailing flush (`sections.push` after the `forEach`). Both `sections.push` calls for `kind: 'other'` items get a wrapper class.

**Current (line ~573–576):**

```tsx
items.forEach((item, index) => {
  if (item.kind === 'trace') {
    if (!traceGroup.length) traceGroupKey = `trace-${item.key}-${index}`;
    traceGroup.push(<div key={item.key}>{item.node}</div>);
    return;
  }

  if (traceGroup.length) {
    sections.push(
      <div key={traceGroupKey} className="space-y-1">
        {traceGroup}
      </div>
    );
    traceGroup = [];
  }

  sections.push(
    <div key={item.key}>{item.node}</div>
  );
});
```

**New:**

```tsx
items.forEach((item, index) => {
  if (item.kind === 'trace') {
    if (!traceGroup.length) traceGroupKey = `trace-${item.key}-${index}`;
    traceGroup.push(<div key={item.key}>{item.node}</div>);
    return;
  }

  if (traceGroup.length) {
    sections.push(
      <div key={traceGroupKey} className="space-y-1">
        {traceGroup}
      </div>
    );
    traceGroup = [];
  }

  // Intermediary text/error sections get extra breathing room so they
  // don't blur into adjacent trace rows. Trace rows already self-pad with py-1.
  sections.push(
    <div key={item.key} className="py-2">{item.node}</div>
  );
});
```

No change is needed in the trailing flush (`if (traceGroup.length) { … }`) — that block only ever appends a trace group, never a text section. And no change to the outer `<div className="space-y-4">{sections}</div>`.

### Why a wrapper class and not a global `space-y-*` bump

- A global bump (`space-y-6` instead of `space-y-4`) would also pad the gaps *between trace groups*, which the user explicitly does not want.
- Using a wrapper class scopes the extra padding to text/error sections only.
- The trace-group section is *also* a sibling of text sections inside `space-y-4`, but trace groups keep their own internal `space-y-1`; they aren't affected by adding padding to text sections — the symmetric outer gap is preserved.

### Why not `my-2` instead of `py-2`

Either works visually, but `py-2` is more predictable when collapsed margins are in play. `space-y-*` in Tailwind composes margins between siblings, and adding margin to a child can interact with the parent's `space-y-*` algorithm in ways that depend on the rendered DOM. Padding on the wrapper sidesteps that and reads exactly as written.

---

## Edge cases & behavior

- **Text-only assistant turn (no trace rows).** The whole message is one text section, wrapped in `py-2`. Net effect: 8px of extra top + 8px of extra bottom inside the message bubble's content column. The action row (line ~831) sits underneath with the existing `gap-1` (4px). This is a harmless extra 16px of vertical air for plain-text replies. If review prefers no change for these, we can scope the wrapper class so it only applies when there is at least one `trace` item in the message — see the optional refinement below.
- **Error sections (`kind: 'other'`).** They get the same `py-2`. Errors are visually heavy (border + bg already), and extra padding around them is fine.
- **Final-output-only render mode** (`renderMode === 'final-text-only'`, below the `TurnSummaryBar` hairline). The final answer typically renders as a single text section; `py-2` adds 8px above the answer and 8px below it (between the answer and the action row). This is harmless and arguably helpful — it gives the final answer a touch more weight.
- **Trace-only render mode** (`renderMode === 'trace-only'`, inside the `TurnSummaryBar`). Intermediary text blocks (`buildTraceMessageView` keeps them) go through the same renderer; they get `py-2`. That's the scenario the user's screenshot illustrates, and it's the primary target.
- **Two consecutive text sections.** Currently impossible inside a single assistant message after content normalization, but defensive: two `py-2` siblings inside `space-y-4` would yield `8 + 16 + 8 = 32px` between them. Still reads as a paragraph break — acceptable.

### Optional refinement (only if reviewers want it)

If `py-2` on plain text-only messages feels like too much, scope the change so it applies *only when the message contains at least one trace row*. Compute one flag before the section loop:

```ts
const hasTraceItem = items.some((item) => item.kind === 'trace');
```

Then:

```tsx
sections.push(
  <div key={item.key} className={hasTraceItem ? 'py-2' : undefined}>
    {item.node}
  </div>
);
```

I do **not** recommend shipping this refinement first. The unconditional `py-2` is simpler, the small extra vertical air on plain replies is benign, and review will tell us within a session if it actually feels off.

---

## Components & dependencies used

None new. Single Tailwind utility class (`py-2`) added to one existing `<div>`.

---

## Testing

### Manual verification

Render an assistant turn that interleaves trace rows with intermediary text:

1. Send a prompt that produces at least one intermediary "let me…" / "now I'll…" text aside between tool calls. For example, "scaffold a small booking app and tell me what you're doing as you go."
2. Confirm:
   - The text aside has visibly more breathing room above and below than the surrounding trace rows have between themselves.
   - The trace rows themselves are unchanged — same dot/label/chevron sizing, same internal `py-1`, same `space-y-1` between siblings.
   - When the turn collapses into `TurnSummaryBar`, expanding it shows the same spacing inside.
3. Test edge cases:
   - **Plain text-only reply** ("what's 2+2"): the reply should look fine, slightly more vertical air than before, action row position unchanged relative to the text.
   - **Trace ending in a tool call** (no intermediary text): no visible change.
   - **Multi-paragraph intermediary text**: the section's own `py-2` adds 8px above the first paragraph and 8px below the last; internal paragraph-to-paragraph gaps (`mb-4`) are unchanged.
4. **Reduce-motion / theme.** Switch themes light↔dark, toggle reduce-motion. No interaction with this change; spacing is pure layout.

### Unit / snapshot tests

This is a one-class change to one render path. The existing `tests/message-bubble*.test.tsx` files (and the new ones from the thinking-block redesign plan) should continue to pass without modification. Optionally, a small DOM assertion in `tests/message-bubble-thinking.test.tsx` can verify the wrapper class:

```ts
it('wraps intermediary text sections with py-2 padding', () => {
  // Render a message with [tool_use, text, tool_use] and assert the
  // text section's wrapping <div> has the class "py-2".
});
```

Not strictly required — `bun run typecheck` + manual verification is sufficient.

### Test commands

```bash
bun run typecheck
bun run test:run -- tests/message-bubble-thinking.test.tsx
```

---

## Implementation order

1. Apply the one-line `className="py-2"` change to `src/components/message-bubble.tsx`.
2. `bun run typecheck` (sanity).
3. Manual QA against a real chat turn that mixes tool calls and intermediary text (the user's screenshot scenario).
4. If review feels the plain-text-reply case is now too tall, apply the optional refinement (gated `hasTraceItem` flag).

---

## Why this is enough

There are two other places I considered touching and explicitly chose not to:

- **`<p className="mb-4 last:mb-0">` margins in `MarkdownRenderer`.** Tempting to bump `mb-4` → `mb-6`, but that affects every prose paragraph in the entire app (assistant replies, mentions, error messages, notebook output, …). Out of scope, and would over-correct.
- **`space-y-4` on the outer `ContentBlockRenderer` wrapper.** Bumping it to `space-y-6` would also widen the gap between adjacent trace groups (rare but possible — e.g., a trace group, an `error` block, then another trace group). The user wants trace-row density preserved; widening `space-y-*` would push everything apart.

The text-section wrapper is the right surgical layer: it's the only one that currently contributes zero, and it only affects the sections the user wants to push apart.

---

## Summary

| # | Part                                | Files                                  | What it does                                                                  |
| - | ----------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| 1 | Add `py-2` to text/error section wrapper | `src/components/message-bubble.tsx`    | Adds 8px top + 8px bottom around intermediary text, lifting the optical gap from ~20px to ~28px on each side without touching trace rows |
