# Onboarding Overhaul Plan

## Problem

4 of 10 beta users who sign up never reach their first chat. The current onboarding flow has 5-7 multi-screen steps (welcome, org slug, AI familiarity, iteration style, design style, starter project, data interests) that new users must complete before they can interact with the product. Many drop off partway through, and they never experience the core value — chatting with Claude.

## Goal

Every user reaches their first chat. Strip onboarding to the absolute minimum, move preference-gathering into the chat itself using the `AskUserQuestion` tool call, and let the agent build the user's profile through conversation.

---

## New Flow

### Non-team user (standard signup)

```
 ┌─────────────┐     ┌───────────────────────────────────┐     ┌──────────────────────────────┐
 │             │     │                                   │     │                              │
 │   Sign up   │────▶│   POST /api/onboarding/complete   │────▶│  /chat/{threadId}?newThread=1 │
 │   (auth)    │     │   (instant — no questions)        │     │                              │
 │             │     │                                   │     │  ┌──────────────────────────┐ │
 └─────────────┘     └───────────────────────────────────┘     │  │  Post-Onboarding Modal   │ │
                                                               │  │  (existing ~6s boot      │ │
                                                               │  │   animation, unchanged)  │ │
                                                               │  └──────────┬───────────────┘ │
                                                               │             │ auto-dismiss     │
                                                               │             ▼                  │
                                                               │  Claude's first message with   │
                                                               │  AskUserQuestion tool call:    │
                                                               │                                │
                                                               │  ┌──────────────────────────┐  │
                                                               │  │ "Claude needs your input" │  │
                                                               │  │                          │  │
                                                               │  │ Q: What do you want to   │  │
                                                               │  │    build first?           │  │
                                                               │  │                          │  │
                                                               │  │ ○ Data analytics          │  │
                                                               │  │ ○ Personal site           │  │
                                                               │  │ ○ Business tool           │  │
                                                               │  │ ○ Other                   │  │
                                                               │  │                          │  │
                                                               │  │            [Next ›]       │  │
                                                               │  └──────────────────────────┘  │
                                                               │                                │
                                                               └────────────────────────────────┘
```

### Team user (invitation flow)

```
 ┌──────────────┐     ┌─────────────────────────┐     ┌────────────────────┐
 │  Accept      │     │  /onboarding?team=1     │     │ POST               │
 │  invitation  │────▶│  Welcome to {orgName}   │────▶│ /api/onboarding/   │────▶  /chat/{id}
 │              │     │  [Get Started]          │     │ complete           │    + boot modal
 └──────────────┘     └─────────────────────────┘     └────────────────────┘
```

Team users keep the existing welcome screen (shows team context, member count, deployed apps). They click "Get Started" and go directly to chat. No questions.

---

## What Changes

### 1. Remove all onboarding question steps

Delete these route files and their route entries in `src/routes.ts`:

| File | What it was |
|------|-------------|
| `src/routes/_onboarding.q1.tsx` | AI familiarity step |
| `src/routes/_onboarding.q2.tsx` | Iteration style step |
| `src/routes/_onboarding.q4.tsx` | Design style step |
| `src/routes/_onboarding.q5.tsx` | Starter project step |
| `src/routes/_onboarding.q6.tsx` | Data interests step |
| `src/routes/_onboarding.org-slug.tsx` | Org slug selection step |

### 2. Remove onboarding UI components that become dead

| File | Why dead |
|------|----------|
| `src/components/onboarding/single-choice-step.tsx` | Used by Q1, Q2, Q5 — all deleted |
| `src/components/onboarding/design-style-card.tsx` | Used by Q4 — deleted |
| `src/components/onboarding/design-style-previews.tsx` | Used by Q4 — deleted |
| `src/components/onboarding/data-interest-grid.tsx` | Used by Q6 — deleted |
| `src/components/onboarding/onboarding-option.tsx` | Shared option component for question steps |
| `src/components/onboarding/slug-input.tsx` | Used by org-slug step — deleted |
| `src/components/onboarding/onboarding-progress.tsx` | Progress dots — no longer needed (1-step flow) |

**Keep:**
| File | Why kept |
|------|----------|
| `src/components/onboarding/onboarding-layout.tsx` | Still used by team welcome screen |
| `src/components/onboarding-loading-modal.tsx` | Post-onboarding boot modal (unchanged) |

### 3. Remove the mid-flow save endpoint

**Delete:** `src/routes/api/onboarding.ts` (the `POST /api/onboarding` route)

