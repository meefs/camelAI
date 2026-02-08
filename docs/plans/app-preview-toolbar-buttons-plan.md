# App Preview Toolbar Buttons - Implementation Plan

This document outlines the design and implementation plan for adding "Report a Bug" and "Share Status" buttons to the app preview pane toolbar in the chat interface.

---

## Current State

The preview panel toolbar currently shows:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ● myapp.chiridion.app                            [↻ Reload] [↗ Open]  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│                          (iframe preview)                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Location:** `src/components/Chat.tsx` lines 1616-1674 (`previewPanelBody`)

---

## Target Design

Add two new buttons to the right side of the toolbar:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ● myapp.chiridion.app              [🔒 Private ▾] [🐛] [↻] [↗]        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│                          (iframe preview)                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

│  ● myapp.chiridion.app              [🌐 Public ▾] [🐛] [↻] [↗]         │  (when public)
```

**Button order (left to right):**
1. Share Status (badge-style button with dropdown)
2. Report a Bug (icon-only: Bug)
3. Reload (existing)
4. Open in new tab (existing)

---

## Feature 1: Report a Bug Button

### Requirements

- Icon-only button using `Bug` icon from lucide-react
- Placeholder functionality with FIXME comment for @Miguel
- Tooltip: "Report a bug"
- Will eventually create a bug report for the agent

### Implementation

```tsx
// FIXME(@Miguel): Implement bug reporting functionality
// This should create a bug report for the agent about the current app
<Tooltip>
  <TooltipTrigger asChild>
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => {
        // FIXME(@Miguel): Implement bug report creation
        console.log('Bug report placeholder - to be implemented');
      }}
    >
      <Bug className="h-4 w-4" />
    </Button>
  </TooltipTrigger>
  <TooltipContent>Report a bug</TooltipContent>
</Tooltip>
```

---

## Feature 2: Share Status Button

### Problem Statement

Users need to:
1. **See** the current share status of their app at a glance
2. **Change** the status easily without navigating away
3. **Understand** what each status means (without over-explaining)

### Share Status Definitions

| Status | Icon | Meaning |
|--------|------|---------|
| **Private** | `Lock` | Only workspace members can access |
| **Public** | `Globe` | Anyone on the internet can access |

### Design Options

I've considered three approaches for the Share Status control:

---

#### Option A: Badge Button with Dropdown (Recommended)

```
┌──────────────────┐
│ 🔒 Private  ▾    │  ← Compact badge button showing current status
└──────────────────┘
         │
         ▼  (click to open)
┌────────────────────────────────────────┐
│  Share Settings                        │
├────────────────────────────────────────┤
│  ○ Private                             │
│    Only workspace members can access   │
│                                        │
│  ● Public                              │
│    Anyone with the link can access     │
└────────────────────────────────────────┘
```

**Pros:**
- Current status is immediately visible (icon + text)
- Dropdown provides context for each option
- Consistent with badge patterns used elsewhere
- Clear affordance that it's clickable (chevron)

**Cons:**
- Takes more horizontal space than icon-only
- Two clicks to change status

**Styling:**
- Use `Badge` component with `variant="outline"` for clickable appearance
- Different colors: muted for private, subtle green tint for public
- Small chevron indicator for dropdown

---

#### Option B: Icon Button with Status Dropdown

```
┌───┐
│ 🔒│  ← Icon changes based on status (Lock = private, Globe = public)
└───┘
  │
  ▼  (click to open)
