# AskUserQuestion - Styling Redesign Plan

This document outlines the design and implementation plan for restyling the `AskUserQuestion` component to match the minimal, sleek aesthetic of the `FloatingTodoList` component.

---

## Problem Statement

The current `AskUserQuestion` component uses primary accent colors and bold styling that feels verbose and bulky compared to the rest of the app's minimal design. Specifically:

1. **Heavy color scheme**: Uses `bg-primary/5`, `border-primary/20`, `bg-primary/10` which creates a highlighted "callout" effect
2. **Prominent header**: Distinct background color draws too much attention
3. **Verbose option cards**: Each option has heavy borders, padding, and hover states
4. **Too much visual weight**: Multiple `font-medium` usages make text feel bold/prominent

**Goal:** Restyle to match the "whisper, don't shout" philosophy of the `FloatingTodoList` while maintaining all existing functionality.

---

## Reference Design Analysis

### Current AskUserQuestion (Verbose)

```
┌─────────────────────────────────────────────────────────────────┐
│ [?] Claude needs your input                    ← PRIMARY BG    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─ Question Type ─┐                          ← BADGE          │
│   └─────────────────┘                                           │
│   What framework should I use?                 ← BOLD TEXT      │
│                                                                 │
│   ┌───────────────────────────────────────────────────────┐    │
│   │ ○ React                                               │    │
│   │   A popular library for building UIs                  │    │ ← HEAVY
│   └───────────────────────────────────────────────────────┘    │   BORDERS
│   ┌───────────────────────────────────────────────────────┐    │
│   │ ○ Vue                                                 │    │
│   │   Progressive framework                               │    │
│   └───────────────────────────────────────────────────────┘    │
│   ┌───────────────────────────────────────────────────────┐    │
│   │ ○ Other                                               │    │
│   └───────────────────────────────────────────────────────┘    │
│                                                                 │
│   ┌──────────────────────────────────────────────────────┐     │
│   │              ➤ Submit Response                       │     │ ← FULL WIDTH
│   └──────────────────────────────────────────────────────┘     │   BUTTON
└─────────────────────────────────────────────────────────────────┘
```

### Target Design (Minimal - Inspired by FloatingTodoList)

```
┌─────────────────────────────────────────────────────────────────┐
│  ?  Claude needs your input                               ▾    │ ← MUTED, SUBTLE
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
│                                                                 │
│   What framework should I use?                 ← QUESTION ONLY  │
│                                                  (no badge)     │
│   ○ React                                                       │
│     A popular library for building UIs         ← INLINE, SIMPLE │
│                                                                 │
│   ○ Vue                                                         │
│     Progressive framework                                       │
│                                                                 │
│   ○ Other                                                       │
│     [ Type your answer... ]                                     │
│                                                  ┌────────────┐ │
│                                                  │  Submit ➤  │ │ ← COMPACT
│                                                  └────────────┘ │   ALIGNED
└─────────────────────────────────────────────────────────────────┘
```

---

## Design Decisions

### 1. Container Styling

**Before:**
```tsx
"rounded-xl border border-primary/20 bg-primary/5"
```

**After:**
```tsx
"rounded-xl border border-border/50 bg-background/95 backdrop-blur-sm shadow-sm"
```

- Use neutral border (`border-border/50`) instead of primary accent
- Background blur for subtle elevation like todo list
- Light shadow for depth without heavy colors

### 2. Header Redesign

**Before:**
- Distinct `bg-primary/10` background
- Primary-colored icon and text
- No collapse functionality

**After:**
- No distinct background (matches container)
- Muted text color (`text-muted-foreground`)
- Subtle icon (`text-muted-foreground/60`)
- Clickable to collapse/expand (Radix Collapsible)
- Hover state: `hover:bg-muted/30`

### 3. Question Header Badge → Removed

**Before:**
```tsx
<span className="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-muted text-muted-foreground">
  {q.header}
</span>
```

**After:** Remove entirely.

The `header` field (e.g., "Auth method", "Library") comes from the Claude SDK but adds visual noise without much value. The question text itself is self-explanatory. We simply don't render `q.header` anymore.

### 4. Option Cards → Option Rows

**Before:** Heavy bordered cards with backgrounds
```tsx
"flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
"border-primary bg-primary/5" // selected
"border-border hover:border-primary/50 hover:bg-muted/50" // unselected
```

**After:** Simple inline rows (like todo items)
```tsx
"flex items-start gap-3 py-2 cursor-pointer transition-colors"
"hover:bg-muted/20 rounded-md px-2 -mx-2" // hover only, no permanent border
```

- Remove borders entirely
- Minimal padding
- Only show selection state on the radio/checkbox itself
- Optional: Very subtle background on hover

### 5. Submit Button

**Before:**
- Full-width button
- Heavy visual presence

**After:**
- Right-aligned, compact button
- Muted styling, primary only on hover
- Ghost or outline variant

