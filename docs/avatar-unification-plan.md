# Avatar Unification Plan

This document outlines a comprehensive plan to standardize avatar styling throughout the Chiridion application, ensuring consistent appearance across all sizes and implementing dynamic font sizing based on character count.

---

## Problem Statement

Avatars currently render inconsistently across the application:

1. **Shape inconsistency:** Some avatars render as circles (`rounded-full`), others as rounded squares (`rounded-lg`)
2. **Size-to-font ratio varies:** Large avatars (64px) use `text-2xl`, small avatars use various sizes, with no consistent proportion
3. **Content overflow:** In tight spaces (e.g., chat history workspace badge), text overflows the avatar bounds
4. **No character-aware sizing:** Two-character initials appear cramped compared to single-character content (emoji or single letter)

**Goal:** Create a unified avatar system where avatars look identical regardless of where they appear, with font size scaling proportionally to avatar size and adapting to character count.

---

## Current Implementation Audit

### Core Files

| File | Purpose |
|------|---------|
| `src/lib/avatar.ts` | Avatar colors, validation, contrast calculation |
| `src/components/ui/avatar.tsx` | Base Avatar component (shadcn) |
| `src/components/settings/avatar-picker.tsx` | Avatar configuration UI |

### Avatar Usages by Location

| Location | File | Size | Shape | Font Size |
|----------|------|------|-------|-----------|
| Sidebar user button | `nav-user.tsx:96-100` | h-8 w-8 (32px) | `rounded-lg` | inherited |
| Sidebar user dropdown | `nav-user.tsx:118-122` | h-8 w-8 (32px) | `rounded-lg` | inherited |
| Sidebar workspace button | `workspace-switcher.tsx:88-97` | h-8 w-8 (32px) | `rounded-lg` | inherited |
| Sidebar workspace dropdown | `workspace-switcher.tsx:128-136` | h-6 w-6 (24px) | default | inherited |
| Settings user avatar | `profile-form.tsx:82-90` | h-16 w-16 (64px) | default | `text-2xl` |
| Settings workspace avatar | `workspace-general-form.tsx:88-96` | h-16 w-16 (64px) | default | inherited |
| Chat row creator | `chat-row.tsx:207-225` | size="xs" (14px) | default | `text-[8.5px]` |
| Chat row workspace badge | `chat-row.tsx:195-205` | w-4 h-4 (16px) | inline span | `text-[10px]` |
| Team table members | `team-table.tsx:250-259` | h-8 w-8 (32px) | default | inherited |
| Team table mobile | `team-table.tsx:426-434` | h-9 w-9 (36px) | default | inherited |
| Workspace access tags | `workspace-access-tags.tsx:158-168` | h-5 w-5 (20px) | default | `fontSize: 0.625rem` |
| Workspaces list | `workspaces-list.tsx:154-162` | h-8 w-8 (32px) | default | inherited |
| Admin users table | `qaml-backdoor/users/page.tsx:92-101` | h-8 w-8 (32px) | default | inherited |
| Admin user detail | `qaml-backdoor/users/[id]/page.tsx:107-117` | h-16 w-16 (64px) | default | `text-2xl` |
| Admin workspaces table | `qaml-backdoor/workspaces/page.tsx:97-106` | h-8 w-8 (32px) | default | inherited |
| Admin workspace detail | `qaml-backdoor/workspaces/[id]/page.tsx:130-143` | h-10 w-10 (40px) | default | inherited |
| Admin org workspace table | `qaml-backdoor/orgs/[id]/page.tsx:229-238` | h-8 w-8 (32px) | default | inherited |
| Admin org member table | `qaml-backdoor/orgs/[id]/page.tsx:297-306` | h-8 w-8 (32px) | default | inherited |

### Key Issues Identified

1. **Sidebar uses `rounded-lg` instead of `rounded-full`** - User and workspace avatars in sidebar are squares with rounded corners

2. **Chat row workspace badge is inline implementation** - Uses raw `<span>` with `rounded-full` instead of Avatar component, causing overflow

