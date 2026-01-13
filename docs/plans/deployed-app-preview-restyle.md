# Deployed App Preview Restyle Plan

## Overview

Restyle the Deployed App Preview pane in the Chat component to be:
1. **Resizable** - Using shadcn's Resizable component with a drag handle (desktop only)
2. **Full height** - Preview extends from viewport top to bottom, with PageHeader only covering the chat area
3. **Mobile/Tablet responsive** - Tab switcher to toggle between Chat and Preview views on smaller screens

## Current Implementation

**File:** [Chat.tsx](src/components/Chat.tsx)

The current structure (simplified):

```tsx
<TooltipProvider>
  <>
    <PageHeader ... />  {/* Spans full width including preview */}

    {shouldShowChat ? (
      <div className="flex-1 flex min-h-0">
        {/* Chat Panel */}
        <div className={cn("flex flex-col min-h-0", deployedApp ? "w-1/2" : "flex-1")}>
          {/* Chat content */}
        </div>

        {/* Deployed App Preview - Fixed 50% width, not resizable */}
        {deployedApp && (
          <div className="w-1/2 border-l border-border flex flex-col bg-background">
            {/* Header bar with status, refresh, open, close buttons */}
            {/* iframe */}
          </div>
        )}
      </div>
    ) : (
      /* Welcome Screen */
    )}
  </>
</TooltipProvider>
```

**Key Issues:**
- Preview pane uses fixed `w-1/2` width, not resizable
- `PageHeader` is rendered before the flex container, spanning full viewport width
- Preview height is constrained by flex layout, not extending to viewport top

## Target Implementation

### Structure Changes

```tsx
<TooltipProvider>
  <>
    {shouldShowChat ? (
      <div className="flex-1 flex min-h-0">
        <ResizablePanelGroup direction="horizontal" className="h-full w-full">
          {/* Chat Panel */}
          <ResizablePanel
            defaultSize={deployedApp ? 50 : 100}
            minSize={30}
            className="flex flex-col min-h-0"
          >
            <PageHeader ... />  {/* Now INSIDE the chat panel */}
            {/* Chat content */}
          </ResizablePanel>

          {/* Preview Panel - conditionally rendered */}
          {deployedApp && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                defaultSize={50}
                minSize={25}
                maxSize={70}
                className="flex flex-col"
              >
                {/* Preview content - full height, no PageHeader above it */}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    ) : (
      <>
        <PageHeader ... />  {/* Keep PageHeader for welcome screen */}
        {/* Welcome Screen */}
      </>
    )}
  </>
</TooltipProvider>
```

## Implementation Steps

### Step 1: Add Resizable Import

Add the resizable components to the imports at the top of [Chat.tsx](src/components/Chat.tsx):

```tsx
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
```

### Step 2: Restructure the Layout

The key architectural change is moving `<PageHeader>` inside the chat panel so it only covers the chat area, not the preview.

**Current location of PageHeader:** Lines 1338-1347 (before the `shouldShowChat` conditional)

**New location:** Inside the chat panel, after `ResizablePanelGroup` and `ResizablePanel` but before the chat content.

### Step 3: Implement Resizable Panels

Replace the current flex-based layout with ResizablePanelGroup:

**Current (lines 1349-1538):**
```tsx
{shouldShowChat ? (
  <div className="flex-1 flex min-h-0">
    {/* Chat Panel */}
    <div className={cn("flex flex-col min-h-0", deployedApp ? "w-1/2" : "flex-1")}>
      ...
    </div>

    {/* Deployed App Preview */}
    {deployedApp && (
      <div className="w-1/2 border-l border-border flex flex-col bg-background">
        ...
      </div>
    )}
  </div>
)
```

