# AskUserQuestion: Full Keyboard Navigation

## Problem

The AskUserQuestion widget requires mouse clicks for every interaction: selecting options, advancing through multi-question flows, and submitting answers. This friction causes users to abandon questions without submitting. The widget currently has **zero keyboard handling** — no Enter to submit, no number keys to select, no arrow key navigation.

```
Current flow (all mouse):

  ┌─────────────────────────────────────────┐
  │  Claude needs your input            ▴   │
  │                                         │
  │  Which framework do you want?           │
  │                                         │
  │  ○  Next.js          ← click to select  │
  │  ○  Remix            ← click to select  │
  │  ○  Astro            ← click to select  │
  │  ○  Other                               │
  │                                         │
  │                    [Submit] ← click      │
  └─────────────────────────────────────────┘
```

## Goal

Users should be able to answer any AskUserQuestion without touching their mouse. The complete keyboard interaction for a single-select question should be: see widget appear (auto-focused) → press a number → press Enter. Done.

```
Target flow (keyboard-only):

  ┌─────────────────────────────────────────┐
  │  Claude needs your input            ▴   │
  │                                         │
  │  Which framework do you want?           │
  │                                         │
  │  1  ○  Next.js                          │
  │  2  ●  Remix         ← ─── focused ───  │
  │  3  ○  Astro                            │
  │  0  ○  Other                            │
  │                                         │
  │  # to pick · ↵ submit       [Submit ▸]  │
  └─────────────────────────────────────────┘

  User presses: 2 → Enter
  Result: "Remix" submitted — zero mouse interaction
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit current question / advance to next question (when valid selection exists) |
| `1`–`9` | Select option N (single-select: replace, multi-select: toggle) |
| `0` | Select "Other" + auto-focus its text input |
| `↑` / `↓` | Move focus highlight between options (wraps around) |
| `Space` | Toggle the currently focused option (standard a11y pattern) |
| `Escape` | If in "Other" text input: blur back to widget. Otherwise: collapse the widget. |

---

## Design

### Single-Select with Number Badges

Each option gets a small `<kbd>` badge showing its shortcut key. "Other" is always `0`.

```
  ┌─────────────────────────────────────────┐
  │  Claude needs your input            ▴   │
  │                                         │
  │  Which framework do you want?           │
  │                                         │
  │ ┌─┐                                     │
  │ │1│ ○  Next.js                          │
  │ └─┘                                     │
  │ ┌─┐                                     │
  │ │2│ ○  Remix          ← focused row     │  ← ring-1 ring-ring/50 bg-muted/10
  │ └─┘                                     │
  │ ┌─┐                                     │
  │ │3│ ○  Astro                            │
  │ └─┘                                     │
  │ ┌─┐                                     │
  │ │0│ ○  Other                            │
  │ └─┘                                     │
  │                                         │
  │  # to pick · ↵ submit       [Submit ▸]  │
  └─────────────────────────────────────────┘
```

Badge styling:
```
text-[10px] font-mono text-muted-foreground/40
w-4 h-4 inline-flex items-center justify-center
rounded border border-border/30 shrink-0
```

### Multi-Select Flow

Number keys toggle checkboxes on/off. Multiple selections accumulate, then Enter submits.

```
  ┌─────────────────────────────────────────┐
  │  Claude needs your input            ▴   │
  │                                         │
  │  Which tools should I set up?           │
  │                                         │
  │  1  ☑  ESLint        ← toggled on      │
  │  2  ☐  Prettier                         │
  │  3  ☑  TypeScript    ← toggled on      │
  │  0  ☐  Other                            │
  │                                         │
  │  # to pick · ↵ submit       [Submit ▸]  │
  └─────────────────────────────────────────┘

  User presses: 1 → 3 → Enter
  Result: "ESLint, TypeScript" submitted
```

### "Other" Text Input Flow

Pressing `0` (or arrow-navigating to Other and pressing Space) selects Other and auto-focuses the text input. While typing in the text input, number keys and arrow keys are suppressed so they don't interfere. `Enter` still submits. `Escape` blurs back to the widget container.

```
  ┌─────────────────────────────────────────┐
  │                                         │
  │  0  ●  Other          ← selected       │
  │       ┌─────────────────────────┐       │
  │       │ SvelteKit|              │       │  ← autoFocus, Enter submits
  │       └─────────────────────────┘       │
  │                                         │
  │  # to pick · ↵ submit       [Submit ▸]  │
  └─────────────────────────────────────────┘
```

### Arrow Key Focus Navigation

Arrow keys move a visible focus ring between option rows. The focused row gets `ring-1 ring-ring/50 bg-muted/10`. Focus wraps: pressing `↓` on the last option goes back to the first.

```
  Before (focused on row 2):        After pressing ↓ (focused on row 3):

  │  1  ○  Next.js              │   │  1  ○  Next.js              │
  │  2  ○  Remix    ← focused   │   │  2  ○  Remix                │
  │  3  ○  Astro                │   │  3  ○  Astro    ← focused   │
  │  0  ○  Other                │   │  0  ○  Other                │