3. **Font sizes are ad-hoc** - Settings uses `text-2xl` for 64px avatar, chat row uses `text-[8.5px]` for 14px avatar, but there's no consistent ratio

4. **No character-count awareness** - "MY" (2 chars) renders same font size as "🐱" (1 char), causing cramping

---

## Design Decisions

### 1. Standardize on Circles Everywhere

All avatars will use `rounded-full` for a consistent circular appearance. The sidebar's current `rounded-lg` squares will be converted to circles.

### 2. Define Size Variants with Proportional Font Scaling

Create explicit size variants with mathematically proportional font sizes:

| Variant | Container | Font (1 char) | Font (2 char) | Use Case |
|---------|-----------|---------------|---------------|----------|
| `2xs` | 14px | 8px | 7px | Chat row creator |
| `xs` | 16px | 9px | 8px | Chat row workspace badge |
| `sm` | 20px | 11px | 10px | Workspace access tags |
| `md` | 24px | 13px | 12px | Sidebar dropdown items |
| `default` | 32px | 16px | 14px | Tables, sidebar buttons |
| `lg` | 40px | 20px | 18px | Admin detail views |
| `xl` | 64px | 32px | 28px | Settings display |

**Font ratio:** ~50% of container size for 1 char, ~44% for 2 chars

### 3. Dynamic Font Sizing Based on Content

The Avatar component will:
1. Detect if content is 1 character (emoji or single letter) vs 2 characters (initials)
2. Apply appropriate font size class based on character count
3. Use `isEmoji()` helper from `avatar.ts` to detect emojis (which count as 1 char visually)

### 4. Single Source of Truth

All avatar rendering will flow through the enhanced `Avatar` component. No more inline `<span>` implementations.

---

## Component Architecture

### Enhanced Avatar Component API

```tsx
// src/components/ui/avatar.tsx

interface AvatarProps {
  size?: '2xs' | 'xs' | 'sm' | 'md' | 'default' | 'lg' | 'xl';
  // ... existing props
}

interface AvatarFallbackProps {
  /** Avatar content for character-count-aware font sizing */
  content?: string;
  // ... existing props
}
```

### Size Configuration Object

```typescript
const avatarSizes = {
  '2xs': {
    container: 'size-3.5',      // 14px
    font1: 'text-[8px]',
    font2: 'text-[7px]',
  },
  'xs': {
    container: 'size-4',        // 16px
    font1: 'text-[9px]',
    font2: 'text-[8px]',
  },
  'sm': {
    container: 'size-5',        // 20px
    font1: 'text-[11px]',
    font2: 'text-[10px]',
  },
  'md': {
    container: 'size-6',        // 24px
    font1: 'text-[13px]',
    font2: 'text-[12px]',
  },
  'default': {
    container: 'size-8',        // 32px
    font1: 'text-[16px]',
    font2: 'text-[14px]',
  },
  'lg': {
    container: 'size-10',       // 40px
    font1: 'text-[20px]',
    font2: 'text-[18px]',
  },
  'xl': {
    container: 'size-16',       // 64px
    font1: 'text-[32px]',
    font2: 'text-[28px]',
  },
};
```

### Character Detection Logic

```typescript
// In avatar.tsx or imported from avatar.ts
function getCharacterCount(content: string): 1 | 2 {
  // Use isEmoji from avatar.ts
  if (isEmoji(content)) return 1;
  // Grapheme-aware length for proper Unicode handling
  const graphemes = [...new Intl.Segmenter().segment(content)];
  return graphemes.length === 1 ? 1 : 2;
}
```

---

## Implementation Changes

### 1. Update `src/components/ui/avatar.tsx`

**Changes:**
- Add new size variants: `2xs`, `xs`, `sm`, `md`, `lg`, `xl`
- Remove `rounded-lg` - all avatars use `rounded-full`
- Add `content` prop to `AvatarFallback` for character-aware font sizing
- Export size config for external use if needed

**Key modifications:**

