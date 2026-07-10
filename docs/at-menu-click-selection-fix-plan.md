# Fix @ Menu Point-and-Click Selection — Implementation Plan

**Date:** 2026-07-10

**Branch:** `illianaa/fix-menu-click-selection`

**Primary implementation file:** [src/components/at-mention-menu/index.tsx](../src/components/at-mention-menu/index.tsx)

**Primary regression test:** [tests/prompt-input-mentions.test.tsx](../tests/prompt-input-mentions.test.tsx)

## Objective

Make every visible row in the chat composer's `@` menu work with a normal mouse or trackpad click.

After the user types `@` (or a filtered query such as `@alp`) and clicks a connection or project:

- replace the live trigger text with that item's canonical `@slug` plus one trailing space;
- close the menu;
- keep the textarea focused with the caret after the inserted space so the user can continue typing;
- preserve the existing keyboard behavior for Arrow keys, Enter, Tab, and Escape.

The zero-state **Add a connection** row must also remain clickable. Clicking anywhere outside the menu and composer must still blur the textarea and dismiss the menu without inserting anything.

## Current architecture

This is one shared-component bug, not separate project and connection bugs:

1. [src/components/prompt-input.tsx](../src/components/prompt-input.tsx) owns the textarea focus state, detects the live mention trigger, ranks the mixed project/connection list, inserts the selected slug, and renders `AtMentionMenu`.
2. [src/components/at-mention-menu/index.tsx](../src/components/at-mention-menu/index.tsx) renders the portaled shadcn/Radix `Popover` and headless `Command`/`CommandItem` rows.
3. `PromptInput` is reused by the welcome/new-chat composers and the existing-thread composer, so fixing `AtMentionMenu` fixes all of those surfaces.

No loader, mention-source refresh, slug generation, serialization, worker, or agent-context change is needed.

## Root cause

The menu is deliberately controlled by textarea focus:

```text
PromptInput isFocused
  -> useMentionTrigger(... enabled: isFocused ...)
  -> effectiveMenuOpen
  -> AtMentionMenu open
```

That is correct for genuine outside interactions, but a menu-row click currently follows this order:

| Order | Browser / React event | Current result |
| --- | --- | --- |
| 1 | `pointerdown` / `mousedown` lands on a `CommandItem` | The browser begins its normal focus-changing default action. |
| 2 | The textarea blurs before `click` | `PromptInput.onBlur` sets `isFocused` to `false`. |
| 3 | `PromptInput` rerenders | `useMentionTrigger` closes, `effectiveMenuOpen` becomes false, and the portaled menu unmounts. |
| 4 | The browser reaches `mouseup` / `click` | The row is gone, so cmdk cannot invoke its `onSelect`; the raw `@...` text remains unchanged. |

`cmdk@1.1.1` activates a `CommandItem` from its `click` handler, not from `mousedown`. The current `onOpenAutoFocus={(event) => event.preventDefault()}` only stops Radix from stealing focus when the popover first opens; it does not stop a later row press from blurring the textarea. `onCloseAutoFocus` is similarly too late.

Keyboard selection works because focus never leaves the textarea: `PromptInput.handleKeyDown` calls `insertMention` directly before any blur can occur.

The failure is reproducible in the existing jsdom/component-test stack with `userEvent.click`: the menu disappears, the textarea changes from focused to blurred, and its value remains `@`.

## Architecture decision

Preserve textarea focus during a menu item's **mouse-down default action**, then let the existing cmdk `click`/`onSelect` path perform the selection.

In [src/components/at-mention-menu/index.tsx](../src/components/at-mention-menu/index.tsx), add one small local handler (module-level or component-local) and attach it to every `CommandItem` rendered by this menu:

```tsx
function keepComposerFocused(event: MouseEvent<HTMLDivElement>) {
  event.preventDefault();
}

<CommandItem
  onMouseDown={keepComposerFocused}
  onSelect={() => onSelect(item)}
  // existing props
/>
```

Add the corresponding React `MouseEvent` type import. Apply the handler in both row branches:

- the normal connection/project item returned by `renderItem`;
- the zero-state **Add a connection** item.

Why this is the right boundary:

- `mousedown` occurs early enough to cancel the browser's focus transfer.
- `preventDefault()` does not cancel the later `click`, so cmdk remains the activation owner and the existing `onSelect` callbacks remain unchanged.
- Do **not** call `stopPropagation()`; Radix and cmdk must continue receiving the event sequence.
- Keeping the textarea focused matches keyboard selection and allows `insertMention`'s existing trigger guard, value replacement, lockout, and requestAnimationFrame caret placement to run normally.
- A row-level mouse handler does not interfere with touch scrolling or scrollbar dragging elsewhere in the popover.

This plan intentionally keeps the existing shadcn `Popover` + `Command` composition. No new primitive, package, or custom menu implementation is needed.

## Alternatives to avoid