### 6. Collapsible Behavior (New)

Add ability to collapse the question panel:
- Default state: expanded
- Click header to toggle
- Chevron icon indicates state
- Same animation as todo list: `animate-collapsible-down` / `animate-collapsible-up`

---

## Color Palette Comparison

| Element | Current | Target |
|---------|---------|--------|
| Container border | `border-primary/20` | `border-border/50` |
| Container bg | `bg-primary/5` | `bg-background/95 backdrop-blur-sm` |
| Header bg | `bg-primary/10` | none (transparent) |
| Header text | `text-primary` | `text-muted-foreground` |
| Header icon | `text-primary` | `text-muted-foreground/60` |
| Question text | `text-foreground font-medium` | `text-foreground text-sm` |
| Option label | `text-foreground font-medium` | `text-muted-foreground text-sm` |
| Option desc | `text-muted-foreground text-xs` | `text-muted-foreground/60 text-xs` |
| Selected state | `border-primary bg-primary/5` | Radio/checkbox state only |
| Submit button | Primary, full-width | Ghost/outline, compact |

---

## Component Architecture

### File Changes

The redesign modifies a single file but restructures internally:

```
src/components/
├── ask-user-question.tsx       # Restyle existing component
```

Alternatively, for better organization (optional):
```
src/components/
├── ask-user-question/
│   ├── index.tsx               # Main export
│   ├── ask-user-question.tsx   # Container component
│   ├── question-header.tsx     # Collapsible header
│   ├── question-item.tsx       # Individual question section
│   └── option-row.tsx          # Option with radio/checkbox
```

**Recommendation:** Keep as single file unless complexity grows significantly. The current structure is manageable.

### Updated Component Hierarchy

```tsx
<AskUserQuestion data={data} onSubmit={onSubmit}>
  <Collapsible>
    <CollapsibleTrigger>
      <QuestionHeader />   {/* Icon + "Claude needs your input" + chevron */}
    </CollapsibleTrigger>

    <CollapsibleContent>
      <ScrollArea>         {/* For multiple questions */}
        {questions.map(q => (
          <QuestionSection>
            <QuestionText />
            <OptionList>
              {options.map(opt => <OptionRow />)}
              <OtherOption />
            </OptionList>
          </QuestionSection>
        ))}
      </ScrollArea>

      <SubmitFooter>       {/* Right-aligned submit button */}
        <Button variant="ghost" />
      </SubmitFooter>
    </CollapsibleContent>
  </Collapsible>
</AskUserQuestion>
```

---

## Detailed Styling Specifications

### Container

```tsx
<div
  className={cn(
    "rounded-xl border border-border/50 bg-background/95 backdrop-blur-sm shadow-sm",
    "overflow-hidden",
    "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
    className
  )}
>
```

### Header (Collapsible Trigger)

```tsx
<button
  className={cn(
    "flex w-full items-center gap-2 px-4 py-3",
    "text-sm text-muted-foreground",
    "hover:bg-muted/30 transition-colors",
    "cursor-pointer"
  )}
>
  <MessageCircleQuestion className="h-4 w-4 text-muted-foreground/60" />
  <span className="flex-1 text-left">Claude needs your input</span>
  {isExpanded ? (
    <ChevronUp className="h-4 w-4 text-muted-foreground/40" />
  ) : (
    <ChevronDown className="h-4 w-4 text-muted-foreground/40" />
  )}
</button>
```

### Question Section

```tsx
<div className="px-4">
  {/* Question text only - no header badge */}
  <p className="text-sm text-foreground">{q.question}</p>
</div>
```

### Option Row (Radio)

```tsx
<label
  className={cn(
    "flex items-start gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
    "transition-colors hover:bg-muted/20"
  )}
>
  <RadioGroupItem value={opt.label} className="mt-0.5" />
  <div className="flex-1 min-w-0">
    <p className="text-sm text-muted-foreground">{opt.label}</p>
    {opt.description && (
      <p className="text-xs text-muted-foreground/60">{opt.description}</p>
    )}
  </div>
</label>
```

### Submit Footer

```tsx
<div className="flex justify-end px-4 pb-3 pt-2">
  <Button
    variant="ghost"
    size="sm"
    onClick={handleSubmit}
    disabled={!isValid || isSubmitting}
    className="text-muted-foreground hover:text-foreground"
  >
    {isSubmitting ? (
      <>Submitting...</>
    ) : (
      <>
        Submit
        <Send className="ml-2 h-3.5 w-3.5" />
      </>
    )}
  </Button>
</div>
```

---

## Animation & Transitions

### Entrance Animation
Keep the existing entrance animation (same as todo list):
```tsx
"animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
```

### Collapsible Content
Add smooth expand/collapse:
```tsx
<CollapsibleContent
  className={cn(
    "overflow-hidden",
    "data-[state=open]:animate-collapsible-down",
    "data-[state=closed]:animate-collapsible-up",
    "motion-reduce:animate-none"
  )}
>
```

