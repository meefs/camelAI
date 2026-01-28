# App List Card Restyle Plan v2

## Overview

This document outlines the plan for improving the visual hierarchy and reducing density of app cards on the Apps page (`/apps`). The goal is to make cards feel less cramped while maintaining all functionality.

**Files involved:**
- [AppCard.tsx](src/components/pages/apps/AppCard.tsx) - Main card component
- [apps-client.tsx](src/components/pages/apps/apps-client.tsx) - Parent component (for any hover state coordination)
- [globals.css](src/styles/globals.css) - If custom hover gradient needed

---

## Current State

The current card layout crams four action buttons at the bottom (copy, open, chat, settings) along with a URL input field. The metadata (author, date, source file) is spread across multiple lines, and the public/private badge competes with the title for attention.

```
CURRENT LAYOUT:
┌────────────────────────────────────────────────────────────────┐
│██████████████████████████████████████████████████  ┌─────────┐ │
│██████████████████████████████████████████████████  │Workspace│ │
│███████████████ PREVIEW IMAGE ████████████████████  │ Badge   │ │
│██████████████████████████████████████████████████  └─────────┘ │
│██████████████████████████████████████████████████              │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  flower-memory-arcade                        ┌────────────┐    │
│                                              │🌐 Public   │    │
│  [📄 index.html]                             └────────────┘    │
│                                                                │
│  [👤] Illiana  •  Updated 3 days ago                           │
│                                                                │
│  ┌─────────────────────────────────────┐ [📋][↗️] [💬][⚙️]    │
│  │ flower-memory-arcade.dev-illiana... │                       │
│  └─────────────────────────────────────┘                       │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Problems:
- Four action buttons feel cramped at bottom
- Metadata spread across multiple lines creates visual noise
- Public/private badge competes with title
- URL input with inline buttons feels cluttered
```

---

## Design Proposal

### New Card Layout

```
NEW LAYOUT:
┌────────────────────────────────────────────────────────────────┐
│                                                    ┌─────────┐ │
│                                                    │🌐 Public│ │
│                                                    └─────────┘ │
│██████████████████████████████████████████████████  ┌─────────┐ │
│███████████████ PREVIEW IMAGE ████████████████████  │Workspace│ │  ← Only when "All Workspaces"
│██████████████████████████████████████████████████  └─────────┘ │
│██████████████████████████████████████████████████              │
│██████████████████████████████████████████████████              │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  flower-memory-arcade                                     ⚙️   │
│  (title)                                            (settings) │
│                                                                │
│  👤 Illiana   🕐 3 days ago   📄 index.html                    │
│  (author)      (updated)       (source file)                   │
│                                                                │
│  flower-memory-arcade.dev-illiana.chiridion.ai     [📋] [↗️]   │
│  (URL - muted text, truncated)                      copy  open │
│                                                                │
└────────────────────────────────────────────────────────────────┘


HOVER STATE ON PREVIEW:
┌────────────────────────────────────────────────────────────────┐
│                                                    ┌─────────┐ │
│                                                    │🌐 Public│ │
│                                                    └─────────┘ │
│██████████████████████████████████████████████████              │
│███████████████ PREVIEW IMAGE ████████████████████              │
│███████████████                  █████████████████              │
│███████████████  ┌────────────┐  █████████████████              │
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │ 💬 Chat   │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓              │
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  └────────────┘  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ← Gradient │
├────────────────────────────────────────────────────────────────┤
│  ...                                                           │
```

---

## Key Changes

### 1. Move Public/Private Badge to Preview Image (Top Right)

Move the visibility badge from the card header to overlay the preview image in the top-right corner.

**Implementation:**
```tsx
<div className="relative aspect-video w-full">
  {/* Visibility badge - always present */}
  <div className="absolute right-2 top-2 z-10 flex flex-col items-end gap-1">
    <Badge
      variant={app.is_public ? 'default' : 'secondary'}
      className="shrink-0"
    >
      {app.is_public ? <Globe className="size-3" /> : <Lock className="size-3" />}
      {app.is_public ? 'Public' : 'Private'}
    </Badge>
    {/* Workspace badge - only when showing all workspaces */}
    {workspaceBadge}
  </div>
  {/* Preview image... */}
</div>
```

