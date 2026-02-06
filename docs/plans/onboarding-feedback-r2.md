# Onboarding Implementation Feedback — Round 2

Post-implementation review after the agent addressed round 1 feedback. Four new issues found during manual testing.

**Status of round 1 items:** Issues 1, 2, 2b, 3a–3d, 4a–4e, and 6 are resolved. Issue 5 (post-onboarding chat context injection and profile.md creation) is still outstanding but not re-covered here — it remains the top priority from the previous feedback doc (`onboarding-feedback.md`).

---

## 1. Auto-advance disabled cursor looks bad + add page transition animation

**Severity:** Polish
**Files:** `src/components/onboarding/onboarding-option.tsx`, `src/components/onboarding/design-style-card.tsx`, onboarding layout/routing for animations

### 1a. Remove the "not-allowed" cursor during auto-advance delay

**Problem:** The `useDelayedAdvance` hook correctly prevents double-clicks by setting `isAdvancing = true`, which disables buttons. But the disabled styling on both `OnboardingOption` and `DesignStyleCard` includes `cursor-not-allowed opacity-80`:

**`onboarding-option.tsx:31`:**
```tsx
disabled && 'cursor-not-allowed opacity-80'
```

**`design-style-card.tsx:27`:**
```tsx
disabled && 'cursor-not-allowed opacity-80'
```

The 500ms delay is so short that the "not-allowed" cursor flashing is jarring. The user sees a forbidden cursor for a split second before the page changes — it feels like something broke.

**Fix:** During auto-advance, keep the cursor normal. Don't change opacity either — the selected styling (border highlight, ring) is the visual feedback. Two approaches:

**Option A (simplest):** Change both disabled lines to only prevent pointer events, not change cursor:
```tsx
disabled && 'pointer-events-none'
```
This prevents double-clicks without any visual change to the cursor or opacity.

**Option B (more explicit):** The `useDelayedAdvance` hook could expose an `advancingClassName` that's different from a true `disabled` state. The buttons would receive `pointer-events-none` during advance but keep their normal appearance. This separates "the user selected something and we're transitioning" from "this button is actually disabled."

### 1b. Add a slide animation between questions

**Problem:** Currently, navigating between onboarding questions simply replaces the content instantly. There's no transition — the old question disappears and the new one appears in the same frame. For a polished onboarding experience, this should feel smooth and intentional.

**Fix:** Add a horizontal slide animation so each question slides in from the right when advancing and from the left when going back. This gives the user a sense of progression through a sequence.

**Implementation approach:**

The animation should live at the `OnboardingLayout` level (or in the parent `_onboarding.tsx` `<Outlet>` wrapper) since every question route renders through it. When `location.pathname` changes:
- If advancing (step index increased): new content slides in from right, old content slides out to left
- If going back (step index decreased): new content slides in from left, old content slides out to right

Consider using CSS transitions with a short duration (~250–300ms). A simple approach:

1. Wrap the `<Outlet>` in `_onboarding.tsx` (or the `{children}` in `OnboardingLayout`) with an animated container.
2. Track direction (forward/back) by comparing the previous and current step index.
3. On direction change, apply a CSS class that translates content in/out.

Libraries like `framer-motion` could handle this with `AnimatePresence`, but a CSS-only approach using Tailwind's `transition` + `translate-x` classes would be lighter. A `useRef` to track the previous step index would determine direction.

**Key detail:** The animation should be subtle — don't make it feel like a carousel. A slight slide (maybe 30–50px of travel) with opacity fade is enough. The goal is "smooth" not "dramatic."

---

## 2. Org slug change blocked after going back during onboarding

**Severity:** Bug (blocks feature)
**Files:** `src/routes/_onboarding.org-slug.tsx`, `workers/main/src/auth.ts` (OrgDO `updateSlug` method)

**Problem:** When a user sets their org slug on the slug step and clicks Continue, the slug is saved immediately via `POST /api/orgs/:id/update-slug`. If the user then navigates back (using the Back button) and tries to change the slug to something different, the server responds with `slug_already_finalized` (409) and the update fails.

