# App Page Restyle Plan

## Overview

This document outlines the plan for restyling the Apps page (`src/app/(app)/apps/`) to improve the visual presentation and add new functionality to app cards.

---

## Current State

The current implementation displays apps in a 2-column grid of basic cards with:
- App name + external link icon
- "Deployed" date
- Public/Private badge
- Last updated date
- Public access toggle switch
- Settings button (opens EditAppDialog)
- Delete button (trash icon)

**Files involved:**
- [apps-client.tsx](src/app/(app)/apps/apps-client.tsx) - Main client component
- [EditAppDialog.tsx](src/app/(app)/apps/EditAppDialog.tsx) - Settings dialog
- [apps.ts](src/lib/server-actions/apps.ts) - Server actions

---

## Design Proposal

### App Card Layout

```
┌─────────────────────────────────────────────────────────────┐
│█████████████████████████████████████████████████████████████│
│█████████████████████████████████████████████████████████████│
│██████████████████ PLACEHOLDER ██████████████████████████████│  ← Edge-to-edge, no padding
│████████████████ (aspect 16:9) ██████████████████████████████│  ← Will show screenshots later
│█████████████████████████████████████████████████████████████│
│█████████████████████████████████████████████████████████████│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  my-awesome-app                             ┌──────────┐    │
│  (app name, prominent)                      │ Private  │    │
│                                             └──────────┘    │
│  [📄 index.html]                                            │
│  (source file - clickable tag, links to Computer tab)       │
│                                                             │
│  [😀] Jane Doe  •  Updated 2 hours ago                      │
│  (avatar + name + relative time)                            │
│                                                             │
│  my-app.chiridion.app              [📋] [↗️]    [💬] [⚙️]   │
│  (URL, muted text)                  │    │       │    │     │
│                                     │    │       │    └─ Settings
│                                     │    │       └─ Chat    │
│                                     │    └─ Open in new tab │
│                                     └─ Copy URL             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Image/Preview Strategy

> **Note:** Screenshot generation is a separate work item. Please do not work on this phase yet. This plan focuses on the UI restyle with a placeholder for the screenshot area.

**Card Image Styling (Edge-to-Edge)**

The image area should fill the entire top portion of the card with **no padding** - it bleeds to the card edges and uses the card's border-radius for clipping:

```
┌─────────────────────────────────────────┐  ← Card border-radius clips image
│█████████████████████████████████████████│
│█████████████████████████████████████████│
│████████████ PLACEHOLDER ████████████████│  ← No padding, full bleed
│█████████████████████████████████████████│
│█████████████████████████████████████████│
├─────────────────────────────────────────┤  ← Content starts below
│  App name                    [Badge]    │
│  ...                                    │
```

**Implementation (Placeholder for now):**
```tsx
<Card className="overflow-hidden">  {/* overflow-hidden clips image to border-radius */}
  <div className="aspect-video w-full bg-muted flex items-center justify-center">
    {/* Placeholder until screenshot generation is implemented */}
    <Globe className="size-8 text-muted-foreground/50" />
  </div>
  <CardHeader>
    {/* ... rest of card content */}
  </CardHeader>
</Card>
```

The placeholder displays a muted background with a centered icon. This will be replaced with actual screenshots once [app-preview-screenshot-plan.md](app-preview-screenshot-plan.md) is implemented.

---

## Component Breakdown

### 1. AppCard Component (New)

Create a new dedicated `AppCard` component for cleaner separation:

**File:** `src/app/(app)/apps/AppCard.tsx`

**Props:**
```typescript
interface AppCardProps {
  app: WorkerScript;
  creator?: {
    name: string | null;
    email: string | null;
    avatar: Avatar | null;
  };
  isAdmin: boolean;
  onOpenSettings: (app: WorkerScript) => void;
  onStartChat: (app: WorkerScript) => void;  // FIXME: Not yet implemented
  onViewSource: (app: WorkerScript) => void; // FIXME: Not yet implemented
}
```

**Note:** The `creator` field requires backend changes to populate - see Data Requirements section.

### 2. AppSettingsDialog Component (Refactored EditAppDialog)

Rename and enhance the existing `EditAppDialog` to `AppSettingsDialog` with expanded functionality:

**File:** `src/app/(app)/apps/AppSettingsDialog.tsx`

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  App Settings                                         [X]   │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  ┌─ INFO SECTION ─────────────────────────────────────────┐ │
│  │                                                        │ │
│  │  URL                                                   │ │
│  │  https://my-app.chiridion.app  [↗️]                    │ │
│  │                                                        │ │
│  │  Created                                               │ │
│  │  January 15, 2026                                      │ │
│  │                                                        │ │
│  │  Last Updated                                          │ │
│  │  January 20, 2026                                      │ │
│  │                                                        │ │
│  │  Created By                                            │ │
│  │  [😀] Jane Doe                                         │ │
│  │                                                        │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ ACCESS SECTION ───────────────────────────────────────┐ │
│  │                                                        │ │
│  │  Visibility                                            │ │
│  │  ┌──────────────────────────────────────────────────┐  │ │
│  │  │  Public Access                          [====○]  │  │ │
│  │  │                                                  │  │ │
│  │  │  When enabled, anyone on the internet can       │  │ │
│  │  │  view this app. When disabled, only members     │  │ │
│  │  │  of this workspace can access it.               │  │ │
│  │  └──────────────────────────────────────────────────┘  │ │
│  │                                                        │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ DANGER ZONE ──────────────────────────────────────────┐ │
│  │                                                        │ │
│  │  Delete App                                            │ │
│  │  ┌──────────────────────────────────────────────────┐  │ │
│  │  │  Permanently delete this app and its deployment. │  │ │
│  │  │  This action cannot be undone.                   │  │ │
│  │  │                                                  │  │ │
│  │  │                          [Delete App] (red)      │  │ │
│  │  └──────────────────────────────────────────────────┘  │ │
│  │                                                        │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                    [Cancel]  [Save Changes] │
└─────────────────────────────────────────────────────────────┘
```