**Badge stacking logic:**
- When viewing "This Workspace" tab: Only visibility badge shown
- When viewing "All Workspaces" tab with app from different workspace: Visibility badge on top, workspace badge below

### 2. Consolidate Metadata onto Single Line

Merge author, last updated, and source file into one compact line with icons.

**Current (multi-line):**
```
[📄 index.html]                   ← Source file button

[👤] Illiana  •  Updated 3 days ago   ← Author + date
```

**New (single line):**
```
👤 Illiana  🕐 3 days ago   📄 index.html
```

**Implementation:**
```tsx
<div className="flex items-center gap-3 text-xs text-muted-foreground overflow-hidden">
  {/* Author */}
  <div className="flex items-center gap-1.5 min-w-0">
    <Avatar size="2xs">...</Avatar>
    <span className="truncate max-w-[100px]">{creatorLabel}</span>
  </div>

  {/* Last updated */}
  <div className="flex items-center gap-1 shrink-0">
    <Clock className="size-3" />
    <span>{relativeTimeShort}</span>
  </div>

  {/* Source file (if present) */}
  {sourceLabel && (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground truncate max-w-[100px] min-w-0"
          onClick={() => onViewSource(app)}
        >
          <FileCode className="size-3 shrink-0" />
          <span className="truncate">{sourceLabel}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>View source file</TooltipContent>
    </Tooltip>
  )}
</div>
```

**Truncation strategy:**
- Author name: `max-w-[100px]` with `truncate` - full name visible on hover (native browser title) or via avatar tooltip
- Source file: `max-w-[100px]` with `truncate` - full path visible in tooltip ("View source file: /full/path/here")
- Relative time: Always shown in full (short format like "3d ago" if needed)

**Relative time format change:**
- Consider shorter format: "3d ago" instead of "3 days ago" to save space
- Alternative: Keep current format but ensure it doesn't wrap

### 3. Move Settings Icon Next to Title

Place the settings gear icon inline with the title, right-aligned.

**Implementation:**
```tsx
<CardHeader className="pb-2 pt-4">
  <div className="flex items-center justify-between gap-2">
    <CardTitle className="truncate text-base font-semibold">
      {app.script_name}
    </CardTitle>
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="App settings"
            disabled={!isAdmin}
            onClick={() => onOpenSettings(app)}
          >
            <Settings className="size-4 text-muted-foreground" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{isAdmin ? 'App settings' : 'Admins only'}</TooltipContent>
    </Tooltip>
  </div>
</CardHeader>
```

### 4. Move Chat Button to Preview Hover State

Create a hover overlay on the preview image that reveals a centered "Chat" button with a gradient shadow for visibility.

**Implementation:**

Add hover state to preview container:
```tsx
<div className="group relative aspect-video w-full">
  {/* Badges... */}

  {/* Preview image or placeholder... */}

  {/* Hover overlay with chat button */}
  <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
    {/* Gradient backdrop for button visibility */}
    <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/60 to-transparent" />

    {/* Chat button */}
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="pointer-events-auto relative z-10 gap-1.5 shadow-lg"
      onClick={() => onStartChat(app)}
    >
      <MessageSquare className="size-4" />
      Chat
    </Button>
  </div>
</div>
```

**Gradient design:**
- Use `bg-gradient-to-t from-black/60 to-transparent` for a bottom-up fade
- Gradient should be roughly bottom 1/3 of the preview area
- Button uses `variant="secondary"` for visibility against gradient
- Add `shadow-lg` to button for extra pop

**Animation:**
- `opacity-0` by default, `group-hover:opacity-100` on parent hover
- `transition-opacity duration-200` for smooth reveal
- Consider slight scale animation: `scale-95 group-hover:scale-100`

### 5. URL Section (Keep Input Field)