**New:**
```tsx
{shouldShowChat ? (
  <ResizablePanelGroup
    direction="horizontal"
    className="flex-1 min-h-0"
  >
    {/* Chat Panel */}
    <ResizablePanel
      defaultSize={deployedApp ? 50 : 100}
      minSize={30}
      className="flex flex-col min-h-0"
    >
      <PageHeader
        breadcrumbs={[
          { label: 'Chat' },
          { label: currentTitle?.trim() || 'Untitled Chat' },
        ]}
      />
      {/* Rest of chat content... */}
    </ResizablePanel>

    {/* Resizable Handle + Preview Panel */}
    {deployedApp && (
      <>
        <ResizableHandle withHandle />
        <ResizablePanel
          defaultSize={50}
          minSize={25}
          maxSize={70}
          className="flex flex-col bg-background"
        >
          {/* Preview header bar */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border">
            ...
          </div>
          {/* iframe container */}
          <div className="flex-1">
            <iframe ... />
          </div>
        </ResizablePanel>
      </>
    )}
  </ResizablePanelGroup>
)
```

### Step 4: Handle Welcome Screen PageHeader

For the welcome screen (when `!shouldShowChat`), keep PageHeader outside since there's no preview pane:

```tsx
) : (
  <>
    <PageHeader breadcrumbs={[{ label: 'Home' }]} />
    {/* Welcome Screen content */}
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      ...
    </div>
  </>
)}
```

### Step 5: Remove Border from Preview Panel

Since `ResizableHandle` provides visual separation, remove `border-l border-border` from the preview panel container. The handle itself will serve as the divider.

### Step 6: Adjust Panel Sizing

Reference the Computer page pattern from [computer-page-content.tsx](src/app/(app)/computer/[orgId]/computer-page-content.tsx) for sizing:

| Property | Chat Panel | Preview Panel |
|----------|------------|---------------|
| defaultSize | 50 (when preview open) / 100 (when closed) | 50 |
| minSize | 30 | 25 |
| maxSize | - | 70 |

These values ensure:
- Neither panel gets too small to be usable
- Preview can't dominate the viewport entirely
- Chat panel always has enough room for the composer

## Component Reference

### ResizablePanelGroup Props
- `direction`: "horizontal" | "vertical"
- `className`: Additional styles

### ResizablePanel Props
- `defaultSize`: Initial size as percentage (number)
- `minSize`: Minimum size percentage
- `maxSize`: Maximum size percentage
- `className`: Additional styles

### ResizableHandle Props
- `withHandle`: Show draggable handle indicator (boolean)
- `className`: Additional styles

## Visual Changes Summary

| Aspect | Before | After |
|--------|--------|-------|
| Preview width | Fixed 50% (`w-1/2`) | Resizable 25-70%, default 50% |
| Resize capability | None | Drag handle between panels |
| PageHeader position | Above both chat and preview | Only above chat |
| Preview height | Starts below header | Full viewport height |
| Panel divider | Border line | Resizable handle with grip |

## Files to Modify

1. **[src/components/Chat.tsx](src/components/Chat.tsx)** - Main implementation (all changes)

## All Required Imports

```tsx
// Add these imports to Chat.tsx
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
```

## Testing Checklist (Desktop)

After implementation, verify:
- [ ] Preview pane appears when an app is deployed
- [ ] Drag handle appears between chat and preview
- [ ] Panels can be resized by dragging the handle
- [ ] Preview cannot be resized below 25% or above 70%
- [ ] Chat panel cannot be resized below 30%
- [ ] PageHeader only appears above chat, not preview
- [ ] Preview extends full height (viewport top to bottom)
- [ ] Closing preview returns chat to full width
- [ ] Welcome screen (no thread) still shows PageHeader correctly
- [ ] Refresh, external link, and close buttons still work
- [ ] iframe displays correctly at various widths

---

## Mobile/Tablet Responsive Design

On screens smaller than `md` (768px), showing both Chat and Preview side-by-side becomes too cramped. Instead, we show one view at a time with a tab switcher to toggle between them.

### Breakpoint Strategy

| Screen Size | Behavior |
|-------------|----------|
| `>= md` (768px+) | Side-by-side resizable panels (desktop behavior) |
| `< md` (< 768px) | Single view with tab switcher |

### Mobile Layout Visual

When a deployed app exists and user is on **Chat** tab:

```
┌─────────────────────────────────────┐
│         PageHeader / Breadcrumbs    │
├─────────────────────────────────────┤
│                                     │
│                                     │
│           Chat Messages             │
│           (scrollable)              │
│                                     │
│                                     │
├─────────────────────────────────────┤
│  ┌─────────────────────────────────┐│
│  │  Message input textarea...      ││
│  │                                 ││
│  └─────────────────────────────────┘│
│                                     │
│       ┌──────────┬──────────┐       │
│       │   Chat   │ Preview  │       │
│       │  (active)│          │       │
│       └──────────┴──────────┘       │
└─────────────────────────────────────┘
```

When user switches to **Preview** tab:

```
┌─────────────────────────────────────┐
│  Preview Header (status, buttons)   │
├─────────────────────────────────────┤
│                                     │
│                                     │
│                                     │
│         iframe (full height)        │
│                                     │
│                                     │
│                                     │
├─────────────────────────────────────┤
│       ┌──────────┬──────────┐       │
│       │   Chat   │ Preview  │       │
│       │          │ (active) │       │
│       └──────────┴──────────┘       │
└─────────────────────────────────────┘
```

**Key differences when on Preview tab:**
- No PageHeader (breadcrumbs) - replaced by Preview header bar
- No chat input field - only the tab switcher at bottom
- iframe takes full available height

### Tab Switcher Component

Use shadcn's `Tabs` component with the default variant (pill/segmented style).

**Location:** Below the `PromptInput` component in the sticky composer area (Chat view) or as a standalone footer bar (Preview view).

**Visual design:**
```
     ┌─────────────────────────────────┐
     │ ╭───────────╮╭───────────╮      │
     │ │   Chat    ││  Preview  │      │
     │ │  (pill)   ││           │      │
     │ ╰───────────╯╰───────────╯      │
     └─────────────────────────────────┘
           bg-muted rounded pill style
```

The active tab has `bg-background` with subtle border (matches shadcn Tabs default variant).

### State Management

Add a new state variable to track the active mobile view:

```tsx
// Only relevant when deployedApp exists and screen < md
const [mobileView, setMobileView] = useState<'chat' | 'preview'>('chat');
```

**Behavior:**
- Default to `'chat'` when a new app is deployed
- Persist selection while navigating within the same thread
- Reset to `'chat'` when switching threads or when `deployedApp` becomes null

### Implementation Approach

#### Option A: CSS-only visibility toggle (Recommended)

Render both views but use Tailwind responsive classes to show/hide:

```tsx
{/* On mobile: show based on mobileView state */}
{/* On desktop: always show chat panel */}
<div className={cn(
  "flex flex-col min-h-0",
  "md:block",  // Always visible on desktop
  mobileView === 'chat' ? "block" : "hidden md:block"  // Toggle on mobile
)}>
  {/* Chat content */}
</div>
```

**Pros:** Preserves scroll position and state when switching tabs
**Cons:** Both views rendered in DOM (minimal perf impact)

#### Option B: Conditional rendering

Only render the active view on mobile:

```tsx
{(mobileView === 'chat' || isDesktop) && (
  <div>Chat content</div>
)}
```

**Pros:** Cleaner DOM
**Cons:** Loses scroll position when switching; need to track `isDesktop` with hook

**Recommendation:** Use Option A for better UX (scroll position preservation).

### Mobile-Specific Structure

```tsx
{shouldShowChat ? (
  <>
    {/* Desktop: Resizable panels (hidden on mobile) */}
    <div className="hidden md:flex flex-1 min-h-0">
      <ResizablePanelGroup ...>
        {/* Chat Panel with PageHeader */}
        {/* Preview Panel */}
      </ResizablePanelGroup>
    </div>

    {/* Mobile: Single view with tab switcher (hidden on desktop) */}
    <div className="flex md:hidden flex-col flex-1 min-h-0">
      {mobileView === 'chat' ? (
        <>
          <PageHeader ... />
          {/* Chat scroll container */}
          {/* Sticky composer with tab switcher */}
          <div className="sticky bottom-0 ...">
            <PromptInput ... />
            {deployedApp && <MobileViewSwitcher ... />}
          </div>
        </>
      ) : (
        <>
          {/* Preview header bar */}
          {/* iframe */}
          {/* Tab switcher (no input) */}
          <div className="sticky bottom-0 ...">
            <MobileViewSwitcher ... />
          </div>
        </>
      )}
    </div>
  </>
) : (
  /* Welcome screen - same for both */
)}
```