- **Do not delay `onBlur` with a timer.** That creates a timing race and makes genuine outside dismissal nondeterministic.
- **Do not remove `isFocused` from `useMentionTrigger`'s enablement.** The menu should still close immediately when the composer genuinely loses focus.
- **Do not refocus the textarea from `onSelect`.** The current bug prevents `onSelect` from firing, so that cannot repair the event race; refocusing after a real blur would also trigger avoidable external focus/blur callbacks.
- **Do not insert the mention from `onMouseDown` or `onPointerDown`.** Selection should remain on cmdk's semantic `click`/`onSelect` path. Activating on press-down can select while a user is starting a drag or touch scroll.
- **Do not put this behavior into the shared [src/components/ui/command.tsx](../src/components/ui/command.tsx).** Most command menus own their own focused input or legitimately move focus; only this headless autocomplete keeps its input outside the portaled command.
- **Do not put a blanket `onMouseDown.preventDefault` on `PopoverContent`.** Keep the behavior scoped to actionable rows so future focusable content and the scroll area are not accidentally disabled.
- **Do not change `Popover.onOpenChange`, `onPointerDownOutside`, or the mention lockout refs.** They handle different dismissal/reopen cases and are not the cause of this bug.

## File-by-file implementation

### 1. `src/components/at-mention-menu/index.tsx`

- Import the React `MouseEvent` type.
- Add the focus-preserving mouse-down handler described above.
- Pass it to the mixed project/connection `CommandItem` in `renderItem`.
- Pass it to the **Add a connection** `CommandItem`.
- Leave each row's current `onSelect`, value, controlled highlight behavior, styling, and cursor unchanged.
- Add a short comment explaining the event ordering: the textarea owns menu open state, so its focus must survive until cmdk's click handler runs. This prevents a future cleanup from removing an otherwise non-obvious `preventDefault()`.

### 2. `tests/prompt-input-mentions.test.tsx`

Extend the shared `PromptInput` component tests; do not mock `AtMentionMenu` or cmdk, because the real blur-before-click sequence is the regression being guarded.

Add table-driven click-selection coverage for both entity kinds:

| Item | Action | Expected textarea value |
| --- | --- | --- |
| Connection: `Customers DB` | Type `@`, then `user.click` its visible row | `@customers_db ` |
| Project: `Alpha Site` | Type `@alp`, then `user.click` its visible row | `@alpha_site ` |

For each case, assert all of the following:

1. The textarea has focus and the target row is visible before the click.
2. A realistic `await user.click(...)` updates the controlled textarea value to the canonical slug with exactly one trailing space.
3. The mention menu closes after insertion.
4. The textarea still has focus after selection. If caret placement is asserted, wait for the existing animation-frame callback and expect a collapsed selection at the end of the inserted value.

Add two boundary regressions:

- With no mentionable items and an `onMentionAddNewClick` spy, clicking **Add a connection** calls the spy exactly once and closes the menu. This proves the second `CommandItem` branch receives the same focus-preservation behavior.
- Open the menu, then click a separate focusable element outside the composer. Assert the menu closes, no mention is inserted, and focus moves outside. This proves the fix did not weaken legitimate blur dismissal.

Keep the existing Enter-selection test. It guards the keyboard path and should pass without modification.

No E2E test is required for this focused event-order regression: the real `PromptInput`, Radix Popover, cmdk item, and `userEvent.click` already reproduce it deterministically in the component test. Perform the manual browser smoke checks below in addition to the automated test.

## Verification

Run the focused test first, then the normal frontend checks:

```bash
bun run test:run -- tests/prompt-input-mentions.test.tsx
bun run typecheck
bun run lint
```

Manual browser checks:

1. In a new chat composer, type `@`, click a connection, and immediately continue typing. Confirm the slug and one space were inserted, the menu closed, and typing continued at the end.
2. Repeat with a project and with a filtered query such as `@alp`.
3. Repeat connection and project selection in an existing `/chat/:id` thread; this confirms the shared fix reaches both composer owners.
4. Open the menu and click elsewhere in the page. Confirm it dismisses without changing the draft.
5. Verify Arrow Up/Down, Enter, Tab, and Escape still behave as before.
6. In a workspace with no mentionables, click **Add a connection** and confirm navigation to `/connections` occurs once.
7. With enough items to scroll, scroll the menu and then click a row; scrolling must not itself select an item.

## Acceptance criteria

- A single click on any visible connection row inserts that connection's canonical mention.
- A single click on any visible project row inserts that project's canonical mention.
- Filter text between `@` and the caret is replaced, not appended to.
- Selection inserts exactly one trailing space, closes the menu, keeps textarea focus, and leaves the caret after the space.
- **Add a connection** remains clickable and invokes its callback once.
- Clicking outside still blurs and dismisses without insertion.
- Keyboard selection and dismissal are unchanged.
- The fix is local to the shared `AtMentionMenu`; no mention data, ranking, slug, transcript, or backend behavior changes.

## Out of scope

- Restyling the menu or changing the hand cursor.
- Changing ranking, filtering, connection/project source refresh, or clone exclusion.
- Changing mention chip rendering, hover previews, parsing, annotation, or agent context.
- Replacing shadcn/Radix Popover or cmdk.
- Adding touch-specific gesture behavior beyond preserving the current click semantics.