**Root cause:** The `updateSlug` method in `OrgDO` has three guard checks before allowing a slug change. The third guard is the blocker:

```typescript
// workers/main/src/auth.ts — inside updateSlug()
const priorSlugChange = this.sql.exec<{ action: string }>(
  'SELECT action FROM audit_log WHERE action = ? LIMIT 1',
  'slug_changed'
).toArray();
if (priorSlugChange.length > 0) {
  throw new Error('slug_already_finalized');
}
```

The first time the user clicks Continue on the slug page, the slug is updated and a `slug_changed` audit log entry is written. When they go back and try again, the audit log check finds the existing entry and throws. This makes the slug effectively one-shot, even during the same onboarding session.

**The current flow (`_onboarding.org-slug.tsx:69-101`):**
```tsx
onClick={async () => {
  const normalized = slug.trim().toLowerCase();
  if (normalized !== context.currentOrg.slug) {
    // Saves immediately to the server
    const response = await fetch(`/api/orgs/${context.currentOrg.id}/update-slug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: normalized }),
    });
    // ...
  }
  context.goNext('orgSlug');
}}
```

**Fix — defer slug update to onboarding completion:**

Don't call `update-slug` when clicking Continue on the slug step. Instead, store the desired slug in the onboarding client-side state (just like every other answer) and only persist it when `completeOnboarding` runs at the final step.

1. **On the slug step (`_onboarding.org-slug.tsx`):** Remove the `fetch('/api/orgs/.../update-slug')` call from the Continue button handler. Instead, just store the slug in answers and advance:
   ```tsx
   onClick={() => {
     const normalized = slug.trim().toLowerCase();
     context.updateAnswers({ desired_slug: normalized });
     context.goNext('orgSlug');
   }}
   ```
   (You'll need to add `desired_slug` as an optional field on `OnboardingPreferences` or store it separately in the context.)

2. **On completion (`_onboarding.tsx` `completeOnboarding`):** After saving the onboarding preferences, check if the desired slug differs from the current org slug. If so, call `update-slug` at that point:
   ```tsx
   const completeOnboarding = useCallback(async (overrides) => {
     const withOverrides = mergeAnswers(answers, overrides ?? {});
     const completed = mergeAnswers(withOverrides, { completed_at: Date.now() });
     await saveOnboarding(completed);

     // Persist slug if changed
     if (desiredSlug && desiredSlug !== loaderData.currentOrg.slug) {
       await fetch(`/api/orgs/${loaderData.currentOrg.id}/update-slug`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ slug: desiredSlug }),
       });
     }

     clearStoredProgress();
     navigate('/chat');
   }, [...]);
   ```

3. **Keep the audit log guard on the server.** The `slug_changed` audit log check is still a good safety net for production — it just won't fire during onboarding anymore because the slug is only written once, at the end.

4. **Update the slug input validation:** The `SlugInput` component on the slug page currently compares against `currentSlug` (the org's actual slug) to shortcut as "Available." After this change, when the user goes back, the input should also recognize a previously-entered desired slug as "still your choice" (available without re-checking). Pass the desired slug from context as the `currentSlug` prop, or add separate logic to handle this case.

**Test after fix:** Set a slug → Continue → go back → change the slug → Continue → complete onboarding → verify the final slug stuck.

---

## 3. Design style cards: replace AVIF images with embedded card components

**Severity:** Design (significant rework)
**Files:** `src/components/onboarding/design-style-card.tsx`, `src/routes/_onboarding.q4.tsx`, `src/lib/onboarding.ts`, new file for card component definitions

### 3a. Embed live card components instead of static images

**Problem:** The AVIF image previews are blurry at some screen sizes and don't convey the design differences clearly enough. The user has provided complete React component code for all 5 design styles in `docs/onboarding-design-cards.tsx`.

**What the reference file contains:** Five self-contained card components (`ColorfulCard`, `SleekCard`, `MinimalCard`, `WarmCard`, `BoldCard`), each rendering a "Team Standup" app mockup in a distinct visual style. Each card:
- Uses a unique font family (`Nunito`, `Inter`, `JetBrains Mono`, `Lora`, `Instrument Serif` + `DM Sans`)
- Has a distinct color scheme, border radius, and layout
- Includes team members, status indicators, and an input field
- Has a styled background/container specific to the style

**Fix:**

1. **Extract the 5 card components into a real source file** (e.g., `src/components/onboarding/design-style-previews.tsx`). Adapt from `docs/onboarding-design-cards.tsx` — remove the `AllStyles` wrapper, export just the 5 card components individually or as a map keyed by style value.

2. **Load the required fonts.** The cards depend on Google Fonts that aren't currently loaded:
   - Nunito (Colorful & Playful)
   - Inter (Sleek & Modern) — may already be loaded since it's the app font
   - JetBrains Mono (Minimal & Clean)
   - Lora (Warm & Friendly)
   - Instrument Serif (Bold & Dramatic)
   - DM Sans (Bold & Dramatic — body text)

   Add a Google Fonts `<link>` in `src/root.tsx` for these families. Only load the weights actually used (check the inline styles in each card). Example:
   ```html
   <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800&family=JetBrains+Mono:wght@400;500&family=Lora:wght@400;600;700&family=Instrument+Serif&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet" />
   ```

   Consider loading these fonts only on the Q4 route (lazy-load) to avoid penalizing the rest of the app. A `<link>` in the Q4 route's `meta` or a dynamic import would work.

3. **Update `DesignStyleCard` to render a component instead of an image.** The card component should accept a `preview` prop (a React component) instead of (or in addition to) `image`:
   ```tsx
   interface DesignStyleCardProps {
     label: string;
     preview: React.ComponentType;  // replaces `image`
     selected: boolean;
     onClick: () => void;
     disabled?: boolean;
   }

   export function DesignStyleCard({ label, preview: Preview, selected, onClick, disabled }: DesignStyleCardProps) {
     return (
       <button
         type="button"
         onClick={onClick}
         disabled={disabled}
         className={cn(
           'relative overflow-hidden rounded-xl border text-left transition-all',
           'hover:border-foreground/40',
           selected && 'border-foreground ring-2 ring-foreground/20',
           disabled && 'pointer-events-none'
         )}
       >
         {/* Render the preview card — pointer-events-none so clicks go to the button */}
         <div className="pointer-events-none select-none">
           <Preview />
         </div>
         {/* Label overlay at bottom */}
         <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3">
           <span className="text-sm font-medium text-white">{label}</span>
         </div>
       </button>
     );
   }
   ```

   **Important:** The preview cards have their own background colors (e.g., `bg-neutral-950` for Sleek, `bg-white` for Minimal). The `pointer-events-none` on the wrapper prevents the input fields and buttons inside the previews from capturing clicks.

4. **Update `DESIGN_STYLE_OPTIONS` in `onboarding.ts`** to reference the preview components instead of image paths. Or, keep the mapping in the Q4 route itself to avoid importing React components into a data file:
   ```tsx
   // In _onboarding.q4.tsx
   import { ColorfulCard, SleekCard, MinimalCard, WarmCard, BoldCard } from '@/components/onboarding/design-style-previews';

   const STYLE_PREVIEWS: Record<string, React.ComponentType> = {
     colorful: ColorfulCard,
     sleek: SleekCard,
     minimal: MinimalCard,
     warm: WarmCard,
     bold: BoldCard,
   };
   ```

5. **Remove the AVIF images** from `public/images/onboarding/` once the embedded cards are working. Remove the `image` field from `DESIGN_STYLE_OPTIONS` (or leave it as a fallback).

### 3b. "I'll tell you each time" is too minimal — make it visually discoverable

**Problem:** The current text-only button is so subtle that users don't realize it's an option:

```tsx
<button
  type="button"
  className={cn(
    'inline-flex items-center text-sm transition-colors ...',
    context.answers.design_style === 'per_project'
      ? 'font-medium text-foreground'
      : 'text-muted-foreground hover:text-foreground'
  )}