**Delete Confirmation Flow:**
When user clicks "Delete App", show a nested `ConfirmDialog` (or inline expansion) with:
- **Title:** "Delete app?"
- **Description:** "This will permanently remove the deployment at `https://{script_name}.chiridion.app`. Any existing links to this URL will stop working. You can redeploy the app later, but it will be treated as a new deployment."
- **Confirm button:** "Delete App" (destructive variant)

### 3. Action Buttons Specification

| Element | Icon | Tooltip | Behavior |
|---------|------|---------|----------|
| **Source file** | `FileCode` + filename | "View source file" | FIXME: Deep links to Computer tab (not yet implemented). Displayed as clickable tag below app name. |
| **URL** | None (text display) | — | Displays the app URL (e.g., `my-app.chiridion.app`) in muted text |
| **Copy** | `Copy` / `Check` | "Copy URL" / "Copied!" | Copy URL to clipboard, show success state (icon button next to URL) |
| **Open** | `ExternalLink` | "Open in new tab" | `window.open(getAppUrl(script_name), '_blank')` (icon button next to URL) |
| **Chat** | `MessageSquare` | "Start a chat" | FIXME: Opens chat with workspace context (not yet implemented) |
| **Settings** | `Settings` | "App settings" | Opens `AppSettingsDialog` |

**Layout Structure:**

```tsx
{/* Header: App name + Badge */}
<div className="flex items-start justify-between">
  <CardTitle>{app.script_name}</CardTitle>
  <Badge variant={app.is_public ? 'default' : 'secondary'}>
    {app.is_public ? 'Public' : 'Private'}
  </Badge>
</div>

{/* Source file tag - clickable, links to Computer tab */}
<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground">
      <FileCode className="size-3 mr-1" />
      index.html  {/* FIXME: actual filename from source_path */}
    </Button>
  </TooltipTrigger>
  <TooltipContent>View source file</TooltipContent>
</Tooltip>

{/* Metadata: Avatar + name + time */}
<div className="flex items-center gap-2 text-sm text-muted-foreground">
  <Avatar size="2xs">...</Avatar>
  <span>{creatorName}</span>
  <span>•</span>
  <span>Updated {relativeTime}</span>
</div>

{/* Footer: URL + actions */}
<div className="flex items-center justify-between">
  <span className="text-sm text-muted-foreground truncate">
    {app.script_name}.chiridion.app
  </span>
  <div className="flex items-center gap-1">
    <Tooltip>...<Copy /></Tooltip>      {/* Copy URL */}
    <Tooltip>...<ExternalLink /></Tooltip>  {/* Open in new tab */}
    <Tooltip>...<MessageSquare /></Tooltip> {/* Chat */}
    <Tooltip>...<Settings /></Tooltip>      {/* Settings */}
  </div>
</div>
```

---

## Data Requirements

### Current WorkerScript Type
```typescript
interface WorkerScript {
  script_name: string;
  workspace_id: string;
  created_by: string;      // User ID only
  created_at: number;
  updated_at: number;
  is_public: boolean;
}
```

### Creator Enhancement

To display creator avatar and name on the card, we need to resolve `created_by` to user details. Options:

**Option A: Enhance server action (Recommended)**

Modify `getOrgApps()` in `src/lib/server-actions/apps.ts` to join creator info:

```typescript
interface WorkerScriptWithCreator extends WorkerScript {
  creator?: {
    id: string;
    name: string | null;
    email: string | null;
    avatar: Avatar | null;
  };
}
```

