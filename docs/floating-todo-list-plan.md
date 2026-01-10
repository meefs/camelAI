# Floating Todo List - UX Styling Plan

This document outlines the design and implementation plan for a floating todo list component that provides users visibility into the agent's task progress.

---

## Problem Statement

When the agent uses the `TodoWrite` tool to track tasks, users currently see updates as inline tool calls in the message stream. This can be hard to notice when:

1. The agent is working on long-running tasks
2. Many tool calls are happening and the todo update scrolls past
3. Users want a quick glance at overall progress without scrolling through messages

**Goal:** Add a persistent, floating todo list container that hovers above the text input field, giving users immediate visibility into task progress.

---

## Reference Design Analysis

The design is inspired by screenshots from another SaaS application. Here is a detailed description:

### Screenshot 1: Expanded State

```
┌─────────────────────────────────────────────────────────────────┐
│  ⋮≡ 0 out of 3 tasks completed                              ↗↙ │
├─────────────────────────────────────────────────────────────────┤
│  ○  1. Update team table edit controls and workspace access     │
│       add behavior; adjust profile avatar sizing                │
│                                                                 │
│  ○  2. Add Organizations and Workspaces settings tabs with      │
│       list components and server-side data assembly             │
│                                                                 │
│  ○  3. Add invitation persistence tests in workers runtime      │
│       suite                                                     │
└─────────────────────────────────────────────────────────────────┘
  [                    Text input field                          ]
```

**Key elements:**
- **Header row:** Task list icon (⋮≡) + progress text ("0 out of 3 tasks completed") + expand/collapse toggle (↗↙)
- **Task list:** Numbered items with status indicators on the left
- **Status indicators:** Empty circle (○) = pending, loading spinner = in progress, checkmark (✓) = completed
- **Container position:** Floats directly above the text input field
- **Dark theme:** Dark background, muted text colors, subtle borders

### Screenshot 2: Collapsed State

```
┌─────────────────────────────────────────────────────────────────┐
│  ⋮≡ 1 out of 3 tasks completed                              ↙↗ │
└─────────────────────────────────────────────────────────────────┘
  [                    Text input field                          ]
```

**Key differences from expanded:**
- Tasks are hidden - only the header with progress summary is visible
- More compact vertical height
- Toggle icon indicates it can be expanded

---

## Design Decisions

### 1. Position & Layout
- **Float above input:** The container sits directly above the `PromptInput` component, within the sticky composer area
- **Full width of input area:** Matches the max-width of the input (max-w-3xl)
- **Subtle elevation:** Light shadow and background blur to distinguish from chat content
- **Rounded corners:** Match the input field styling (rounded-xl or rounded-2xl)

### 2. Visual Style
Following the existing design philosophy from `tool-call-ux-design.md`:
- **Whisper, don't shout:** The container should be informative but not distracting
- **Muted colors:** Use `text-muted-foreground` for most text
- **Subtle borders:** `border-border/50` for container outline
- **Dark-mode friendly:** Works with the existing dark theme

### 3. Expand/Collapse Behavior
- **Default state:** Collapsed (show only progress summary)
- **Toggle:** Click anywhere on header row or use the toggle button
- **Animation:** Smooth expand/collapse using Radix Collapsible
- **Remember preference:** Could store in local state (not persisted across sessions)

### 4. Task Status Indicators
Using Lucide icons with appropriate sizing:

| Status | Icon | Color | Description |
|--------|------|-------|-------------|
| `pending` | `Circle` | `text-muted-foreground/40` | Empty circle outline |
| `in_progress` | `Loader2` | `text-blue-500` | Spinning loader (animate-spin) |
| `completed` | `CheckCircle2` | `text-green-500` | Filled checkmark circle |

### 5. Scrollable Task List
- **Max height:** ~200px (approximately 4-5 tasks visible)
- **Scroll area:** Use shadcn `ScrollArea` component
- **Overflow indicator:** Subtle fade at bottom when more items exist