This endpoint existed to save partial progress during the multi-step flow. With no steps, there's nothing to save mid-flow. Remove its route entry from `src/routes.ts` as well.

### 4. Simplify `_onboarding.tsx` layout

The layout (`src/routes/_onboarding.tsx`) currently manages:
- Multi-step sequence calculation (`getStepSequence`)
- localStorage progress persistence
- Answer state and transition animations
- Mid-flow save calls
- Org slug state

**Simplify to:**
- For non-team users: call `completeOnboarding()` immediately (no UI, no outlet). The loader redirects auth'd users straight to chat after marking onboarding complete.
- For team users (`?team=1`): render the welcome `<Outlet>` as before, with a simplified context that only provides `completeOnboarding` and `skipToChat`.

**Implementation approach — redirect in the loader:**

```typescript
// In _onboarding.tsx loader:
export async function loader({ request, context }: Route.LoaderArgs) {
  const sessionContext = await requireSession(request, context);
  // ... existing auth checks ...

  const url = new URL(request.url);
  const teamMode = url.searchParams.get('team') === '1';

  // Already completed? Go to chat.
  if (onboardingComplete && !teamMode) {
    throw redirect('/chat');
  }

  // Non-team user who hasn't completed? Complete now and redirect.
  if (!teamMode && !onboardingComplete) {
    // Server-side completion: mark onboarding done, create thread, redirect
    // See section 5 for the server-side instant-complete flow
    throw redirect('/api/onboarding/complete-and-redirect');
  }

  // Team mode: show welcome screen
  return { ...loaderData, teamWelcomeOnly: false };
}
```

Alternatively (and likely simpler), keep the existing layout but short-circuit it: if `!teamMode`, call `completeOnboarding()` from a `useEffect` on mount and show a minimal loading state while that resolves. This avoids adding a new server-side redirect endpoint.

**Recommended approach — client-side auto-complete:**

```typescript
// In _onboarding.tsx default component:
export default function OnboardingLayout() {
  const loaderData = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [completing, setCompleting] = useState(false);
  const completedRef = useRef(false);

  // Non-team users: auto-complete immediately
  useEffect(() => {
    if (loaderData.teamMode || completedRef.current) return;
    completedRef.current = true;
    setCompleting(true);

    fetch('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarding: { completed_at: Date.now() } }),
    })
      .then(res => res.json())
      .then(data => {
        const { threadId, onboardingSystemMessage, redirectTo } = data;
        if (threadId && onboardingSystemMessage) {
          sessionStorage.setItem(
            'pendingMessage:newThread',
            JSON.stringify({
              message: `<camelai system message>${onboardingSystemMessage}</camelai system message>`,
              threadId,
            })
          );
        }
        sessionStorage.setItem('showBootModal', '1');
        navigate(redirectTo || '/chat');
      })
      .catch(() => navigate('/chat'));
  }, [loaderData.teamMode, navigate]);

  // Non-team: show minimal loading while completing
  if (!loaderData.teamMode) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Team mode: render the welcome screen outlet
  return <Outlet context={contextValue} />;
}
```

### 5. Simplify `onboarding.complete.ts`

The `/api/onboarding/complete` action currently:
1. Processes org slug update (if `desiredSlug` provided)
2. Normalizes and saves onboarding preferences
3. Checks email verification
4. Creates first chat thread
5. Builds system context from preferences
6. Builds profile markdown from preferences
7. Writes `profile.md` to sandbox filesystem

**Changes:**
- **Remove** slug update logic entirely (lines 98-124). The `desiredSlug` parameter is no longer accepted.
- **Remove** profile markdown generation and file write (`buildOnboardingProfileMarkdown`, `writeOnboardingProfile`, the `waitUntil` call). The agent will build the user's profile through conversation instead.
- **Remove** integration name map building (only used for profile/system context).
- **Simplify** the system message to a minimal instruction that tells the agent to ask onboarding questions (see section 7).
- **Keep** email verification check.
- **Keep** thread creation.
- **Keep** returning `{ threadId, onboardingSystemMessage, redirectTo }`.

### 6. Clean up `src/lib/onboarding.ts`

This file contains all the onboarding constants, option arrays, step sequence logic, and profile/system-message builders.

