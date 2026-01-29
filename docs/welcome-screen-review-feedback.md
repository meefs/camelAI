# Welcome Screen Implementation Review

Feedback on the coding agent's implementation of the chat welcome screen redesign.

---

## 1. Workspace change does not refresh the page

**Priority:** High
**Files:** `src/routes/_app.chat._index.tsx`, `src/components/welcome-screen/index.tsx`

The welcome screen loader fetches `allApps` and `connections` scoped to the current workspace. When the user switches workspaces via the sidebar, `AuthContext.switchWorkspace()` calls `refreshAuth()` to update the auth state, but React Router's loaders are **not** revalidated. This means the welcome screen continues displaying apps and connections from the previous workspace.

**Fix:** The `Chat` component (or the welcome screen wrapper in `NewChatPage`) needs to detect when `currentWorkspace.id` changes and trigger `revalidator.revalidate()`. Several approaches:

- Add a `useEffect` in `NewChatPage` (or a small wrapper) that watches `currentWorkspace?.id` from `useAuth()` and calls `revalidator.revalidate()` when it changes.
- Alternatively, use `key={workspaceId}` on the `<Chat>` component to force a full remount, though that alone won't re-run the loader without revalidation.

The simplest approach:

```tsx
// In NewChatPage or a wrapping component
const { currentWorkspace } = useAuth();
const revalidator = useRevalidator();
const prevWorkspaceRef = useRef(currentWorkspace?.id);

useEffect(() => {
  if (currentWorkspace?.id && currentWorkspace.id !== prevWorkspaceRef.current) {
    prevWorkspaceRef.current = currentWorkspace.id;
    revalidator.revalidate();
  }
}, [currentWorkspace?.id, revalidator]);
```

---

## 2. Cursor is not `pointer` on clickable custom elements

**Priority:** Medium
**Files:** `src/components/welcome-screen/slim-app-card.tsx`, `src/components/welcome-screen/starter-prompts.tsx`, `src/components/welcome-screen/integration-buttons.tsx`, `src/components/welcome-screen/connected-tools.tsx`, `src/components/welcome-screen/section-header.tsx`

All interactive custom elements (app cards, starter prompt cards, integration buttons, connected tool buttons, "View all" link) should show `cursor-pointer` on hover. Native `<button>` elements do show a pointer in most browsers, but the styling resets from Tailwind's preflight (`cursor-default` on buttons) can override this. The `<Link>` in `SectionHeader` should also be confirmed.

**Fix:** Add `cursor-pointer` to each interactive element's `className`:

- `slim-app-card.tsx` line 46: add `cursor-pointer` to the button's `cn()` call
- `starter-prompts.tsx` line 41: add `cursor-pointer` to the prompt button's `cn()` call
- `integration-buttons.tsx` line 32: add `cursor-pointer` to the integration button's `cn()` call
- `connected-tools.tsx` line 23: add `cursor-pointer` to the connected tool button's `cn()` call
- `section-header.tsx` line 19: add `cursor-pointer` to the "View all" link's `className`

---

## 3. Starter prompt title and icons are too large

**Priority:** Medium
**Files:** `src/components/welcome-screen/starter-prompts.tsx`

The current implementation uses `size-5` for icons and `font-semibold` for titles, which makes the prompt cards feel too prominent relative to the rest of the welcome screen content.

**Fix:** Scale down both:

- Icon: change `size-5` to `size-4` (line 48)
- Title: change `font-semibold` to `font-medium text-sm` (line 49)
- Optionally reduce card padding from `p-4` to `p-3` (line 41)

---

## 4. App card design: replace current card with "Frosted Glass Info Bar"

**Priority:** High
**Files:** `src/components/welcome-screen/slim-app-card.tsx`

The current `SlimAppCard` uses a traditional card layout with a separate preview section and a solid `p-3` info block below. Replace this with a frosted glass overlay design.

### Design spec

**Container:**
- Width: `w-[220px]` (up from 180px; at 16:9 this yields ~124px height, better proportions for the preview image within the `max-w-5xl` welcome screen)
- Fixed aspect ratio `16:9` (use `aspect-video`)
- `rounded-xl` with `overflow-hidden`
- `border border-border`
- Transition: `transition-all duration-[250ms] ease-in-out`

**Preview image:**
- Fills the entire card container (no separate info section below)
- `object-cover w-full h-full`
- On hover: `scale-105` with the same `duration-[250ms] ease-in-out`

**Fallback (no preview):**
- Gradient background `bg-gradient-to-br from-muted/60 to-muted`
- Centered `Image` icon (existing pattern is fine)