### 6. Auto-Dismiss Behavior
The container should disappear when:
1. **All tasks completed** AND **assistant message has finished streaming**
2. The agent sends a new `TodoWrite` with an empty array (explicitly clears)

**Important edge cases:**
- If agent forgets to mark tasks complete, the container still dismisses when streaming ends
- If there are no todos at all, the container is not shown
- Container persists across multiple tool calls during a single assistant turn

### 7. Coexistence with Inline Tool Calls
- **Keep both:** The inline `• Updated tasks` tool call remains in the message stream
- **Additive UX:** The floating container is an additional view, not a replacement
- **No duplication confusion:** The inline version is expandable for details; the floating version is for quick status

---

## Component Architecture

### New Components

```
src/components/
├── floating-todo/
│   ├── index.tsx                 # Main export
│   ├── floating-todo-list.tsx    # Container component
│   ├── todo-progress-header.tsx  # Header with progress & toggle
│   ├── todo-task-item.tsx        # Individual task row
│   └── todo-status-icon.tsx      # Status indicator icons
```

### Component Hierarchy

```tsx
<FloatingTodoList todos={currentTodos} isStreaming={isStreaming}>
  <TodoProgressHeader
    completed={completedCount}
    total={totalCount}
    isExpanded={isExpanded}
    onToggle={toggleExpanded}
  />
  <Collapsible open={isExpanded}>
    <CollapsibleContent>
      <ScrollArea className="max-h-[200px]">
        {todos.map(todo => (
          <TodoTaskItem
            key={todo.content}
            content={todo.content}
            status={todo.status}
          />
        ))}
      </ScrollArea>
    </CollapsibleContent>
  </Collapsible>
</FloatingTodoList>
```

### Props Interface

```typescript
interface FloatingTodoListProps {
  /** Current list of todos from the most recent TodoWrite */
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;
  /** Whether the assistant is currently streaming */
  isStreaming: boolean;
  /** Callback when the container is dismissed */
  onDismiss?: () => void;
}
```

---

## State Management

### Tracking Todos in Chat Component

The `Chat.tsx` component needs to:

1. **Extract todos from streaming messages:** Watch for `TodoWrite` tool uses in the streaming content blocks
2. **Maintain current todo state:** Store the latest todo list from the most recent `TodoWrite` call
3. **Track completion status:** Know when all todos are completed
4. **Track streaming status:** Know when the assistant turn ends

```typescript
// In Chat.tsx - add new state
const [currentTodos, setCurrentTodos] = useState<TodoItem[]>([]);

// Extract todos from messages when content updates
useEffect(() => {
  // Find the most recent TodoWrite tool_use in the streaming message
  const streamingMsg = messages.find(m => m.id === streamingMessageId);
  if (!streamingMsg) return;

  const contentBlocks = Array.isArray(streamingMsg.content) ? streamingMsg.content : [];

  // Find the last TodoWrite tool_use
  const todoToolUse = contentBlocks
    .filter(block => block.type === 'tool_use' && block.name === 'TodoWrite')
    .pop();

  if (todoToolUse?.input?.todos) {
    setCurrentTodos(todoToolUse.input.todos);
  }
}, [messages, streamingMessageId]);

// Auto-dismiss when streaming ends and all complete
useEffect(() => {
  if (!isStreaming && currentTodos.length > 0) {
    const allComplete = currentTodos.every(t => t.status === 'completed');
    if (allComplete) {
      // Delay slightly to let user see completion
      const timer = setTimeout(() => setCurrentTodos([]), 1500);
      return () => clearTimeout(timer);
    }
    // Also dismiss if streaming ended (handles "forgot to complete" case)
    const timer = setTimeout(() => setCurrentTodos([]), 2000);
    return () => clearTimeout(timer);
  }
}, [isStreaming, currentTodos]);
```

---

## Integration with Chat.tsx

### Placement in JSX

The floating todo list should be rendered inside the sticky composer area, above the `PromptInput`:

```tsx
{/* Sticky Composer */}
<div className="sticky bottom-0 z-20 shrink-0">
  {/* Scroll to bottom button */}
  <div className="relative">
    {/* ... existing button ... */}
  </div>

  {/* Gradient fade above composer */}
  <div className="absolute inset-x-0 bottom-full h-8 bg-gradient-to-t ..." />

  {/* Composer container */}
  <div className="bg-background pt-2 pb-4 px-4">
    <div className="max-w-3xl mx-auto w-full">
      {/* NEW: Floating Todo List */}
      {currentTodos.length > 0 && (
        <FloatingTodoList
          todos={currentTodos}
          isStreaming={isStreaming}
          className="mb-3"
        />
      )}

      <PromptInput
        value={input}
        onChange={setInput}
        onSubmit={sendMessage}
        onStop={stopGeneration}
        placeholder="Type a message..."
        isAssistantRunning={loading || isStreaming}
        autoFocus
      />
    </div>
  </div>
</div>
```

---

## Detailed Component Specifications

### FloatingTodoList

```tsx
// src/components/floating-todo/floating-todo-list.tsx
"use client";

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TodoProgressHeader } from './todo-progress-header';
import { TodoTaskItem } from './todo-task-item';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

interface FloatingTodoListProps {
  todos: TodoItem[];
  isStreaming: boolean;
  className?: string;
}

export function FloatingTodoList({ todos, isStreaming, className }: FloatingTodoListProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const completedCount = todos.filter(t => t.status === 'completed').length;
  const totalCount = todos.length;

  // Auto-expand when first task starts
  useEffect(() => {
    const hasInProgress = todos.some(t => t.status === 'in_progress');
    if (hasInProgress && !isExpanded) {
      setIsExpanded(true);
    }
  }, [todos]);

  if (todos.length === 0) return null;

  return (
    <div
      className={cn(
        "rounded-xl border border-border/50 bg-background/95 backdrop-blur-sm shadow-sm",
        "overflow-hidden",
        className
      )}
    >
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger asChild>
          <TodoProgressHeader
            completed={completedCount}
            total={totalCount}
            isExpanded={isExpanded}
          />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <ScrollArea className="max-h-[200px]">
            <div className="px-4 pb-3 space-y-2">
              {todos.map((todo, index) => (
                <TodoTaskItem
                  key={`${todo.content}-${index}`}
                  index={index + 1}
                  content={todo.status === 'in_progress' ? todo.activeForm : todo.content}
                  status={todo.status}
                />
              ))}
            </div>
          </ScrollArea>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
```

### TodoProgressHeader

```tsx
// src/components/floating-todo/todo-progress-header.tsx
"use client";

import { ListTodo, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TodoProgressHeaderProps {
  completed: number;
  total: number;
  isExpanded: boolean;
}

export function TodoProgressHeader({ completed, total, isExpanded }: TodoProgressHeaderProps) {
  return (
    <button
      className={cn(
        "w-full flex items-center gap-2 px-4 py-3",
        "text-sm text-muted-foreground",
        "hover:bg-muted/30 transition-colors",
        "cursor-pointer"
      )}
    >
      <ListTodo className="h-4 w-4 text-muted-foreground/60" />
      <span className="flex-1 text-left">
        {completed} out of {total} tasks completed
      </span>
      {isExpanded ? (
        <ChevronUp className="h-4 w-4 text-muted-foreground/40" />
      ) : (
        <ChevronDown className="h-4 w-4 text-muted-foreground/40" />
      )}
    </button>
  );
}
```

### TodoTaskItem

```tsx
// src/components/floating-todo/todo-task-item.tsx
"use client";

import { cn } from '@/lib/utils';
import { TodoStatusIcon } from './todo-status-icon';

interface TodoTaskItemProps {
  index: number;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export function TodoTaskItem({ index, content, status }: TodoTaskItemProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 py-1",
        status === 'completed' && "text-muted-foreground/50"
      )}
    >
      <TodoStatusIcon status={status} className="mt-0.5 shrink-0" />
      <span
        className={cn(
          "text-sm text-muted-foreground leading-relaxed",
          status === 'completed' && "line-through"
        )}
      >
        {index}. {content}
      </span>
    </div>
  );
}
```