```tsx
// Size variant mapping
const sizeVariants = cva("...", {
  variants: {
    size: {
      "2xs": "size-3.5",
      "xs": "size-4",
      "sm": "size-5",
      "md": "size-6",
      "default": "size-8",
      "lg": "size-10",
      "xl": "size-16",
    }
  }
});

// AvatarFallback with dynamic font sizing
const AvatarFallback = React.forwardRef<..., AvatarFallbackProps>(
  ({ content, size, className, ...props }, ref) => {
    const charCount = content ? getCharacterCount(content) : 2;
    const fontClass = avatarSizes[size][charCount === 1 ? 'font1' : 'font2'];

    return (
      <AvatarPrimitive.Fallback
        ref={ref}
        className={cn(fontClass, className)}
        {...props}
      />
    );
  }
);
```

### 2. Update `src/components/sidebar/nav-user.tsx`

**Changes:**
- Remove `rounded-lg` override, use default circular avatar
- Pass `content` prop to AvatarFallback

**Lines to modify:** 96-100, 118-122

```tsx
// Before
<Avatar className="h-8 w-8 rounded-lg">

// After
<Avatar size="default">
  <AvatarFallback content={avatarContent} ...>
```

### 3. Update `src/components/sidebar/workspace-switcher.tsx`

**Changes:**
- Remove `rounded-lg` override on current workspace avatar
- Use `size="md"` for dropdown items (h-6 w-6)
- Pass `content` prop to all AvatarFallback instances

**Lines to modify:** 62-63, 88-97, 128-136

### 4. Update `src/components/settings/profile-form.tsx`

**Changes:**
- Use `size="xl"` instead of `h-16 w-16`
- Remove `text-2xl` - let component handle font sizing
- Pass `content` prop

**Lines to modify:** 82-90

### 5. Update `src/components/settings/workspace-general-form.tsx`

**Changes:**
- Use `size="xl"` instead of `h-16 w-16`
- Pass `content` prop

**Lines to modify:** 88-96

### 6. Update `src/components/history/chat-row.tsx`

**Changes:**
- Replace inline workspace badge span with Avatar component
- Use `size="xs"` for workspace badge (16px)
- Use `size="2xs"` for creator avatar (14px)
- Pass `content` prop for dynamic font sizing

**Lines to modify:** 195-205 (workspace badge), 207-225 (creator avatar)

```tsx
// Before (inline span)
<span
  className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[10px]"
  style={{ backgroundColor: workspace.avatar.color, ... }}
>
  {workspace.avatar.content}
</span>

// After (Avatar component)
<Avatar size="xs">
  <AvatarFallback
    content={workspace.avatar.content}
    style={{ backgroundColor: workspace.avatar.color, ... }}
  >
    {workspace.avatar.content}
  </AvatarFallback>
</Avatar>
```

### 7. Update `src/components/settings/team-table.tsx`

**Changes:**
- Pass `content` prop to member avatar fallbacks
- Keep `size="default"` (32px) for desktop, may need `lg` variant for mobile (h-9)

**Lines to modify:** 250-259, 359-361, 426-434

### 8. Update `src/components/settings/workspace-access-tags.tsx`

**Changes:**
- Use `size="sm"` (20px) instead of `h-5 w-5`
- Remove inline `fontSize` style
- Pass `content` prop

**Lines to modify:** 158-168

### 9. Update `src/components/settings/workspaces-list.tsx`

**Changes:**
- Pass `content` prop to AvatarFallback

**Lines to modify:** 154-162, 225-233

### 10. Update Admin Pages

**Files:**
- `src/app/(admin)/qaml-backdoor/users/page.tsx` (lines 92-101)
- `src/app/(admin)/qaml-backdoor/users/[id]/page.tsx` (lines 107-117)
- `src/app/(admin)/qaml-backdoor/workspaces/page.tsx` (lines 97-106)
- `src/app/(admin)/qaml-backdoor/workspaces/[id]/page.tsx` (lines 130-143)
- `src/app/(admin)/qaml-backdoor/orgs/[id]/page.tsx` (lines 229-238, 297-306)

**Changes:**
- Use size variants instead of manual h-X w-X classes
- Pass `content` prop
- Remove `text-2xl` from detail views