┌────────────────────────────────────────┐
│  Visibility                            │
├────────────────────────────────────────┤
│  ● Private   (Only workspace members)  │
│  ○ Public    (Anyone on the internet)  │
└────────────────────────────────────────┘
```

**Pros:**
- Minimal horizontal space
- Consistent with existing icon buttons
- Icon clearly conveys meaning (Lock vs Globe)

**Cons:**
- Status less obvious at a glance (requires icon recognition)
- Users must hover for tooltip or click to see status text

---

#### Option C: Inline Toggle Switch

```
┌─────────────────────────┐
│  Public  [====○]        │  ← Simple toggle
└─────────────────────────┘
```

**Pros:**
- Single click to toggle
- Very simple UI

**Cons:**
- Doesn't communicate what public/private means
- Risk of accidental toggling
- Less clear current state

---

### Recommendation: Option A (Badge Button with Dropdown)

Option A provides the best balance of clarity and functionality:

1. **Immediate visibility** - Users can see the current status without any interaction
2. **Context on demand** - The dropdown explains what each option means
3. **Intentional changes** - Two-step process prevents accidental visibility changes
4. **Visual distinction** - Badge styling makes the status stand out appropriately

---

## Detailed Design: Option A Implementation

### ASCII Mockup - Full Toolbar

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ● myapp.chiridion.app                  [🔒 Private ▾] [🐛] [↻] [↗]       │
│                                                                             │
│   │                                        │              │   │  │  │       │
│   │                                        │              │   │  │  └─ Open │
│   │                                        │              │   │  └─ Reload  │
│   │                                        │              │   └─ Bug report │
│   │                                        │              └─ Status         │
│   │                                        └─ (gap-2 spacing)               │
│   └─ Domain with live indicator                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Status Badge Variants

**Private (default):**
```
┌──────────────────┐
│  🔒 Private  ▾   │   text-muted-foreground, border-border, bg-transparent
└──────────────────┘
```

**Public:**
```
┌──────────────────┐
│  🌐 Public   ▾   │   text-green-600, border-green-200, bg-green-50 (subtle)
└──────────────────┘
```

### Dropdown Content

```
┌────────────────────────────────────────────────┐
│  Visibility                                    │  ← DropdownMenuLabel
├────────────────────────────────────────────────┤
│  ● Private                                     │  ← DropdownMenuRadioItem
│    Only workspace members can view             │    (muted description)
│                                                │
│  ○ Public                                      │  ← DropdownMenuRadioItem
│    Anyone with the link can view               │    (muted description)
└────────────────────────────────────────────────┘
```

---

## Component Architecture

### Option 1: Inline in Chat.tsx

Add the new buttons directly in the `previewPanelBody` JSX. This keeps everything in one place but makes Chat.tsx larger.

### Option 2: Extract PreviewToolbar Component (Recommended)

Create a new component to encapsulate the toolbar logic:

```
src/components/
├── preview-toolbar/
│   ├── index.tsx              # Main export
│   ├── preview-toolbar.tsx    # Toolbar component
│   ├── share-status-button.tsx # Share status dropdown
│   └── bug-report-button.tsx  # Bug report button (placeholder)
```

This keeps Chat.tsx cleaner and makes the toolbar reusable.

---

## Data Requirements

### Current App State

The share status toggle needs to know:
1. **Current `is_public` state** of the deployed app
2. **App `script_name`** to make the update request

Currently in Chat.tsx:
- `deployedApp` contains the script name (string)
- `is_public` is NOT currently available - needs to be fetched or passed through

### Proposed Data Flow

**Option A: Fetch via chat WebSocket**

The chat WebSocket (`/ws/{workspace}`) already sends `preview_state` events with worker info. Extend this to include `is_public`:

```typescript
// In ws message handler
if (data.type === 'preview_state') {
  setDeployedApp(data.workers[0] || null);
  setAppIsPublic(data.isPublic ?? false);  // NEW
}
```

**Option B: Separate API call**

Fetch the app's public status when a preview becomes available:

```typescript
// New API route: GET /api/apps/:scriptName/status
// Returns: { is_public: boolean }
```

**Recommendation:** Option A (WebSocket) is cleaner since we already have a realtime connection for preview state.

---

## Implementation Steps

### Phase 1: Data Plumbing

1. Extend `preview_state` WebSocket message to include `is_public` for the deployed worker
2. Add `appIsPublic` state to Chat.tsx
3. Update the preview WebSocket handler to set this state

**Files to modify:**
- `workers/main/src/durable-objects.ts` (ChatThreadDO - extend preview_state message)
- `src/components/Chat.tsx` (add state, update handler)

### Phase 2: Bug Report Button (Placeholder)

1. Add `Bug` import from lucide-react
2. Add placeholder button with FIXME comment for @Miguel
3. Add tooltip

**Files to modify:**
- `src/components/Chat.tsx`

### Phase 3: Share Status Button

1. Create `ShareStatusButton` component (or add inline)
2. Implement badge-style trigger button
3. Implement dropdown with radio items
4. Wire up to existing `setAppPublic` action (already exists in `/apps` route)
5. Handle optimistic updates and error states

**Files to modify/create:**
- `src/components/Chat.tsx` (or new `preview-toolbar/` components)

### Phase 4: Styling & Polish

1. Fine-tune badge colors for private/public states
2. Add loading state during status change
3. Test on mobile (may need to adjust for narrower toolbar)
4. Ensure admin-only gating (non-admins see status but can't change)

---

## Component Specifications

### ShareStatusButton Props

```typescript
interface ShareStatusButtonProps {
  scriptName: string;
  isPublic: boolean;
  isAdmin: boolean;
  onStatusChange?: (isPublic: boolean) => void;
  disabled?: boolean;
}
```

### Implementation Sketch

```tsx
import { useFetcher } from 'react-router';
import { Globe, Lock, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export function ShareStatusButton({
  scriptName,
  isPublic,
  isAdmin,
  disabled,
}: ShareStatusButtonProps) {
  const fetcher = useFetcher();
  const isPending = fetcher.state !== 'idle';
  const optimisticIsPublic = fetcher.formData
    ? fetcher.formData.get('isPublic') === 'true'
    : isPublic;

  const handleChange = (value: string) => {
    if (!isAdmin) return;

    fetcher.submit(
      {
        intent: 'setAppPublic',
        scriptName,
        isPublic: value,
      },
      { method: 'POST', action: '/apps' }
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || isPending}
          className={cn(
            "h-7 gap-1.5 px-2 text-xs font-medium",
            optimisticIsPublic
              ? "text-green-600 hover:text-green-700"
              : "text-muted-foreground"
          )}
        >
          {optimisticIsPublic ? (
            <Globe className="h-3.5 w-3.5" />
          ) : (
            <Lock className="h-3.5 w-3.5" />
          )}
          {optimisticIsPublic ? 'Public' : 'Private'}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Visibility</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={optimisticIsPublic ? 'true' : 'false'}
          onValueChange={handleChange}
        >
          <DropdownMenuRadioItem value="false" disabled={!isAdmin}>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Private</span>
              <span className="text-muted-foreground text-[10px]">
                Only workspace members can view
              </span>
            </div>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="true" disabled={!isAdmin}>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Public</span>
              <span className="text-muted-foreground text-[10px]">
                Anyone with the link can view
              </span>
            </div>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

---

## Testing Checklist

### Visual
- [ ] Bug button renders with correct icon
- [ ] Share status badge shows correct icon (Lock/Globe)
- [ ] Share status badge shows correct text (Private/Public)
- [ ] Public status has subtle green styling
- [ ] Dropdown opens on click
- [ ] Radio items show current selection
- [ ] Descriptions are visible and legible

### Behavior
- [ ] Bug button click fires placeholder (check console log)
- [ ] Changing visibility submits to `/apps` action
- [ ] Optimistic update shows immediately
- [ ] Reverts on error
- [ ] Non-admins can see status but not change it
- [ ] Loading state prevents double-submit

### Integration
- [ ] Preview WebSocket provides `is_public` state
- [ ] Status updates reflect in real-time
- [ ] Works on mobile viewport (toolbar may wrap or scroll)

---

## Edge Cases

1. **No app deployed yet** - Toolbar doesn't render, so no buttons needed
2. **App deleted while viewing** - Handle gracefully (toolbar disappears)
3. **Network error on status change** - Show error toast, revert optimistic update
4. **Non-admin user** - Show status but disable dropdown items (or hide chevron)
5. **Rapid toggling** - Debounce or disable during pending state

---

## Summary

This plan adds two buttons to the app preview toolbar:

1. **Report a Bug** - Placeholder icon button with FIXME for @Miguel
2. **Share Status** - Badge-style button with dropdown for toggling public/private

The share status control uses a visible badge pattern (Option A) to clearly show current status while providing a dropdown for changes with brief explanations of each visibility level.

**Key decisions:**
- Badge button over icon-only for better status visibility
- Dropdown with radio items over toggle switch for clarity
- Optimistic updates for responsive feel
- Admin-only gating for visibility changes