### TodoStatusIcon

```tsx
// src/components/floating-todo/todo-status-icon.tsx
"use client";

import { Circle, Loader2, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TodoStatusIconProps {
  status: 'pending' | 'in_progress' | 'completed';
  className?: string;
}

export function TodoStatusIcon({ status, className }: TodoStatusIconProps) {
  switch (status) {
    case 'pending':
      return (
        <Circle
          className={cn("h-4 w-4 text-muted-foreground/40", className)}
        />
      );
    case 'in_progress':
      return (
        <Loader2
          className={cn("h-4 w-4 text-blue-500 animate-spin", className)}
        />
      );
    case 'completed':
      return (
        <CheckCircle2
          className={cn("h-4 w-4 text-green-500", className)}
        />
      );
  }
}
```

---

## Animation & Transitions

### Container Enter/Exit
- **Enter:** Slide up + fade in (CSS transform + opacity)
- **Exit:** Slide down + fade out
- **Duration:** 200ms ease-out

```css
/* Example Tailwind animation */
.floating-todo-enter {
  @apply animate-in fade-in-0 slide-in-from-bottom-2 duration-200;
}

.floating-todo-exit {
  @apply animate-out fade-out-0 slide-out-to-bottom-2 duration-200;
}
```

### Expand/Collapse
- Use Radix Collapsible's built-in animation support
- Smooth height transition with `data-[state=open]` / `data-[state=closed]` attributes

### Task Completion
- Brief scale pulse on checkbox when task completes (optional)
- Strikethrough animation on text

---

## Testing Checklist

### Visual
- [ ] Container appears when `TodoWrite` is called with tasks
- [ ] Container positions correctly above input field
- [ ] Collapsed state shows progress summary
- [ ] Expanded state shows task list with scroll
- [ ] Status icons render correctly for each state
- [ ] Loading spinner animates for in-progress tasks
- [ ] Completed tasks show checkmark and strikethrough

### Behavior
- [ ] Click header to expand/collapse
- [ ] Auto-expand when first task enters in_progress
- [ ] Container dismisses after streaming ends (with slight delay)
- [ ] Container dismisses when all tasks completed
- [ ] Works with multiple `TodoWrite` calls in same turn (shows latest)
- [ ] Empty todo array hides container

### Integration
- [ ] Inline tool call still renders normally in message stream
- [ ] Scroll position isn't affected by container appearance
- [ ] Works in both light and dark mode
- [ ] Responsive on mobile (narrower widths)

---

## Implementation Phases

### Phase 1: Core Component
1. Create `FloatingTodoList` component structure
2. Create sub-components (header, item, icon)
3. Implement expand/collapse with Radix Collapsible
4. Add basic styling

### Phase 2: State Integration
1. Add `currentTodos` state to `Chat.tsx`
2. Implement todo extraction from streaming messages
3. Wire up to render `FloatingTodoList` in composer area
4. Test with real `TodoWrite` tool calls

### Phase 3: Auto-Dismiss Logic
1. Implement dismiss on streaming end
2. Add delay for completion visibility
3. Handle edge case: todos not marked complete
4. Add enter/exit animations

### Phase 4: Polish
1. Refine animations and transitions
2. Add scroll area with fade indicators
3. Test edge cases and mobile responsiveness
4. Final visual polish

---

## Summary

This plan adds a floating todo list container that:

- **Hovers above the input field** for constant visibility
- **Shows progress at a glance** with "X out of Y completed"
- **Expands to show task details** with status icons
- **Auto-dismisses** when the assistant turn ends
- **Coexists with inline tool calls** as an additive UX enhancement

The implementation uses existing shadcn components (Collapsible, ScrollArea) and follows the established design patterns from the tool call UX spec.