**Remove:**
- `OnboardingStepId` type (or reduce to just `'welcome'`)
- `OnboardingTransitionDirection` type
- `OnboardingProgressState` interface
- `OnboardingOption`, `DesignStyleOption`, `StarterProjectOption`, `IntegrationInterestOption` interfaces
- `STEP_PATHS` constant (or reduce to just `welcome`)
- `AI_FAMILIARITY_OPTIONS`, `ITERATION_STYLE_OPTIONS`, `STAKES_OPTIONS`, `DESIGN_STYLE_OPTIONS`, `STARTER_PROJECT_OPTIONS`, `DATA_FILE_OPTIONS`, `DEFAULT_INTEGRATION_INTERESTS` arrays
- All label records (`AI_FAMILIARITY_LABELS`, `ITERATION_STYLE_LABELS`, etc.)
- `STARTER_PROJECT_GUIDANCE` record
- `getStepSequence()`, `getNearestValidStep()`, `getStepIndex()`, `getNextStep()`, `getPreviousStep()` functions
- `buildOnboardingSystemContext()` function
- `buildOnboardingProfileMarkdown()` function
- `ONBOARDING_PROGRESS_STORAGE_KEY_PREFIX` constant and `getOnboardingProgressStorageKey()` function

**Keep:**
- `DEFAULT_ONBOARDING_PREFERENCES` (still used for initial state)
- `normalizePreferences()` (still used by server)
- `hasCompletedOnboarding()` (still used by guards)
- `stepIdFromPath()` — can remove if no longer used after simplification

### 7. New system message for first chat

Replace `buildOnboardingSystemContext()` with a simple static string returned by `onboarding.complete.ts`. This message is what the agent receives as its first hidden user message via the `pendingMessage:newThread` pattern.

```
New user just signed up and landed in their first chat. This is their very first
interaction with camelAI. They have not answered any onboarding questions yet.

Use AskUserQuestion to greet them and learn what they want to build. Ask 1 question
at a time with 2-3 questions total:

1. First, ask what they want to build (their starter project). Options:
   - Data analytics (upload spreadsheets or connect a database for insights)
   - Personal site (portfolio, blog, or landing page)
   - Business tool (internal tools, dashboards, admin panels)
   - AI agent (chatbots, agents, AI-powered tools)
   - Something fun (games, experiments, creative projects)

2. Then ask about their experience level. Options:
   - Yes, extensively (I use AI coding tools regularly)
   - Yes, occasionally (I've vibe-coded a few things)
   - A little (I've chatted with AI but haven't built much)
   - This is new to me (first time trying something like this)

After they answer, save their preferences to ~/.chiridion/profile.md as a markdown
document, then immediately start helping them with their chosen project. Match your
communication style to their experience level — be more explanatory for beginners,
more concise for power users.
```

**Design rationale — question selection:**

| Old question | Disposition | Reasoning |
|---|---|---|
| AI familiarity (Q1) | **Keep — moved to chat as Q2** | Directly affects how the agent communicates. Beginners need hand-holding; power users want brevity. High signal. |
| Iteration style (Q2) | **Remove** | This is a communication meta-preference that the agent can infer from conversation patterns. Low signal for cold start. |
| Design style (Q4) | **Remove** (per your request) | Visual preference is better expressed per-project in conversation ("make it minimal" / "use bright colors"). |
| Starter project (Q5) | **Keep — moved to chat as Q1** | Highest-signal question. Directly determines what the agent does next. Moved to first position because it's the most actionable. |
| Data interests (Q6) | **Remove** | Overlaps with starter project. The agent will discover data needs naturally ("drag a CSV here" or "want to connect a database?"). |
| Org slug | **Remove** (per your request) | Users can no longer customize org slug during onboarding. Getting to first chat is more important. |
| Stakes | **Remove** (was already partially removed) | Can be inferred from project choice and conversation. |

**Why starter project goes first:** It's the one question that changes what happens next. A "data analytics" user should see "drag a CSV here"; a "personal site" user should be asked about design. Asking it first in chat means the agent can start working immediately after the answer.

**Why experience level goes second:** It calibrates the agent's tone and verbosity for the rest of the session. It's low-friction to answer and takes <5 seconds.

**Why only 2 questions:** Every extra question is another point where users might disengage. Two questions take ~10 seconds. The agent can learn everything else through natural conversation.

### 8. Agent writes `profile.md` itself

Currently the server writes `~/.chiridion/profile.md` during `onboarding.complete.ts` via `waitUntil()`. This is being removed.

Instead, the system message (section 7) instructs the agent to write `~/.chiridion/profile.md` after the user answers the in-chat questions. The agent has full filesystem access and already knows how to write files. This is more natural — the profile reflects actual conversation, not just checkbox answers.