>
  I&apos;ll tell you each time
</button>
```

It reads as footnote text, not a selectable option.

**Fix:** Give it enough visual presence to be recognized as a choice, while still being distinct from the visual cards. A bordered pill/chip or a light card treatment would work:

```tsx
<button
  type="button"
  disabled={isAdvancing}
  onClick={() => selectStyle('per_project')}
  className={cn(
    'w-full rounded-xl border px-4 py-3 text-left text-sm transition-colors',
    'hover:border-foreground/30',
    context.answers.design_style === 'per_project'
      ? 'border-foreground bg-muted font-medium'
      : 'text-muted-foreground'
  )}
>
  I'll decide on a per-project basis
</button>
```

This matches the interaction pattern of `OnboardingOption` — a bordered, full-width, clickable row — so it's obviously selectable. The lack of a visual preview naturally distinguishes it from the 5 image cards above.

---

## 4. Add a search bar to the integrations section

**Severity:** Feature
**File:** `src/components/onboarding/data-interest-grid.tsx`

**Problem:** With 40+ integrations across 2+ pages, finding a specific integration requires scanning through or paginating. Users who know they want "Notion" or "Jira" shouldn't have to hunt for it.

**Fix:** Add a search/filter input at the top of the Connections section. It should:

1. **Filter integrations by name** — match against the label (case-insensitive substring or fuzzy match).
2. **Search across all pages**, not just the current page — when the user types a query, the pagination should operate on the filtered results.
3. **Preserve selections** — filtering should not deselect previously selected integrations. Selections are stored in the parent state, so this should work naturally.
4. **Reset pagination to page 1** when the search query changes.
5. **Clear the search** when the user clears the input or clicks an "X" button.

**Suggested implementation:**

Add a `searchQuery` state to `DataInterestGrid`:
```tsx
const [searchQuery, setSearchQuery] = useState('');