### MobileViewSwitcher Component

Create an inline component or extract to separate file:

```tsx
function MobileViewSwitcher({
  value,
  onChange,
}: {
  value: 'chat' | 'preview';
  onChange: (value: 'chat' | 'preview') => void;
}) {
  return (
    <div className="flex justify-center py-3 bg-background">
      <Tabs value={value} onValueChange={(v) => onChange(v as 'chat' | 'preview')}>
        <TabsList>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
```

**Styling notes:**
- Center the tabs horizontally
- Add padding for touch targets
- Background matches composer area (`bg-background`)

### Import Changes

Add Tabs import:

```tsx
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
```

### Handling Preview-Only View

When `mobileView === 'preview'`:

1. **No PageHeader** - The preview header bar (with status dot, URL, refresh/open/close buttons) serves as the header
2. **No PromptInput** - Users can't send messages while viewing preview
3. **Full-height iframe** - Preview takes all available space except the tab switcher footer
4. **Tab switcher at bottom** - Allows switching back to chat

```tsx
{mobileView === 'preview' && (
  <div className="flex flex-col flex-1 min-h-0">
    {/* Preview header bar - reuse same component as desktop */}
    <div className="flex items-center justify-between px-4 py-2 border-b border-border">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 bg-green-500 rounded-full" />
        <span className="text-sm font-medium">{deployedApp}.chiridion.ai</span>
      </div>
      <div className="flex items-center gap-1">
        {/* Refresh, Open, Close buttons */}
      </div>
    </div>

    {/* iframe - takes remaining space */}
    <div className="flex-1">
      <iframe
        key={iframeKey}
        src={`https://${deployedApp}.chiridion.ai`}
        className="w-full h-full bg-white"
        title="Deployed App Preview"
      />
    </div>

    {/* Tab switcher footer (no input) */}
    <div className="sticky bottom-0 bg-background border-t border-border">
      <MobileViewSwitcher value="preview" onChange={setMobileView} />
    </div>
  </div>
)}
```

### Tab Switcher Placement Details

**When on Chat tab:**
The tab switcher appears below the `PromptInput`, inside the sticky composer container.

```
┌─────────────────────────────────┐
│ Gradient fade                   │
├─────────────────────────────────┤
│ FloatingTodoList (if active)    │
├─────────────────────────────────┤
│ PromptInput                     │
├─────────────────────────────────┤
│ MobileViewSwitcher              │  ← Only when deployedApp exists
└─────────────────────────────────┘
```

**When on Preview tab:**
The tab switcher is the only element at the bottom.

```
┌─────────────────────────────────┐
│ MobileViewSwitcher              │
└─────────────────────────────────┘
```

### CSS Breakpoint Reference

Using Tailwind's default breakpoints:
- `sm`: 640px
- `md`: 768px (our breakpoint)
- `lg`: 1024px

Pattern: `md:` prefix for desktop styles, unprefixed for mobile-first.

## Testing Checklist (Mobile/Tablet)

After implementation, verify on screens < 768px:
- [ ] Chat and Preview are NOT shown side-by-side
- [ ] Tab switcher appears below input when app is deployed
- [ ] Tab switcher does NOT appear when no app is deployed
- [ ] Tapping "Chat" shows chat view with PageHeader and input
- [ ] Tapping "Preview" shows preview view with iframe
- [ ] Preview view does NOT show chat input
- [ ] Preview view shows preview header bar (status, URL, buttons)
- [ ] Switching tabs preserves chat scroll position
- [ ] Close button on preview works (hides preview, removes tab switcher)
- [ ] Tab switcher has appropriate touch target size
- [ ] Active tab is visually distinguished (pill highlight)