### 9. Clean up `_onboarding.welcome.tsx`

The welcome screen is **kept only for team users** (`?team=1`). Changes:

- Remove the non-team welcome content (the "Welcome to camelAI" / "Let's get you set up" / "Get Started" button path). Non-team users never see this page anymore.
- Keep the team welcome content ("Welcome to {orgName}", team summary, "Get Started" button).
- The "Get Started" button for team users should call `completeOnboarding()` directly (no navigation to next step).
- Email verification UI remains for team users if needed.

### 10. Clean up `OnboardingPreferences` type

The `OnboardingPreferences` type in `src/types.ts` currently has many fields. Since we're no longer collecting these during onboarding, simplify:

```typescript
// Before
export interface OnboardingPreferences {
  ai_familiarity: OnboardingAiFamiliarity | null;
  iteration_style: OnboardingIterationStyle | null;
  stakes: OnboardingStakes | null;
  design_style: OnboardingDesignStyle | null;
  starter_project: OnboardingStarterProject | null;
  data_interests: {
    files: OnboardingFileType[];
    integrations: string[];
  };
  completed_at: number | null;
}

// After
export interface OnboardingPreferences {
  completed_at: number | null;
}
```

Also remove the associated type aliases that are no longer used:
- `OnboardingAiFamiliarity`
- `OnboardingIterationStyle`
- `OnboardingStakes`
- `OnboardingDesignStyle`
- `OnboardingStarterProject`
- `OnboardingFileType`

**Migration note:** `UserDO` stores existing onboarding data. Existing users already have `completed_at` set. The `_app.tsx` guard checks `onboarding?.completed_at` — this continues to work. Old preference fields remain in storage harmlessly.

### 11. Route cleanup in `src/routes.ts`

Remove these route entries:

```typescript
// Remove from onboarding section:
route('org-slug', 'routes/_onboarding.org-slug.tsx'),
route('ai-familiarity', 'routes/_onboarding.q1.tsx'),
route('iteration-style', 'routes/_onboarding.q2.tsx'),
route('design-style', 'routes/_onboarding.q4.tsx'),
route('starter-project', 'routes/_onboarding.q5.tsx'),
route('data-interests', 'routes/_onboarding.q6.tsx'),

// Remove from API section:
route('api/onboarding', 'routes/api/onboarding.ts'),
```

**Keep:**
```typescript
route('onboarding', 'routes/_onboarding.tsx', [
  index('routes/_onboarding.welcome.tsx'),   // team welcome only
]),
route('api/onboarding/complete', 'routes/api/onboarding.complete.ts'),
```

### 12. Update the boot modal messaging (optional polish)

The existing `onboarding-loading-modal.tsx` boot lines reference "Loading onboarding context" — this line can be updated to something more accurate since we're no longer loading preferences:

```
Before: "Loading onboarding context" / "Claude already knows what you want to build"
After:  "Starting conversation"      / "Claude is ready to learn what you want to build"
```

This is a minor copy change. The modal component, timing, and behavior are unchanged.

---

## Dead Code Summary

All files and exports to remove, grouped by directory:

### Route files to delete
```
src/routes/_onboarding.q1.tsx
src/routes/_onboarding.q2.tsx
src/routes/_onboarding.q4.tsx
src/routes/_onboarding.q5.tsx
src/routes/_onboarding.q6.tsx
src/routes/_onboarding.org-slug.tsx
src/routes/api/onboarding.ts
```

### Component files to delete
```
src/components/onboarding/single-choice-step.tsx
src/components/onboarding/design-style-card.tsx
src/components/onboarding/design-style-previews.tsx
src/components/onboarding/data-interest-grid.tsx
src/components/onboarding/onboarding-option.tsx
src/components/onboarding/slug-input.tsx
src/components/onboarding/onboarding-progress.tsx
```

### Type exports to remove from `src/types.ts`
```
OnboardingAiFamiliarity
OnboardingIterationStyle
OnboardingStakes
OnboardingDesignStyle
OnboardingStarterProject
OnboardingFileType
```

(And simplify `OnboardingPreferences` to just `{ completed_at: number | null }`)