const filteredIntegrations = useMemo(() => {
  if (!searchQuery.trim()) return integrationOptions;
  const q = searchQuery.toLowerCase();
  return integrationOptions.filter((opt) =>
    opt.label.toLowerCase().includes(q) || opt.id.toLowerCase().includes(q)
  );
}, [integrationOptions, searchQuery]);
```

Then paginate `filteredIntegrations` instead of `integrationOptions`. Reset the page when the query changes:
```tsx
useEffect(() => {
  setIntegrationPage(0);
}, [searchQuery]);
```

The search input should be compact — a small text input next to the "Connections" label, or between the label and the pagination controls:
```tsx
<div className="mb-3 flex items-center justify-between gap-3">
  <div className="text-sm font-medium text-muted-foreground">
    Connections
    <span className="ml-2 text-xs font-normal">(live API access)</span>
  </div>
  <div className="flex items-center gap-2">
    <Input
      placeholder="Search..."
      value={searchQuery}
      onChange={(e) => setSearchQuery(e.target.value)}
      className="h-7 w-40 text-xs"
    />
    {/* pagination controls */}
  </div>
</div>
```

When there are no results for a search, show a brief "No integrations found" message instead of an empty grid.

---

## Priority Order

| # | Issue | Severity | Effort |
|---|-------|----------|--------|
| 5* | Chat context injection + profile.md (from round 1) | Critical bug | Medium |
| 2 | Org slug blocked after going back | Bug | Medium |
| 3 | Embed live card components for design style | Design | Medium-Large |
| 1 | Cursor polish + page transition animation | Polish | Small-Medium |
| 4 | Search bar for integrations | Feature | Small |

*Issue 5 is carried forward from round 1 feedback — see `onboarding-feedback.md` for details.