### Hover States
Subtle background transitions:
```tsx
"transition-colors duration-150"
```

---

## Functional Behavior

### State Management (No Changes)
- `questionStates` tracking remains identical
- `handleSingleSelect`, `handleMultiSelect`, `handleOtherTextChange` unchanged
- `handleSubmit` and validation logic unchanged

### New: Collapsible State
```tsx
const [isExpanded, setIsExpanded] = useState(true);
```

- Default to expanded (user needs to see the question)
- Allow collapsing to reduce visual noise if user wants to think
- Persist expansion state only for current question (reset on new question)

### Accessibility
- Maintain existing keyboard navigation for radio/checkbox
- Add `aria-expanded` to collapsible trigger
- Ensure focus states are visible

---

## Testing Requirements

Since no tests currently exist for this component, add the following:

### Unit Tests (`tests/ask-user-question.test.tsx`)

```typescript
describe('AskUserQuestion', () => {
  // Rendering
  it('renders question text and options');
  it('renders "Other" option for each question');

  // Single-select behavior
  it('allows selecting a single option with radio buttons');
  it('deselects previous option when new one is selected');
  it('shows text input when "Other" is selected');

  // Multi-select behavior
  it('allows selecting multiple options with checkboxes');
  it('allows combining selected options with "Other" text');

  // Validation
  it('disables submit button when no selection made');
  it('enables submit button when option selected');
  it('enables submit button when "Other" has text');

  // Submit behavior
  it('calls onSubmit with selected option values');
  it('calls onSubmit with "Other" text when selected');
  it('shows submitting state while processing');

  // Collapsible (new)
  it('renders expanded by default');
  it('collapses when header is clicked');
  it('expands when header is clicked again');
});
```

### Visual Testing Checklist

- [ ] Container has subtle border and background blur
- [ ] Header shows muted icon and text
- [ ] Chevron indicates expand/collapse state
- [ ] Question text renders without header badge
- [ ] Option rows have minimal styling (no heavy borders)
- [ ] Hover state shows subtle background change
- [ ] Selected radio/checkbox shows proper state
- [ ] "Other" input appears inline when selected
- [ ] Submit button is right-aligned and compact
- [ ] Works correctly in both light and dark mode
- [ ] Entrance animation plays smoothly
- [ ] Collapse/expand animation is smooth

---

## Implementation Checklist

### Phase 1: Container & Header Restyle
1. [ ] Update container classes to match todo list styling
2. [ ] Remove header background color
3. [ ] Update header icon and text to muted colors
4. [ ] Add Collapsible wrapper with trigger on header
5. [ ] Add chevron icon to header

### Phase 2: Content Restyle
1. [ ] Remove question header badge entirely (don't render `q.header`)
2. [ ] Simplify question text styling
3. [ ] Remove borders from option cards
4. [ ] Update option hover states
5. [ ] Adjust option label/description colors

### Phase 3: Submit Button Restyle
1. [ ] Change to ghost variant
2. [ ] Make compact/right-aligned
3. [ ] Update icon size
4. [ ] Adjust disabled state styling

### Phase 4: Animation & Polish
1. [ ] Add CollapsibleContent animation classes
2. [ ] Verify entrance animation still works
3. [ ] Test hover transitions
4. [ ] Test in light and dark mode

### Phase 5: Testing
1. [ ] Write unit tests for rendering
2. [ ] Write unit tests for selection behavior
3. [ ] Write unit tests for submit behavior
4. [ ] Write unit tests for collapsible behavior
5. [ ] Manual visual testing

---

## Dependencies

### shadcn/ui Components
Components already installed:
- `Button`
- `Checkbox`
- `RadioGroup`, `RadioGroupItem`
- `Input`
- `Label`

Components to add (if not installed):
- `Collapsible`, `CollapsibleContent`, `CollapsibleTrigger`
- `ScrollArea` (optional, for many questions)

Check installation:
```bash
# If Collapsible is not installed:
npx shadcn@latest add collapsible

# If ScrollArea is not installed:
npx shadcn@latest add scroll-area
```

### Lucide Icons
- `MessageCircleQuestion` (existing)
- `Send` (existing)
- `ChevronUp` (add)
- `ChevronDown` (add)

---

## Summary

This redesign transforms the `AskUserQuestion` component from a prominent "highlighted callout" to a subtle, minimal panel that:

- **Matches the todo list aesthetic** with neutral colors and subtle borders
- **Reduces visual noise** by removing heavy backgrounds and borders
- **Adds collapse functionality** for user control over screen real estate
- **Maintains full functionality** - all selection and submission logic unchanged
- **Improves consistency** across the floating panels in the composer area

The implementation is relatively low-risk since it's purely styling changes with one behavioral addition (collapsible), and all existing functionality remains intact.