Keep the existing input field look - only remove the Chat and Settings buttons from this area (they're moved elsewhere).

**Current:**
```tsx
<Input readOnly value={displayUrl} className="..." />
<Button>Copy</Button>
<Button>Open</Button>
<Button>Chat</Button>    {/* Remove - moved to hover */}
<Button>Settings</Button> {/* Remove - moved to header */}
```

**New:**
```tsx
<div className="flex items-center gap-2">
  <div className="min-w-0 flex-1">
    <div className="relative">
      <Input
        readOnly
        value={displayUrl}
        aria-label="App URL"
        className="h-9 truncate pr-16 text-xs/relaxed text-muted-foreground"
      />
      <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={handleCopy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copied ? 'Copied!' : 'Copy URL'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={handleOpenInNewTab}>
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in new tab</TooltipContent>
        </Tooltip>
      </div>
    </div>
  </div>
  {/* Chat and Settings buttons removed from here */}
</div>
```

The input field styling remains unchanged - we're just removing the Chat and Settings icon buttons that were next to it.

---

## Complete New Structure

```tsx
<Card className="group gap-0 overflow-hidden p-0">
  {/* PREVIEW SECTION */}
  <div className="relative aspect-video w-full">
    {/* Stacked badges (top-right) */}
    <div className="absolute right-2 top-2 z-10 flex flex-col items-end gap-1">
      <Badge variant={...}>{visibility}</Badge>
      {showWorkspaceBadge && workspaceBadge}
    </div>

    {/* Preview image or placeholder */}
    {showPreview ? <img ... /> : <GlobePlaceholder />}

    {/* Hover overlay with chat button */}
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/60 to-transparent" />
      <Button variant="secondary" size="sm" className="pointer-events-auto relative z-10 gap-1.5 shadow-lg">
        <MessageSquare className="size-4" />
        Chat
      </Button>
    </div>
  </div>

  {/* HEADER: Title + Settings */}
  <CardHeader className="pb-2 pt-4">
    <div className="flex items-center justify-between gap-2">
      <CardTitle className="truncate text-base font-semibold">
        {app.script_name}
      </CardTitle>
      <SettingsButton />
    </div>
  </CardHeader>

  {/* CONTENT */}
  <CardContent className="space-y-3 pb-4 pt-0">
    {/* Metadata line: Author   Date   Source (no separators, use gap spacing) */}
    <div className="flex items-center gap-3 text-xs text-muted-foreground overflow-hidden">
      <div className="flex items-center gap-1.5 min-w-0">
        <Avatar size="2xs" />
        <span className="truncate max-w-[100px]">{creatorLabel}</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Clock className="size-3" />
        <span>{relativeTime}</span>
      </div>
      {sourceLabel && <SourceFileButton />}
    </div>

    {/* URL line: Input field with Copy/Open buttons (unchanged, just remove Chat/Settings) */}
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="relative">
          <Input readOnly value={displayUrl} className="h-9 truncate pr-16 text-xs/relaxed text-muted-foreground" />
          <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1">
            <CopyButton />
            <OpenButton />
          </div>
        </div>
      </div>
    </div>
  </CardContent>
</Card>
```

---

## New Icon Imports

```tsx
import { Clock } from 'lucide-react';
```

The `Clock` icon replaces the "Updated" text prefix with a visual indicator.

---

## Accessibility Considerations

1. **Chat button on hover**: Must remain keyboard accessible
   - Add `tabIndex={0}` or ensure button is focusable
   - Show on `:focus-within` as well as hover: `group-hover:opacity-100 group-focus-within:opacity-100`

2. **Truncated text**: Ensure full text is available
   - Author name: Add `title` attribute with full name
   - Source file: Tooltip already provides full path

3. **Gradient overlay**: Ensure sufficient contrast
   - Test with light preview images
   - Button should use solid background variant

---

## Implementation Checklist

### Phase 1: Badge Relocation
- [ ] Move visibility badge (Public/Private) inside preview container
- [ ] Position in top-right corner with `absolute right-2 top-2`
- [ ] Stack workspace badge below visibility badge when both present
- [ ] Remove badge from CardHeader section

### Phase 2: Metadata Consolidation
- [ ] Import `Clock` icon from lucide-react
- [ ] Create single-line metadata component
- [ ] Add `max-w-[100px] truncate` to author name
- [ ] Add `max-w-[100px] truncate` to source file name
- [ ] Convert source file from Button to inline clickable element
- [ ] Add title attributes for truncated text accessibility

### Phase 3: Header Restructure
- [ ] Move Settings button to CardHeader, right of title
- [ ] Remove Settings button from bottom action bar
- [ ] Ensure proper disabled state styling for non-admins

### Phase 4: Hover Chat Button
- [ ] Add `group` class to Card component
- [ ] Create hover overlay container with gradient
- [ ] Add Chat button with proper styling
- [ ] Add `pointer-events-none` to overlay, `pointer-events-auto` to button
- [ ] Add `group-focus-within:opacity-100` for keyboard accessibility
- [ ] Remove Chat button from bottom action bar

### Phase 5: URL Section Cleanup
- [ ] Keep Input field styling as-is
- [ ] Remove Chat and Settings buttons from this area
- [ ] Keep Copy and Open buttons inside input

### Phase 6: Polish
- [ ] Test hover states on touch devices (consider `:active` state)
- [ ] Verify gradient visibility across different preview images
- [ ] Test truncation at various viewport widths
- [ ] Verify all tooltips are working
- [ ] Test keyboard navigation through card actions

---

## Visual Comparison

```
BEFORE:                                  AFTER:
┌──────────────────────┐                ┌──────────────────────┐
│████████████  ┌─────┐ │                │████████████ ┌──────┐ │
│████████████  │ WS  │ │                │████████████ │Public│ │
│████████████  └─────┘ │                │████████████ ├──────┤ │
│████████████          │                │████████████ │ WS   │ │
├──────────────────────┤                │████████████ └──────┘ │
│                      │                ├──────────────────────┤
│ Title       ┌──────┐ │                │                      │
│             │Public│ │                │ Title            ⚙️  │
│             └──────┘ │                │                      │
│ [📄 source.html]     │                │ 👤 Name  🕐 3d   📄  │
│                      │                │                      │
│ 👤 Name • 3 days ago │                │┌url.app────[📋][↗️]┐│
│                      │                │                      │
│ ┌──────────────────┐ │                └──────────────────────┘
│ │ url.chiridion... │ │
│ └──────────────────┘ │                On hover:
│ [📋][↗️]  [💬][⚙️]   │                ┌──────────────────────┐
│                      │                │████████████ ┌──────┐ │
└──────────────────────┘                │██████████   │Public│ │
                                        │███ ┌──────┐ └──────┘ │
                                        │███ │💬Chat│          │
                                        │▓▓▓ └──────┘ ▓▓▓▓▓▓▓▓ │
                                        ├──────────────────────┤
                                        │ ...                  │
```

---

## Testing Notes

1. **Hover interaction on mobile**: The chat button hover state won't work on touch devices. Consider:
   - Option A: Show chat button always on touch devices (detect with media query `@media (hover: none)`)
   - Option B: Make entire preview area clickable to start chat on mobile
   - Recommendation: Option A - show button at reduced opacity always on touch

2. **Preview image variety**: Test gradient visibility with:
   - Dark preview images
   - Light/white preview images
   - The default globe placeholder

3. **Long app names**: Ensure title truncates properly with settings icon present

4. **Workspace badge with long names**: Ensure workspace badge truncation still works

---

## Summary

This restyle focuses on:

1. **Reducing visual density** - Moving badges to the preview overlay and consolidating metadata
2. **Improving hierarchy** - Title is prominent, settings accessible but subtle
3. **Decluttering actions** - Chat moves to contextual hover, leaving only essential copy/open buttons
4. **Graceful overflow** - Truncation with full text available via tooltips/titles

The changes are purely cosmetic and don't affect any data fetching, state management, or existing functionality.