This follows the pattern used in `Thread` type which includes `creator` field.

**Option B: Client-side resolution**

Fetch user details separately - not recommended due to N+1 query issues.

### Source File Metadata (Future - FIXME)

For the "View source file" feature, we'll need:
```typescript
interface WorkerScript {
  // ... existing fields
  source_path?: string;  // e.g., "/projects/my-app/index.html"
}
```

This requires backend changes to track source file during deployment.

---

## Implementation Checklist

### Phase 1: Card Redesign (UI Only)

- [ ] Create `AppCard.tsx` component with new layout
- [ ] Implement edge-to-edge placeholder area with `overflow-hidden` on Card (muted bg + centered Globe icon)
- [ ] Add copy-to-clipboard functionality with success state
- [ ] Update `apps-client.tsx` to use new `AppCard` component
- [ ] Add appropriate Lucide icons: `MessageSquare`, `FileCode`, `ExternalLink`, `Copy`, `Check`, `Settings`, `Globe`

### Phase 2: Settings Dialog Enhancement

- [ ] Rename `EditAppDialog.tsx` to `AppSettingsDialog.tsx`
- [ ] Add metadata section (created date, updated date)
- [ ] Add creator info display (avatar + name) - requires backend
- [ ] Enhance visibility toggle with explanatory text
- [ ] Add Danger Zone section with delete button
- [ ] Implement nested delete confirmation with detailed warning message
- [ ] Remove redundant delete button from card (now in settings)

### Phase 3: Data Layer Updates

- [ ] Modify `getOrgApps()` to include creator details
- [ ] Update `WorkerScript` type or create `WorkerScriptWithCreator`
- [ ] Test with `system:deploy` creator (should show as "System" or similar)

### Phase 4: FIXME Placeholders

These items require additional backend work and should be left as non-functional placeholders:

- [ ] **Chat button**: Add button with FIXME comment, disabled or shows toast "Coming soon"
- [ ] **Source file link**: Add placeholder button showing "source.file" with FIXME comment, non-functional

---

## Component Dependencies

### shadcn/ui Components (Already Installed)
- `Card`, `CardHeader`, `CardContent`, `CardTitle`, `CardDescription`
- `Button` (with `variant="ghost"`, `size="icon-sm"`)
- `Badge`
- `Avatar`, `AvatarFallback`
- `Tooltip`, `TooltipTrigger`, `TooltipContent`
- `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`
- `Switch`
- `Label`
- `Alert`, `AlertDescription`

### Lucide Icons (Need to Import)
- `MessageSquare` - Chat action
- `FileCode` - Source file
- `ExternalLink` - Open in new tab
- `Copy` - Copy URL
- `Check` - Copy success
- `Settings` - Settings action
- `Globe` - Public app indicator
- `Lock` - Private app indicator
- `Trash2` - Delete (in settings)

### Utility Functions
- `getAppUrl()` from `src/lib/app-url.ts`
- `getContrastTextColor()` from `src/lib/avatar.ts`
- `cn()` from `src/lib/utils.ts`

---

## Accessibility Considerations

1. All icon-only buttons must have `aria-label` or be wrapped in `Tooltip` with visible text
2. Copy button should announce success to screen readers (`aria-live` region or toast)
3. Badge colors should have sufficient contrast
4. Delete confirmation dialog should trap focus appropriately
5. Keyboard navigation should work for all card actions

---

## Open Questions

1. **Grid layout**: Keep 2-column grid on desktop, or switch to 3 columns with smaller cards?
   - **Recommendation**: Keep 2 columns - cards now have more content and need the space

2. **Empty state**: Update the empty state card to match new design?
   - **Recommendation**: Yes, update styling to match new card design

3. **Loading state**: Add skeleton cards while loading?
   - **Recommendation**: Yes, use `Skeleton` component to match card shape

4. **Sort/Filter**: Add ability to sort by date or filter by status?
   - **Recommendation**: Out of scope for this restyle, consider for future enhancement

---

## File Changes Summary

| File | Action |
|------|--------|
| `src/app/(app)/apps/AppCard.tsx` | **Create** - New card component |
| `src/app/(app)/apps/AppSettingsDialog.tsx` | **Create** - Enhanced settings dialog (replaces EditAppDialog) |
| `src/app/(app)/apps/EditAppDialog.tsx` | **Delete** - Replaced by AppSettingsDialog |
| `src/app/(app)/apps/apps-client.tsx` | **Modify** - Use new components, remove inline card markup |
| `src/lib/server-actions/apps.ts` | **Modify** - Add creator info to getOrgApps response |
| `src/types.ts` | **Modify** - Add WorkerScriptWithCreator type |
