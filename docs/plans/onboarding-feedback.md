# Onboarding Implementation Feedback

Post-implementation review. Six issues found during manual testing.

---

## 1. Auto-advance feels glitchy — add a brief delay after selection

**Severity:** Polish
**Files:** All question routes that auto-advance on selection (`_onboarding.q1.tsx`, `_onboarding.q2.tsx`, `_onboarding.q3.tsx`, `_onboarding.q4.tsx`, `_onboarding.q5.tsx`)

**Problem:** When a user clicks an option, the navigation fires instantly in the same event handler. The selected state (border highlight, ring) never has time to render before the page transitions. It feels broken/glitchy rather than intentional.

**Example from `_onboarding.q1.tsx:42-44`:**
```tsx
onClick={() => {
  context.updateAnswers({ ai_familiarity: option.value });
  context.goNext('q1');  // fires immediately — no visual feedback
}}
```

**Fix:** Add a ~500ms delay between setting the selection and navigating. The user should see their choice visually land (the selected border/ring transition completing) before the screen changes. Something like:

```tsx
onClick={() => {
  context.updateAnswers({ ai_familiarity: option.value });
  setTimeout(() => context.goNext('q1'), 500);
}}
```

Apply this pattern to every question route that auto-advances on click: Q1, Q2, Q3, Q4 (design cards), and Q5. Consider extracting a shared helper (e.g., `delayedAdvance(stepId, delay?)`) to keep it DRY. Make sure the option is visually disabled / not re-clickable during the delay so double-clicks don't cause issues.

---

## 2. Slug availability check hangs on "Checking..." forever

**Severity:** Bug (blocks feature)
**Files:** `src/components/onboarding/slug-input.tsx`, `src/routes/api/orgs.$id.check-slug.ts`

**Problem:** The auto-generated slug correctly shows as "Available" on page load (because of the `normalizedValue === normalizedCurrentSlug` shortcut at line 106). But when the user starts typing a new slug, the status goes to "Checking..." and never resolves. The "Continue" button stays disabled forever.

**Root cause analysis:** The issue is likely in the `useEffect` dependency array at `slug-input.tsx:128-133`:

```tsx
useEffect(() => {
  // ... debounce + fetch logic ...
}, [
  fetcher,          // ← THIS IS THE PROBLEM
  normalizedCurrentSlug,
  normalizedValue,
  orgId,
]);
```

`fetcher` is a React Router fetcher object. Its reference changes on every render cycle when `fetcher.state` or `fetcher.data` changes. This causes the effect to re-fire continuously:
1. User types → effect fires → `fetcher.submit()` called → `fetcher.state` changes to `'submitting'`
2. `fetcher` reference changes → effect re-runs → `clearTimeout` kills the pending timer → sets up a new timer
3. New timer fires → `fetcher.submit()` again → infinite loop of cancelling and restarting

The second `useEffect` (lines 83-103) that reads `fetcher.state` and `fetcher.data` may also be fighting with the first effect, since both react to fetcher changes.

**Fix approach:**
- Remove `fetcher` from the dependency array of the debounce effect. Instead, use `fetcher.submit` (which is a stable reference) or put the fetcher in a ref.
- Alternatively, restructure to use two separate concerns: one effect that debounces and sets a "slug to check" state variable, and another that actually fires the fetch when that variable changes. This avoids the circular dependency entirely.
- Make sure the `requestedSlugRef` check at line 90 works correctly after the fix — it should prevent stale responses from overwriting the status.

**Test after fix:** Type a new slug, confirm spinner appears briefly, then resolves to "Available" or "Already taken". Confirm the "Continue" button enables. Confirm the slug actually persists (click Continue, go back, verify the slug stuck).

### 2b. URL preview looks too similar to the text input

**Severity:** Design polish
**File:** `src/components/onboarding/slug-input.tsx` (line 174)

**Problem:** The URL preview box (`rounded-lg border bg-muted/40 px-3 py-2`) has nearly the same visual weight as the text input above it. On dark backgrounds especially, both look like bordered input fields — it's confusing which one is editable and which is read-only.

**Current (`slug-input.tsx:174-176`):**
```tsx
<div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
  URL preview: <span className="font-medium">https://my-app--{normalizedValue || 'your-slug'}.{vanityDomain}</span>
</div>
```

**Fix:** Reduce the visual prominence of the preview. Remove the border and background so it reads as helper text, not a field. For example:

```tsx
<p className="text-sm text-muted-foreground">
  Your apps will live at{' '}
  <span className="font-medium text-foreground">
    https://my-app--{normalizedValue || 'your-slug'}.{vanityDomain}
  </span>
</p>
```