### 11. Update `src/components/settings/avatar-picker.tsx`

**Changes:**
- Use `size="xl"` for preview avatar
- Pass `content` prop for accurate preview of character sizing

**Lines to modify:** Preview avatar rendering section

---

## Migration Strategy

### Phase 1: Enhance Avatar Component
1. Add size variants to `avatar.tsx`
2. Add `content` prop to `AvatarFallback`
3. Implement character detection and dynamic font sizing
4. Ensure backward compatibility (existing usages should still work)

### Phase 2: Update High-Visibility Locations
1. Sidebar avatars (nav-user.tsx, workspace-switcher.tsx)
2. Settings avatars (profile-form.tsx, workspace-general-form.tsx)
3. Chat history badges (chat-row.tsx) - fix the overflow issue

### Phase 3: Update Remaining Locations
1. Team table (team-table.tsx)
2. Workspace access tags (workspace-access-tags.tsx)
3. Workspaces list (workspaces-list.tsx)

### Phase 4: Update Admin Pages
1. Admin user/workspace tables and detail views

### Phase 5: Verification
1. Visual audit of all avatar locations
2. Test with various content: emoji, single letter, two letters
3. Test across all size variants
4. Verify dark/light mode appearance

---

## Testing Checklist

### Visual Consistency
- [ ] All avatars render as circles (no rounded squares)
- [ ] Sidebar user avatar is circular
- [ ] Sidebar workspace avatar is circular
- [ ] Settings avatars show proper proportions

### Font Scaling
- [ ] 64px avatar shows appropriately sized text
- [ ] 32px avatar shows appropriately sized text
- [ ] 16px avatar shows readable text without overflow
- [ ] 14px avatar shows readable text without overflow

### Character-Aware Sizing
- [ ] Single emoji renders larger font
- [ ] Two-letter initials render slightly smaller font
- [ ] Single letter renders larger font
- [ ] No text overflow in any avatar size

### Edge Cases
- [ ] Invitation avatars (email first letter) render correctly
- [ ] Empty/no workspace state renders correctly
- [ ] Very long emoji sequences handled gracefully

---

## Files to Modify (Summary)

| File | Changes |
|------|---------|
| `src/components/ui/avatar.tsx` | Add size variants, content prop, dynamic font sizing |
| `src/lib/avatar.ts` | Export `isEmoji` if not already (for character detection) |
| `src/components/sidebar/nav-user.tsx` | Remove rounded-lg, use Avatar properly |
| `src/components/sidebar/workspace-switcher.tsx` | Remove rounded-lg, use size variants |
| `src/components/settings/profile-form.tsx` | Use size="xl", pass content |
| `src/components/settings/workspace-general-form.tsx` | Use size="xl", pass content |
| `src/components/history/chat-row.tsx` | Replace inline span with Avatar component |
| `src/components/settings/team-table.tsx` | Pass content prop |
| `src/components/settings/workspace-access-tags.tsx` | Use size="sm", pass content |
| `src/components/settings/workspaces-list.tsx` | Pass content prop |
| `src/components/settings/avatar-picker.tsx` | Use size="xl" for preview |
| `src/app/(admin)/qaml-backdoor/users/page.tsx` | Use size variants |
| `src/app/(admin)/qaml-backdoor/users/[id]/page.tsx` | Use size="xl" |
| `src/app/(admin)/qaml-backdoor/workspaces/page.tsx` | Use size variants |
| `src/app/(admin)/qaml-backdoor/workspaces/[id]/page.tsx` | Use size="lg" |
| `src/app/(admin)/qaml-backdoor/orgs/[id]/page.tsx` | Use size variants |

---

## Summary

This plan unifies avatar styling by:

1. **Standardizing shape:** All avatars become circles (`rounded-full`)
2. **Defining size variants:** 7 sizes from 14px to 64px with proportional font scaling
3. **Dynamic font sizing:** Smaller font for 2-char content, larger for 1-char (emoji/single letter)
4. **Single component:** All avatar rendering flows through the enhanced Avatar component

The result is avatars that look identical in proportion and style regardless of where they appear in the app.
