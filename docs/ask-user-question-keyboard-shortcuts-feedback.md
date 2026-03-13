# AskUserQuestion Keyboard Shortcuts — Implementation Feedback

## Overall

Strong implementation. All planned keyboard shortcuts are present and working: number keys, arrow navigation, Space toggle, Enter submit, Escape blur/collapse. The code is well-structured with good extraction of helpers (`createEmptyQuestionState`, `createInitialQuestionStates`, `ShortcutBadge`). The `data-ask-user-question-control` guard to avoid intercepting keystrokes on the header toggle and submit button is a smart addition that wasn't in the plan.

No new type errors were introduced (confirmed via `bun run typecheck` — all errors are pre-existing in `workers/main/`).

---

## Issues

### 1. Hooks called conditionally (React rules violation)

`useCallback` is called after an early return on line 126-128:

```typescript
const totalQuestions = data.questions.length;
if (totalQuestions === 0) {    // ← early return
  return null;
}
// ...
const focusContainer = useCallback(() => { ... }, []);  // ← hook after conditional return
```

This violates the Rules of Hooks. React requires hooks to be called in the same order on every render. If `data.questions` is ever empty, this will crash.

**Fix:** Move the `totalQuestions === 0` guard above the component's hook block (before all `useState`/`useEffect`/`useCallback` calls), or move the early return below all hooks. The simplest fix is to move the early return to the very top, before any hooks — but since the hooks depend on `data`, the cleanest approach is to keep all hooks where they are and move the early return to just before the `return (` JSX block, replacing `return null` with rendering nothing:

```tsx
// After all hooks, before JSX return:
if (totalQuestions === 0) {
  return null;
}
```

Actually — the hooks that reference `currentQuestion` (which depends on `data.questions[safeIndex]`) would fail if `totalQuestions === 0` because `data.questions[0]` would be `undefined`. So the fix needs to ensure all `useCallback`s that reference `currentQuestion`, `currentState`, `otherOptionIndex`, etc. are also safe. The most pragmatic fix: move `focusContainer`, `focusOtherInput`, `collapseWidget`, `handleExpandedChange`, `selectByIndex`, and `handleKeyDown` above the guard so they're always called, and have the guard only control the JSX output. The callbacks that reference `currentQuestion` will need to guard against it being undefined, or (simpler) just keep the `totalQuestions === 0` check in the JSX return only since `data.questions` is extremely unlikely to be empty in practice.

### 2. `focusContainer()` call after `selectByIndex` for number keys is redundant when selecting "Other"

When pressing `0` (or Space on the Other row), `selectByIndex` calls `focusOtherInput()` which focuses the text input. Then `handleKeyDown` immediately calls `focusContainer()` afterward (line 367-368), which pulls focus back to the container — undoing the Other input focus.

```typescript
if (event.key === "0") {
  event.preventDefault();
  setFocusedIndex(otherOptionIndex);
  selectByIndex(otherOptionIndex);   // ← focuses Other input via setTimeout
  focusContainer();                  // ← immediately focuses container, racing the setTimeout
}
```

The `setTimeout(0)` in `focusOtherInput` will win the race (it fires after the synchronous `focusContainer()`), so this likely works in practice. But it's fragile — the behavior depends on microtask ordering. Same issue exists for Space on the Other row (lines 346-349).

**Fix:** Don't call `focusContainer()` after `selectByIndex` when the selected index is the Other option. Or have `selectByIndex` return a boolean indicating whether it handled focus itself:

```typescript
if (event.key === "0") {
  event.preventDefault();
  setFocusedIndex(otherOptionIndex);
  selectByIndex(otherOptionIndex);
  // Don't call focusContainer — selectByIndex handles focus for "Other"
}
```

Apply the same pattern to the Space handler.

### 3. Composer refocus — `textareaRef` was already a prop but wasn't previously wired from Chat.tsx

The agent correctly identified that `prompt-input.tsx` already had a `textareaRef` prop and threaded a new ref from Chat.tsx. The type widening from `RefObject<HTMLTextAreaElement>` to `RefObject<HTMLTextAreaElement | null>` in `prompt-input.tsx` is fine and necessary for React 19's `useRef<T>(null)` returning `RefObject<T | null>`.

No issue here — just noting this was handled well.

---

## Nitpicks (Optional)

### 4. Redundant `focusedIndex` reset effect

There are two effects that reset `focusedIndex`:

```typescript
// Effect 1 (line 100-105): resets on questionId change
useEffect(() => {
  setCurrentQuestionIndex(0);
  setFocusedIndex(0);         // ← resets here
  setIsSubmitting(false);
  setQuestionStates(createInitialQuestionStates(data.questions));
}, [data.questionId]);

// Effect 2 (line 107-109): resets on questionId OR currentQuestionIndex change
useEffect(() => {
  setFocusedIndex(0);
}, [data.questionId, currentQuestionIndex]);
```

Effect 2 fires on `data.questionId` change too, so the `setFocusedIndex(0)` in Effect 1 is redundant. Not a bug — just an unnecessary extra state update on question arrival.

### 5. `isCurrentValid` is not memoized but used in `handleKeyDown` dependency array

`isCurrentValid` is a derived value computed on every render (line 255-257) and referenced inside `handleKeyDown`'s closure via the dependency array. Since it's recomputed each render, `handleKeyDown` is recreated each render too. This is fine for correctness but means the `useCallback` wrapper on `handleKeyDown` provides no memoization benefit. Not worth changing — just noting.

---

## Summary

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | **High** | Hooks called after conditional early return — React rules violation | Move early return below all hooks, or restructure so hooks are always called |
| 2 | **Low** | `focusContainer()` after `selectByIndex(otherOptionIndex)` creates a focus race | Skip `focusContainer()` when selecting Other |
| 3 | — | Composer refocus handled correctly | N/A |
| 4 | Nitpick | Redundant `setFocusedIndex(0)` in reset effect | Remove from Effect 1 |
| 5 | Nitpick | `isCurrentValid` in dependency array prevents memoization | Not worth fixing |