```

### Multi-Question Navigation

For multi-question flows, the same keyboard shortcuts apply per-question. `Enter` advances to the next question (same as clicking "Next"), and on the last question `Enter` submits all answers.

```
  Question 1 of 3:                   Question 2 of 3 (after pressing Enter):

  │  Which framework?           │   │  Which database?            │
  │                             │   │                             │
  │  1  ●  Remix    ← selected │   │  1  ○  PostgreSQL           │
  │  2  ○  Next.js             │   │  2  ○  SQLite    ← focused  │
  │                             │   │  3  ○  MySQL                │
  │  1/3   [Next ▸] or Enter   │   │  2/3   [Next ▸] or Enter    │
```

Focus resets to the first option when advancing to the next question.

### Footer Keyboard Hint

A subtle hint in the footer teaches the shortcuts. Always visible (small enough to be unobtrusive).

```
  # to pick · ↵ submit
```

Styling: `text-[10px] text-muted-foreground/30`

The hint updates for multi-question flows:
- Not last question: `# to pick · ↵ next`
- Last question: `# to pick · ↵ submit`

---

## Implementation

All changes are in two files. The backend/WebSocket flow is unchanged — this is purely client-side.

### File 1: `src/components/ask-user-question.tsx`

#### 1. New State and Refs

```typescript
const [focusedIndex, setFocusedIndex] = useState(0);
const containerRef = useRef<HTMLDivElement>(null);
```

- `focusedIndex`: 0-based index into the option list (includes "Other" as the last index)
- Reset `focusedIndex` to `0` in the existing `useEffect` that fires on `data.questionId` change
- Also reset `focusedIndex` to `0` when `currentQuestionIndex` changes (advancing through multi-question flow)

#### 2. Auto-Focus on Mount

```typescript
useEffect(() => {
  const timer = setTimeout(() => containerRef.current?.focus(), 100);
  return () => clearTimeout(timer);
}, [data.questionId]);
```

Small delay lets the slide-in animation complete before grabbing focus. This steals focus from the composer, which is correct — the widget is blocking the conversation and needs a response.

#### 3. `selectByIndex` Helper

Centralizes selection logic for both number keys and Space-on-focused-option:

```typescript
const selectByIndex = useCallback((index: number) => {
  const isOtherIndex = index === currentQuestion.options.length;

  if (isOtherIndex) {
    if (currentQuestion.multiSelect) {
      handleMultiSelect(currentQuestion.question, '__other__', !currentState.isOther);
    } else {
      handleSingleSelect(currentQuestion.question, '__other__');
    }
    // Focus the Other text input after a tick
    setTimeout(() => {
      containerRef.current?.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
    }, 0);
  } else {
    const option = currentQuestion.options[index];
    if (currentQuestion.multiSelect) {
      const isCurrentlySelected = currentState.selected.includes(option.label);
      handleMultiSelect(currentQuestion.question, option.label, !isCurrentlySelected);
    } else {
      handleSingleSelect(currentQuestion.question, option.label);
    }
  }
}, [currentQuestion, currentState, handleSingleSelect, handleMultiSelect]);
```

#### 4. Keyboard Handler

Single `onKeyDown` on the container `<div>`. Critical: number/arrow/space keys are suppressed when the user is typing in the "Other" text input.

```typescript
const totalOptions = currentQuestion.options.length + 1; // +1 for "Other"

const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
  const isInOtherInput = (e.target as HTMLElement).tagName === 'INPUT';

  // Enter: always submits (even from inside Other text input)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (isCurrentValid && !isSubmitting) {
      handleNextOrSubmit();
    }
    return;
  }

  // Escape: blur Other input → collapse widget
  if (e.key === 'Escape') {
    if (isInOtherInput) {
      containerRef.current?.focus();
    } else {
      setIsExpanded(false);
    }
    return;
  }

  // Everything below is suppressed when typing in Other input
  if (isInOtherInput) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setFocusedIndex(i => (i + 1) % totalOptions);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setFocusedIndex(i => (i - 1 + totalOptions) % totalOptions);
  } else if (e.key === ' ') {
    e.preventDefault();
    selectByIndex(focusedIndex);
  } else if (e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key) - 1;
    if (idx < currentQuestion.options.length) {
      selectByIndex(idx);
      setFocusedIndex(idx);
    }
  } else if (e.key === '0') {
    selectByIndex(currentQuestion.options.length);
    setFocusedIndex(currentQuestion.options.length);
  }
}, [isCurrentValid, isSubmitting, handleNextOrSubmit, totalOptions, focusedIndex, selectByIndex]);
```

#### 5. Container Element Changes

The outermost `<div>` gets `tabIndex`, `ref`, `onKeyDown`, and an outline suppression:

```tsx
<div
  ref={containerRef}
  tabIndex={0}
  onKeyDown={handleKeyDown}
  className={cn(
    "rounded-xl border border-border/50 bg-background/95 backdrop-blur-sm shadow-sm",
    "overflow-hidden outline-none",
    "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
    className
  )}
>
```

