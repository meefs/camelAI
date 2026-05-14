# Phase 1 Feedback — Message Actions on Touch

## Verdict

**Ship it.** Clean, minimal, exactly per plan. One bonus catch from the agent. No blockers. One small follow-up recommended (regression test), and a few real-device QA items that still need a human.

## What Was Done

All 4 plan edits applied correctly with the exact class strings specified:

| Plan edit | Implementation | Status |
|-----------|----------------|--------|
| Edit 1 — default `actionHoverClassName` | [message-bubble.tsx:562](src/components/message-bubble.tsx#L562) | ✅ |
| Edit 2 — assistant-turn override | [Chat.tsx:1268](src/components/Chat.tsx#L1268) | ✅ |
| Edit 3 — touch-size on user Copy button | [message-bubble.tsx:783](src/components/message-bubble.tsx#L783) | ✅ |
| Edit 3 — touch-size on assistant Fork button | [message-bubble.tsx:832](src/components/message-bubble.tsx#L832) | ✅ |
| Edit 3 — touch-size on assistant Copy button | [message-bubble.tsx:849](src/components/message-bubble.tsx#L849) | ✅ |
| Edit 4 — `pointer-coarse:gap-1` on user row | [message-bubble.tsx:766](src/components/message-bubble.tsx#L766) | ✅ |
| Edit 4 — `pointer-coarse:gap-1` on assistant row | [message-bubble.tsx:819](src/components/message-bubble.tsx#L819) | ✅ |

### Bonus: the agent caught a 5th button I missed

The plan listed three Buttons to update. The agent found a **fourth** — the Copy button on the bug-report user-message variant at [message-bubble.tsx:711-718](src/components/message-bubble.tsx#L711-L718), with the matching action row container at [line 697](src/components/message-bubble.tsx#L697).

I verified the context: this row uses the same `showActionRow` gate and `actionVisibilityClassName`, so it has the identical hover-only invisibility bug. The agent's fix is correct — both the gap bump and the size override were applied consistently.

This is the right kind of initiative — extending the rule to a structurally identical case, not inventing scope.

### Confirmation of full coverage

`grep -n 'size="icon-sm"' src/components/message-bubble.tsx` returns exactly the 4 buttons that were updated (lines 713, 782, 831, 848). No `icon-sm` Buttons inside message-bubble.tsx were missed.

`grep pointer-coarse` confirms the 9 expected additions and zero stray uses elsewhere.

## Build / Lint

- `bun run typecheck` — **passes** (only a benign Vite plugin deprecation warning about `esbuild` → `oxc`, unrelated to this PR).
- `bun run lint` — **passes** (exit 0).

## Suggested Follow-Ups

### 1. Add a small regression test (recommended, not blocking)

The plan said to skip the test if no harness existed for `MessageBubble`. There **are** existing test files for this component (e.g. [tests/message-bubble-suppress-finalized-state.test.tsx](tests/message-bubble-suppress-finalized-state.test.tsx)) using Vitest + React Testing Library, with mocks already wired up for `Button`, `Tooltip`, `MarkdownRenderer`, etc. A one-line className assertion is cheap insurance against an accidental future refactor stripping the `pointer-coarse:` variant.

Suggested test (drop into a new `tests/message-bubble-touch-actions.test.tsx`):

```ts
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MessageBubble } from '@/components/message-bubble';

// Reuse the same mock setup as tests/message-bubble-suppress-finalized-state.test.tsx
// (copy the vi.mock blocks at the top of that file)

describe('MessageBubble action row touch visibility', () => {
  it('includes pointer-coarse:opacity-100 on the assistant action row', () => {
    const { container } = render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'assistant',
          content: 'hi',
          created_at: new Date().toISOString(),
        } as never}
        onCopy={() => {}}
        copiedId={null}
      />
    );
    const row = container.querySelector('[role="group"][aria-label="Message actions"]');
    expect(row?.className).toContain('pointer-coarse:opacity-100');
    expect(row?.className).toContain('pointer-coarse:gap-1');
  });
});
```

If the existing mocks don't expose the action row at first render (e.g. `showActionRow` defaults look wrong, or `hasContent` rejects the minimal message shape), borrow the message fixture from the streaming-indicator test file.

### 2. Optional cleanup: extract repeated class string to a constant

`text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4` is repeated verbatim 4 times in `message-bubble.tsx`. It's not enough repetition to be a real maintenance problem, but a small constant near the top of the file would prevent drift if the touch-target size changes:

```ts
const MESSAGE_ACTION_BUTTON_CLASS =
  "text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4";
```

Skip if you prefer to keep the file diff minimal — the duplication is local and bounded.

## Ready to Merge?

Yes. The code changes are correct and complete.