### Exports to remove from `src/lib/onboarding.ts`
```
ONBOARDING_PROGRESS_STORAGE_KEY_PREFIX
getOnboardingProgressStorageKey()
OnboardingStepId (or reduce to 'welcome')
OnboardingTransitionDirection
OnboardingProgressState
OnboardingOption
DesignStyleOption
StarterProjectOption
IntegrationInterestOption
STEP_PATHS (or reduce)
AI_FAMILIARITY_OPTIONS
ITERATION_STYLE_OPTIONS
STAKES_OPTIONS
DESIGN_STYLE_OPTIONS
STARTER_PROJECT_OPTIONS
DATA_FILE_OPTIONS
DEFAULT_INTEGRATION_INTERESTS
AI_FAMILIARITY_LABELS
ITERATION_STYLE_LABELS
STAKES_LABELS
DESIGN_STYLE_LABELS
STARTER_PROJECT_LABELS
STARTER_PROJECT_GUIDANCE
getStepSequence()
getNearestValidStep()
getStepIndex()
getNextStep()
getPreviousStep()
buildOnboardingSystemContext()
buildOnboardingProfileMarkdown()
stepIdFromPath()
```

### Functions to remove from `onboarding.complete.ts`
```
normalizeOnboardingInput()  — simplify, only needs completed_at
normalizeSlug()             — slug handling removed
isOwnerForOrg()             — slug handling removed
buildIntegrationNameMap()   — preferences removed
writeOnboardingProfile()    — agent writes profile now
```

---

## Files Changed (not deleted)

| File | Change |
|------|--------|
| `src/routes.ts` | Remove 7 route entries |
| `src/routes/_onboarding.tsx` | Replace multi-step layout with auto-complete + team-only outlet |
| `src/routes/_onboarding.welcome.tsx` | Remove non-team welcome; team "Get Started" calls `completeOnboarding()` directly |
| `src/routes/api/onboarding.complete.ts` | Remove slug, preferences, profile write; return simplified system message |
| `src/lib/onboarding.ts` | Remove ~90% of exports (keep `normalizePreferences`, `hasCompletedOnboarding`, `DEFAULT_ONBOARDING_PREFERENCES`) |
| `src/types.ts` | Remove 6 type aliases, simplify `OnboardingPreferences` |
| `src/components/onboarding-loading-modal.tsx` | Optional: update "Loading onboarding context" copy |
| `src/components/onboarding/onboarding-layout.tsx` | Remove progress props if `onboarding-progress.tsx` is deleted; simplify |
| `AGENTS.md` | Update Onboarding section to reflect new flow |

---

## What Stays the Same

- **Auth flow**: Signup, login, email verification — unchanged
- **`_app.tsx` guard**: Still checks `onboarding?.completed_at` and redirects to `/onboarding`
- **Post-onboarding boot modal**: Still plays the ~6s terminal animation. Still triggered via `sessionStorage.setItem('showBootModal', '1')`
- **Pending message handoff**: Still uses `sessionStorage.setItem('pendingMessage:newThread', ...)` pattern
- **Chat.tsx**: No changes needed — it already consumes the boot modal flag and pending message
- **`clientLoader` in `_app.chat.$id.tsx`**: Still intercepts `?newThread=1` for fast loading
- **Team invitation flow**: Team users still see a welcome screen before entering chat

---

## Implementation Order

1. **Simplify types** — Update `OnboardingPreferences` in `src/types.ts`, remove dead type aliases
2. **Gut `src/lib/onboarding.ts`** — Remove dead exports, keep the 3 survivors
3. **Simplify `onboarding.complete.ts`** — Remove slug/preferences/profile logic, add new system message
4. **Rewrite `_onboarding.tsx`** — Auto-complete for non-team, outlet for team
5. **Update `_onboarding.welcome.tsx`** — Team-only welcome, direct complete on "Get Started"
6. **Delete route files** — Remove Q1-Q6, org-slug routes and their entries in `routes.ts`
7. **Delete dead components** — Remove 7 component files from `src/components/onboarding/`
8. **Delete `api/onboarding.ts`** — Remove mid-flow save endpoint and route entry
9. **Update `onboarding-layout.tsx`** — Remove progress-related props/rendering
10. **Optional: Update boot modal copy** — "Starting conversation" instead of "Loading onboarding context"
11. **Update `AGENTS.md`** — Document new onboarding flow
12. **Run tests** — `bun run test:run` to verify nothing breaks

---

## Not in Scope

- Changes to the `AskUserQuestion` component rendering (`src/components/ask-user-question.tsx`) — already works perfectly for this use case
- Changes to the control plane or SDK — the system message is passed via existing `pendingMessage` pattern
- Changes to `ChatThreadDO` or WebSocket handling
- Org slug settings page — users who want to change their slug later can do so from org settings (existing feature)
- Migration of existing user data — old preferences remain in `UserDO` storage harmlessly