Note `outline-none` — the container itself shouldn't show a browser focus ring; the individual option rows show the focus highlight instead.

#### 6. Number Badge on Each Option Row

Insert a `<kbd>` element before each option's radio/checkbox. For regular options:

```tsx
<kbd className="inline-flex h-4 w-4 items-center justify-center rounded border border-border/30 text-[10px] font-mono text-muted-foreground/40 shrink-0">
  {optIndex + 1}
</kbd>
```

For the "Other" row:

```tsx
<kbd className="inline-flex h-4 w-4 items-center justify-center rounded border border-border/30 text-[10px] font-mono text-muted-foreground/40 shrink-0">
  0
</kbd>
```

Layout change per option `<label>`:

```
Before:  <label className="flex items-start gap-3 ...">
           <Checkbox ... />
           <div>label text</div>
         </label>

After:   <label className="flex items-start gap-3 ...">
           <kbd>1</kbd>
           <Checkbox ... />
           <div>label text</div>
         </label>
```

If there are more than 9 options (unlikely), only the first 9 get number badges. Options 10+ are still selectable via arrow+Space or mouse.

#### 7. Focus Ring on Option Rows

Each option row `<label>` gets a conditional focus ring class based on `focusedIndex`:

```tsx
<label
  className={cn(
    "flex items-start gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
    "transition-colors hover:bg-muted/20",
    focusedIndex === optIndex && "ring-1 ring-ring/50 bg-muted/10"
  )}
>
```

The "Other" row uses `focusedIndex === currentQuestion.options.length` for its condition.

#### 8. Footer with Keyboard Hint

Replace the existing footer `<div>`:

```tsx
<div className="flex items-center justify-between gap-3 px-4 pb-3 pt-2">
  <span className="text-[10px] text-muted-foreground/30">
    # to pick · ↵ {isLastQuestion ? 'submit' : 'next'}
  </span>
  <div className="flex items-center gap-3">
    {hasMultipleQuestions && (
      <span className="text-xs text-muted-foreground/50">
        {currentQuestionIndex + 1} of {totalQuestions}
      </span>
    )}
    <Button
      variant="ghost"
      size="sm"
      onClick={handleNextOrSubmit}
      disabled={!isCurrentValid || isSubmitting}
      className="text-muted-foreground hover:text-foreground"
    >
      {/* existing button content unchanged */}
    </Button>
  </div>
</div>
```

#### 9. Aria Attributes

On the options container div (wrapping the radio group or checkbox list):

```tsx
<div role="listbox" aria-label={currentQuestion.question} aria-activedescendant={`auq-option-${focusedIndex}`}>
```

On each option `<label>`:

```tsx
<label
  role="option"
  id={`auq-option-${optIndex}`}
  aria-selected={isSelected}
  ...
>
```

Where `isSelected` is `currentState.selected.includes(opt.label)` for regular options and `currentState.isOther` for the Other row.

---

### File 2: `src/components/Chat.tsx`

#### Refocus Composer After Submit

In the `handleQuestionResponse` callback, after `setPendingQuestion(null)`, return focus to the composer so the user can immediately type their next message:

```typescript
const handleQuestionResponse = useCallback((answers: Record<string, string>) => {
  if (!pendingQuestion || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
    return;
  }
  wsRef.current.send(JSON.stringify({
    type: 'question_response',
    questionId: pendingQuestion.questionId,
    answers,
  }));
  setPendingQuestion(null);

  // Return focus to the composer
  setTimeout(() => {
    document.querySelector<HTMLTextAreaElement>('[data-composer-textarea]')?.focus();
  }, 0);
}, [pendingQuestion]);
```

The composer textarea needs a `data-composer-textarea` attribute for this selector to work. Check if it already has one or an equivalent ref/id — use whatever existing identifier is available. If the composer uses a ref that's accessible in this scope, prefer `ref.current?.focus()` over a DOM query.

---

## Files to Modify (Summary)

| File | Change |
|------|--------|
| `src/components/ask-user-question.tsx` | `focusedIndex` + `containerRef` state, `onKeyDown` handler, `selectByIndex` helper, number badge `<kbd>` elements, focus ring styles on option rows, auto-focus `useEffect`, footer hint text, aria attributes on options container + rows |
| `src/components/Chat.tsx` | Refocus composer textarea after `setPendingQuestion(null)` in `handleQuestionResponse` |

## Components Used

- All existing shadcn/ui components stay as-is: `Button`, `Checkbox`, `RadioGroup`, `RadioGroupItem`, `Input`, `Collapsible`
- No new shadcn/ui installs needed
- New: `<kbd>` HTML element styled with Tailwind for number badges
- No new dependencies

## Not in Scope

- Changes to the backend / WebSocket event flow — keyboard shortcuts are purely client-side
- Changes to `ask-user-question-details.tsx` (the post-answer display component)
- Changes to `tool-summary.ts`
- Changes to how multi-question pagination works (still one-at-a-time with Next/Submit)