**Frosted glass info bar (overlays bottom of image):**
- Positioned at the bottom: `absolute bottom-0 left-0 right-0`
- Background: `bg-background/60 backdrop-blur-md`
- Border top: `border-t border-white/10`
- Padding: `px-3 py-2`
- Contains:
  - App name: `font-medium text-sm truncate text-foreground`
  - Below: relative time + status dot, `text-xs text-muted-foreground`

**Hover states (all `duration-[250ms] ease-in-out`):**
- Card border: `hover:border-ring`
- Glass bar background intensifies: `group-hover:bg-background/75`
- An `ArrowRight` icon (from Lucide) slides in from the right edge of the glass bar:
  - Default: `opacity-0 translate-x-2`
  - Hover: `opacity-100 translate-x-0`
  - Size: `size-4 text-muted-foreground`
  - Positioned on the right side of the glass bar, vertically centered

**No Y-axis lift animation** (remove the existing `hover:shadow-md` and any translate-y).

### Approximate JSX structure

```tsx
<button
  type="button"
  onClick={() => onStartChat(app)}
  className={cn(
    'group relative aspect-video overflow-hidden rounded-xl',
    'border border-border cursor-pointer',
    'transition-all duration-[250ms] ease-in-out',
    'hover:border-ring',
    'w-[220px] shrink-0'
  )}
>
  {/* Preview fills entire card */}
  <div className="absolute inset-0">
    {previewUrl && !previewFailed ? (
      <img
        src={previewUrl}
        alt={app.script_name}
        className="w-full h-full object-cover transition-transform duration-[250ms] ease-in-out group-hover:scale-105"
        onError={() => setPreviewFailed(true)}
      />
    ) : (
      <div className="flex items-center justify-center h-full bg-gradient-to-br from-muted/60 to-muted">
        <Image className="size-6 text-muted-foreground/40" />
      </div>
    )}
  </div>

  {/* Frosted glass info bar */}
  <div className={cn(
    'absolute bottom-0 left-0 right-0',
    'bg-background/60 backdrop-blur-md border-t border-white/10',
    'px-3 py-2 flex items-center justify-between',
    'transition-colors duration-[250ms] ease-in-out',
    'group-hover:bg-background/75'
  )}>
    <div className="min-w-0">
      <p className="font-medium text-sm truncate text-foreground">{app.script_name}</p>
      <div className="flex items-center gap-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
        <span className="text-xs text-muted-foreground">
          {getRelativeTime(app.updated_at, renderedAt)}
        </span>
      </div>
    </div>
    <ArrowRight className={cn(
      'size-4 text-muted-foreground shrink-0',
      'transition-all duration-[250ms] ease-in-out',
      'opacity-0 translate-x-2',
      'group-hover:opacity-100 group-hover:translate-x-0'
    )} />
  </div>
</button>
```

---

## Additional observations (minor)

### 5. Animated placeholder should stop on typing, not on focus; input should autoFocus

Two related issues:

**a) `autoFocus` is missing.** The old inline code passed `autoFocus` to `<PromptInput>`. The `WelcomeScreen` does not. The input should be auto-focused on page load so users can immediately start typing without an extra click.

**Fix:** Add `autoFocus` to the `PromptInput` in `welcome-screen/index.tsx` line 170.

**b) Animated placeholder stops on focus instead of on typing.** Currently `handleInputFocus` sets `hasInteracted = true`, which kills the animation as soon as the input receives focus. Since the input will be auto-focused, this means the animation never plays at all.

The correct behavior: the animated placeholder should keep cycling while the input is focused but empty. It should only stop once the user begins typing (i.e., `inputValue.trim()` becomes non-empty). This way the user sees the animated suggestions while the cursor is already in the field, and the animation gracefully yields to the static "Ask anything..." placeholder only after real input begins.

**Fix:**
- Remove `handleInputFocus` and the `onFocus={handleInputFocus}` prop from `PromptInput`.
- Change `shouldAnimatePlaceholder` to depend only on `inputValue`: `const shouldAnimatePlaceholder = !inputValue.trim();`
- Remove the `hasInteracted` state entirely (or keep it only if other sections need it for a different purpose). If starter prompts / sections below the input should remain visible regardless, `hasInteracted` can be dropped.

### 7. `hostname` prop is accepted but not used

`WelcomeScreenProps` declares `hostname?: string` but it's never used inside the component, and `Chat.tsx` doesn't pass it. This is dead code.

**Fix:** Remove `hostname` from `WelcomeScreenProps`.