This makes it clearly informational — not an input. The URL itself gets `text-foreground` to stand out, while the surrounding label stays muted.

---

## 3. Design Style question needs layout and copy rework

**Severity:** Design
**Files:** `_onboarding.q4.tsx`, `src/components/onboarding/design-style-card.tsx`, `src/lib/onboarding.ts` (the `DESIGN_STYLE_OPTIONS` array)

**Problems (from screenshot):**

### 3a. Cards must show full images at natural proportions — no uniform container
The current `DesignStyleCard` forces every card into `aspect-[4/3]` with `object-cover`, which crops the images into identical boxes. This cuts off important details of the images and defeats the purpose of the previews — the whole point is that each design style has *different* font sizes, padding, spacing, and layout. Users need to see those differences to make a meaningful choice.

The source images are all the same width but intentionally different heights:
- `ob-preview-colorful-and-playful.avif`: 580 x 502
- `ob-preview-warm-and-friendly.avif`: 580 x 506
- `ob-preview-sleek-and-modern.avif`: 580 x 547
- `ob-preview-bold-and-dramatic.avif`: 580 x 512
- `ob-preview-minimal-and-clean.avif`: 580 x 606

**Fix:** Remove the fixed `aspect-[4/3]` ratio and `object-cover` cropping. Instead, show each image at its natural proportions — the cards should be the same width (from the grid column) but different heights (from the image content). Each image should be fully visible, not cropped.

The `DesignStyleCard` component should use something like:
```tsx
<button className="overflow-hidden rounded-xl border ...">
  <img src={image} alt="" className="w-full h-auto" />
  {/* Label overlay at bottom */}
</button>
```

This means the cards in a 2-column grid will have mismatched heights across rows — and that's fine. CSS `grid` handles this naturally (each row takes the height of its tallest item). The visual variety is intentional and helps communicate the design differences.

### 3b. Grid should be 2 columns, not 3
On large monitors the 3-column grid makes each card too small. Switch to a 2-column grid on desktop for the 5 image cards.

**Current (`_onboarding.q4.tsx:38`):**
```tsx
<div className="grid grid-cols-2 gap-3 md:grid-cols-3">
```

**Fix:**
```tsx
<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
```

This also allows the max-width of the onboarding layout to be wider for this step (or the cards themselves to be larger).

### 3c. "I'll tell you each time" looks bad as a card
The empty muted-bg card with just text looks out of place next to the visual preview cards.

**Fix:** Remove `per_project` from the grid of `DesignStyleCard` components entirely. Instead, render it below the grid as a text-only option — either as an `OnboardingOption` (consistent with other questions) or as a simple text button link. For example:

```tsx
{/* Image cards grid - only the 5 visual options */}
<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
  {DESIGN_STYLE_OPTIONS.filter(s => s.image).map((style) => (
    <DesignStyleCard ... />
  ))}
</div>

{/* Text option below */}
<button
  onClick={() => { /* select per_project and advance */ }}
  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
>
  I'll tell you each time →
</button>
```

### 3d. Copy could be more compelling
The current subheader is: "You can always ask Claude to try a different style in chat later."

**Suggested revision — put more emphasis on *why* they're picking:**
- **Title:** "What vibe fits your style?" (or keep "What vibe do you usually like?")
- **Subheader:** "Pick the design direction that feels most like you. Claude will use this as a starting point — you can always change it in chat."

This frames it as a *starting point*, not a permanent choice, and emphasizes personal fit.

---

## 4. Data Sources & Integrations needs rework

**Severity:** Design + missing feature
**Files:** `_onboarding.q6.tsx`, `src/components/onboarding/data-interest-grid.tsx`, `src/lib/onboarding.ts`

### 4a. Use actual integration logos from `public/logos/`
The current `DataInterestGrid` renders integration options as plain text buttons with no logos. We have an existing logo system at `src/lib/integration-icons.tsx` with a `logoRegistry` of **40+ integrations** — use the `IntegrationIcon` component to render them.

**Note:** `IntegrationIcon` currently imports `useTheme` from `next-themes`. This project uses React Router, not Next.js. You'll likely need to adapt the theme detection (e.g., check the `dark` class on `<html>` or use a different theme hook). Fix this before using the component.

### 4b. Show ALL integrations that have logos, not just 8
The current `DEFAULT_INTEGRATION_INTERESTS` in `src/lib/onboarding.ts:213-222` only lists 8 integrations (Stripe, Slack, Notion, GitHub, Airtable, Linear, Salesforce, HubSpot). The `logoRegistry` in `src/lib/integration-icons.tsx` has **40+ entries**. We should show all of them — this is one of Chiridion's selling points.

**Derive the integration list from the logo registry** rather than hard-coding a subset. Build the list from the keys of `logoRegistry` (which are the integration types that have logos available), mapping each to its display name.

### 4c. Paginate integrations to avoid pushing the CTA off screen
With 40+ integrations, the grid would be too tall. Add pagination:
- Show ~20 integrations per page
- Add a "Next" / "Previous" navigation in the section header (top right of the Connections section)
- Preserve selections across pages

### 4d. Integration buttons should be compact (logo + name, no wasted space)
Currently the buttons are on a `grid-cols-4` layout with fixed sizing. Instead, make each button only as wide as its logo + label requires. Use a flex-wrap layout rather than a rigid grid:

```tsx
<div className="flex flex-wrap gap-2">
  {pageIntegrations.map((option) => (
    <button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ...">
      <IntegrationIcon type={option.id} size={16} />
      <span>{option.label}</span>
    </button>
  ))}
</div>
```

### 4e. "Continue to Chat" button should be full-width and more inviting
**Current (`_onboarding.q6.tsx:105-114`):**
```tsx
<Button type="button" size="lg" disabled={submitting} onClick={...}>
  {submitting ? 'Finishing...' : 'Continue to Chat'}
</Button>
```

**Fix:**
- Make it full-width within the question content area: add `className="w-full"`
- Change the text from "Continue to Chat" to **"Let's get started"** (or "Let's go" / "Start building") — something more energizing as the final CTA of onboarding

---

## 5. Post-onboarding chat context injection and profile creation don't work

**Severity:** Bug (critical — core value prop of onboarding is broken)
**Files:** `src/routes/_app.chat._index.tsx` (the `createThread` action where onboarding context is injected), related sandbox/workspace code for profile.md writing

**Problem:** After completing the onboarding flow, the user is redirected to `/chat` but:
1. **No invisible starter message is injected** — Claude doesn't greet the user with personalized context based on their onboarding answers
2. **No `~/.chiridion/profile.md` is created** in the workspace filesystem

These are the two core outcomes of the onboarding flow — without them, collecting all those preferences is pointless.

**What to investigate:**
- The `createThread` action in `_app.chat._index.tsx` has the logic to call `buildOnboardingSystemContext()` and `buildOnboardingProfileMarkdown()`, but it may not be getting triggered correctly. Possible issues:
  - The `onboarding_context_injected_at` flag check
  - The `hasUserThreadsInOrg` check (maybe the user already has threads from before onboarding was implemented)
  - The actual mechanism for injecting the system context into the WebSocket/Claude SDK call
  - The file write to `~/.chiridion/profile.md` via the workspace container
- This is the most important feature to fix — the entire onboarding flow exists to produce this context.

---

## 6. localStorage progress leaks between user accounts

**Severity:** Bug
**File:** `src/routes/_onboarding.tsx` (the `readStoredProgress` and localStorage write logic)

**Problem:** The localStorage key `chiridion:onboarding:progress` is not scoped to a user. When User A completes part of onboarding, logs out, and User B logs in on the same browser, User B sees User A's pre-filled answers restored from localStorage.

**Current key (`src/lib/onboarding.ts:11`):**
```typescript
export const ONBOARDING_PROGRESS_STORAGE_KEY = 'chiridion:onboarding:progress';
```

**Fix:** Include the user ID in the localStorage key:
```typescript
// The key should be built dynamically, not a constant
`chiridion:onboarding:progress:${userId}`
```

The user ID is available from the loader data (via `authContext`). Pass it down to the layout component and use it when reading/writing localStorage. Also update `clearStoredProgress()` to clear the user-specific key.

Additionally, when restoring progress, validate that the stored answers belong to the current user — even if someone manipulates localStorage, it shouldn't corrupt another user's onboarding.

---

## Priority Order

| # | Issue | Severity | Effort |
|---|-------|----------|--------|
| 5 | Chat context injection + profile.md don't work | Critical bug | Medium |
| 2 | Slug availability check hangs forever | Bug (blocks feature) | Small |
| 6 | localStorage leaks between accounts | Bug | Small |
| 1 | Auto-advance too fast (no visual feedback) | Polish | Small |
| 3 | Design style layout/copy rework | Design | Medium |
| 4 | Data interests: logos, pagination, layout | Design + feature | Medium-Large |
