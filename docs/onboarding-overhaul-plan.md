# Onboarding Overhaul Plan

## Problem

4 of 10 beta users who sign up never reach their first chat. The current onboarding flow has 5-7 multi-screen steps (welcome, org slug, AI familiarity, iteration style, design style, starter project, data interests) that new users must complete before they can interact with the product. Many drop off partway through, and they never experience the core value — chatting with Claude.

## Goal

Every user reaches their first chat. Strip onboarding to the absolute minimum, move preference-gathering into the chat itself using the `AskUserQuestion` tool call, and let the agent build the user's profile through conversation.

---

## New Flow

There are three user paths. OAuth users skip straight to chat. Password users must verify email first. Team users see a welcome screen.

### Path A: OAuth signup (Google/GitHub) — no welcome screen

```
 ┌──────────────┐     ┌───────────────┐     ┌──────────────────────────────────┐
 │              │     │  /onboarding   │     │  /chat/{threadId}?newThread=1    │
 │  OAuth       │────▶│  auto-complete │────▶│                                 │
 │  signup      │     │  (useEffect,   │     │  ┌────────────────────────────┐  │
 │              │     │   no UI)       │     │  │  Post-Onboarding Modal     │  │
 └──────────────┘     └───────────────┘     │  │  (~6s boot animation)      │  │
                                             │  └──────────┬─────────────────┘  │
                                             │             │ auto-dismiss       │
                                             │             ▼                    │
                                             │  "Hi! I'm Claude..." +          │
                                             │  AskUserQuestion (2 Qs):        │
                                             │                                 │
                                             │  ┌───────────────────────────┐   │
                                             │  │ "Claude needs your input" │   │
                                             │  │                           │   │
                                             │  │ Starter project  (1 of 2) │   │
                                             │  │ What do you want to build │   │
                                             │  │ first?                    │   │
                                             │  │                           │   │
                                             │  │ ○ Data analytics          │   │
                                             │  │ ○ Personal site           │   │
                                             │  │ ○ Business tool           │   │
                                             │  │ ○ Something fun           │   │
                                             │  │                           │   │
                                             │  │              [Next ›]     │   │
                                             │  └───────────────────────────┘   │
                                             │             │                    │
                                             │             ▼                    │
                                             │  ┌───────────────────────────┐   │
                                             │  │                           │   │
                                             │  │ Data setup     (2 of 2)  │   │
                                             │  │ Do you have data or       │   │
                                             │  │ services to connect?      │   │
                                             │  │                           │   │
                                             │  │ ○ I have files to upload  │   │
                                             │  │ ○ Help me connect a       │   │
                                             │  │   service                 │   │
                                             │  │ ○ Not right now           │   │
                                             │  │                           │   │
                                             │  │             [Submit ⏎]    │   │
                                             │  └───────────────────────────┘   │
                                             │                                  │
                                             └──────────────────────────────────┘
```

### Path B: Password signup — welcome screen with email verification gate

```
 ┌──────────────┐     ┌────────────────────────────────────────┐     ┌──────────────┐
 │              │     │  /onboarding (welcome screen)          │     │              │
 │  Password    │────▶│                                        │────▶│  /chat/{id}  │
 │  signup      │     │  ┌──────────────────────────────────┐  │     │  + boot      │
 │              │     │  │  Welcome to camelAI               │  │     │    modal     │
 └──────────────┘     │  │                                    │  │     │  + agent Qs  │
                       │  │  camelAI is your AI software       │  │     │              │
                       │  │  engineer. Claude has a permanent  │  │     └──────────────┘
                       │  │  computer here, so it can build,   │  │
                       │  │  deploy, and maintain applications  │  │
                       │  │  for you.                          │  │
                       │  │                                    │  │
                       │  │  ┌──────────────────────────────┐  │  │
                       │  │  │ ✉ Verify your email          │  │  │
                       │  │  │                              │  │  │
                       │  │  │ We sent a link to            │  │  │
                       │  │  │ user@example.com             │  │  │
                       │  │  │                              │  │  │
                       │  │  │ [Resend verification email]  │  │  │
                       │  │  └──────────────────────────────┘  │  │
                       │  │                                    │  │
                       │  │  [Get Started] (disabled til        │  │
                       │  │   verified)                        │  │
                       │  └──────────────────────────────────┘  │
                       └────────────────────────────────────────┘
```

### Path C: Team invitation — welcome screen with team context

```
 ┌──────────────┐     ┌────────────────────────────────────────┐     ┌──────────────┐
 │  Accept      │     │  /onboarding?team=1                    │     │              │
 │  invitation  │────▶│                                        │────▶│  /chat/{id}  │
 │              │     │  ┌──────────────────────────────────┐  │     │  + boot      │
 └──────────────┘     │  │  Welcome to {orgName}             │  │     │    modal     │
                       │  │                                    │  │     │  + agent Qs  │
                       │  │  You're joining a team that's      │  │     │              │
                       │  │  already building.                 │  │     └──────────────┘
                       │  │                                    │  │
                       │  │  ┌──────────────────────────────┐  │  │
                       │  │  │ 5 team members • 3 apps       │  │  │
                       │  │  │ deployed • Connected to Slack  │  │  │
                       │  │  └──────────────────────────────┘  │  │
                       │  │                                    │  │
                       │  │  [Get Started]                      │  │
                       │  └──────────────────────────────────┘  │
                       └────────────────────────────────────────┘
```

All three paths end with the same experience: boot modal plays, auto-dismisses, and the agent greets the user with 2 `AskUserQuestion` questions in chat.

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
| `src/components/onboarding/onboarding-progress.tsx` | Progress dots — no longer needed (single-action flows) |

**Keep:**
| File | Why kept |
|------|----------|
| `src/components/onboarding/onboarding-layout.tsx` | Still used by welcome screens (password verification + team) |
| `src/components/onboarding-loading-modal.tsx` | Post-onboarding boot modal (copy update only — see section 12) |

### 3. Remove the mid-flow save endpoint

**Delete:** `src/routes/api/onboarding.ts` (the `POST /api/onboarding` route)

This endpoint existed to save partial progress during the multi-step flow. With no steps, there's nothing to save mid-flow. Remove its route entry from `src/routes.ts` as well.

### 4. Rewrite `_onboarding.tsx` layout

The layout (`src/routes/_onboarding.tsx`) currently manages:
- Multi-step sequence calculation (`getStepSequence`)
- localStorage progress persistence
- Answer state and transition animations
- Mid-flow save calls
- Org slug state

**Replace with three-way routing logic:**

1. **Already completed + not team** → redirect to `/chat` (existing behavior, keep)
2. **OAuth user, no verification needed, not team** → auto-complete via `useEffect`, no UI
3. **Password user needing verification, OR team user** → render `<Outlet>` (welcome screen)

Remove all of the following from the component:
- `answers` state and `mergeAnswers` helper
- `showOrgSlugStep` / `pendingOrgSlug` state
- `transitionDirection` and `previousStepIndexRef`
- `readStoredProgress` and localStorage persistence effects
- `saveOnboarding` callback (used `POST /api/onboarding` — that endpoint is deleted)
- `shouldRevalidate` export (was for multi-step navigation — no longer needed)
- `OnboardingProgressState`-related types and imports
- The step sequence/index calculations (`sequence`, `currentStepIndex`, `totalSteps`)

**Simplified component:**

```typescript
export default function OnboardingLayout() {
  const loaderData = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const completedRef = useRef(false);

  const needsWelcomeScreen = loaderData.teamMode || loaderData.emailVerificationRequired;

  // OAuth non-team users: auto-complete immediately, no UI
  useEffect(() => {
    if (needsWelcomeScreen || completedRef.current) return;
    completedRef.current = true;

    fetch('/api/onboarding/complete', { method: 'POST' })
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
  }, [needsWelcomeScreen, navigate]);

  // Auto-completing: show minimal spinner
  if (!needsWelcomeScreen) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Password-verification or team user: show welcome screen
  return <Outlet context={contextValue} />;
}
```

The `OnboardingRouteContext` type is also dramatically simplified — it only needs: `completeOnboarding`, `teamMode`, `userEmail`, `emailVerificationRequired`, `emailVerified`.

Note: the `fetch` call sends no body. `onboarding.complete.ts` sets `completed_at` server-side (see section 5).

**Loader changes:**

The loader keeps the existing auth checks and email verification status fetch. The key change: instead of computing step sequences and org slug eligibility, it just returns the fields needed for the three-way routing:

```typescript
return {
  userId: authBootstrap.profile.id,
  userEmail: authBootstrap.profile.email,
  orgId: sessionContext.session.org_id,
  onboarding,
  teamMode,
  emailVerificationRequired: emailVerificationStatus.required && !emailVerificationStatus.verified,
  emailVerified: emailVerificationStatus.verified,
} satisfies OnboardingLoaderData;
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

**Target state — the entire file after changes:**

```typescript
import type { Route } from './+types/onboarding.complete';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as chatDO from '@/lib/chat-do.server';

const ONBOARDING_SYSTEM_MESSAGE = `...`; // see section 7

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const workspaceId = authContext.currentWorkspace?.id;
  if (!workspaceId) {
    return Response.json({ error: 'No workspace selected' }, { status: 400 });
  }

  // Email verification gate (password-based signups)
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(authContext.user.id)
  );
  const verificationStatus = await userStub.getEmailVerificationStatus();
  if (verificationStatus.required && !verificationStatus.verified) {
    return Response.json(
      { error: 'Please verify your email before completing onboarding.' },
      { status: 403 }
    );
  }

  // Mark onboarding complete
  await userStub.updateOnboarding({ completed_at: Date.now() });

  // Create first thread
  const thread = await chatDO.createThread(
    context,
    workspaceId,
    undefined,
    authContext.user.id
  );

  return Response.json({
    success: true,
    threadId: thread.id,
    onboardingSystemMessage: ONBOARDING_SYSTEM_MESSAGE,
    redirectTo: `/chat/${thread.id}?newThread=1`,
  });
}
```

**What's removed:**
- `normalizeOnboardingInput()` — no preferences to normalize
- `normalizeSlug()` — no slug handling
- `isOwnerForOrg()` — no slug handling
- `buildIntegrationNameMap()` — no preferences
- `writeOnboardingProfile()` — profile-writer subagent handles this
- `waitUntil` import — no background work
- `buildOnboardingSystemContext` / `buildOnboardingProfileMarkdown` imports
- `INTEGRATION_REGISTRY` import
- `WorkspaceContainer` import
- Request body parsing — endpoint needs no body

**What's kept:**
- Email verification gate (password-based signups still require verification)
- Thread creation
- System message return (now a static string constant)

### 6. Clean up `src/lib/onboarding.ts`

This file contains all the onboarding constants, option arrays, step sequence logic, and profile/system-message builders.

**Remove everything except `hasCompletedOnboarding()`:**
- `OnboardingStepId` type
- `OnboardingTransitionDirection` type
- `OnboardingProgressState` interface
- `OnboardingOption`, `DesignStyleOption`, `StarterProjectOption`, `IntegrationInterestOption` interfaces
- `STEP_PATHS` constant
- `AI_FAMILIARITY_OPTIONS`, `ITERATION_STYLE_OPTIONS`, `STAKES_OPTIONS`, `DESIGN_STYLE_OPTIONS`, `STARTER_PROJECT_OPTIONS`, `DATA_FILE_OPTIONS`, `DEFAULT_INTEGRATION_INTERESTS` arrays
- All label records (`AI_FAMILIARITY_LABELS`, `ITERATION_STYLE_LABELS`, etc.)
- `STARTER_PROJECT_GUIDANCE` record
- `getStepSequence()`, `getNearestValidStep()`, `getStepIndex()`, `getNextStep()`, `getPreviousStep()`, `stepIdFromPath()` functions
- `buildOnboardingSystemContext()` function
- `buildOnboardingProfileMarkdown()` function
- `ONBOARDING_PROGRESS_STORAGE_KEY_PREFIX` constant and `getOnboardingProgressStorageKey()` function
- `DEFAULT_ONBOARDING_PREFERENCES` — no longer needed; `onboarding.complete.ts` constructs `{ completed_at: Date.now() }` directly
- `normalizePreferences()` — no preferences to normalize; the type is just `{ completed_at: number | null }`

**Keep:**
- `hasCompletedOnboarding()` — still used by the `_app.tsx` guard and the `_onboarding.tsx` loader

After cleanup, the file is just:

```typescript
import type { OnboardingPreferences } from '@/types';

export function hasCompletedOnboarding(
  onboarding: OnboardingPreferences | null | undefined
): boolean {
  return Boolean(onboarding?.completed_at);
}
```

### 7. New system message for first chat

Replace `buildOnboardingSystemContext()` with a static string constant in `onboarding.complete.ts`. This message is what the agent receives as its first hidden user message via the `pendingMessage:newThread` pattern. It is used for all user types (OAuth, password, team).

```
This user just signed up and landed in their first chat. This is their very
first interaction with camelAI.

Welcome them briefly (1-2 sentences), then immediately use AskUserQuestion
with these 2 questions in a single tool call:

Question 1 — "What do you want to build first?"
  header: "Starter project"
  multiSelect: false
  Options:
  - label: "Data analytics"
    description: "Upload spreadsheets or connect a database for insights"
  - label: "Personal site"
    description: "Portfolio, blog, or landing page"
  - label: "Business tool"
    description: "Internal tools, dashboards, admin panels"
  - label: "Something fun"
    description: "Games, experiments, creative projects"

Question 2 — "Do you have data or services to connect?"
  header: "Data setup"
  multiSelect: false
  Options:
  - label: "I have files to upload"
    description: "CSVs, spreadsheets, PDFs, or other data files"
  - label: "Help me connect a service"
    description: "Walk me through connecting a database, Slack, or API"
  - label: "Not right now"
    description: "I'll jump straight into building"

After they answer, immediately start helping them based on their choices:
- If they chose "Data analytics" + "I have files to upload": prompt them to
  drag a file into the chat
- If they chose "Help me connect a service": walk them through the
  connections setup flow
- Otherwise: start building their chosen project right away
```

**Design rationale — question selection:**

| Old question | Disposition | Reasoning |
|---|---|---|
| AI familiarity (Q1) | **Remove** | Feedback shows this question makes less experienced users feel bad and frames the product as "vibe coding." The agent can infer experience level from conversation patterns naturally. |
| Iteration style (Q2) | **Remove** | Communication meta-preference the agent infers from conversation. Low signal for cold start. |
| Design style (Q4) | **Remove** | Visual preference is better expressed per-project in conversation ("make it minimal" / "use bright colors"). |
| Starter project (Q5) | **Keep — moved to chat as Q1** | Highest-signal question. Directly determines what the agent does next. |
| Data interests (Q6) | **Reworked — moved to chat as Q2** | Reframed from "what file types interest you" (checkbox grid) to "do you have data or services to connect?" (actionable single-select). Directly leads to next action — upload prompt, connection walkthrough, or jump to building. |
| Org slug | **Remove from onboarding** | Slug customization remains available in org settings but is no longer part of onboarding. Getting to first chat is more important. |
| Stakes | **Remove** (was already partially removed) | Inferred from project choice and conversation. |

**Why starter project goes first:** It's the one question that changes what happens next. A "data analytics" user should see "drag a file here"; a "personal site" user should be asked about design. Asking it first means the agent can start working immediately.

**Why data/connection goes second:** It's the most actionable follow-up. If someone picks "I have files to upload," the agent can immediately prompt them to drag a CSV. If they pick "Help me connect a service," the agent walks them through connection setup. This turns onboarding into the first productive action — not just preference gathering.

**Why only 2 questions:** Every extra question is another point where users might disengage. Two questions take ~10 seconds. The agent learns everything else through natural conversation. Both questions in a single `AskUserQuestion` tool call means the UI steps through them with "1 of 2" / "Next" / "Submit" automatically — no extra SDK round-trip.

### 8. Profile-writer subagent handles `profile.md`

Currently the server writes `~/.chiridion/profile.md` during `onboarding.complete.ts` via `waitUntil()`. This is being removed.

The agent already has a `PROFILE_WRITER_AGENT` subagent (defined in `sandbox/control-plane.mjs`) that automatically maintains `~/.chiridion/profile.md` based on conversation content. It runs in the background after interactions. When the user answers the two onboarding questions in chat, the profile-writer subagent will naturally pick up their preferences and write them to the profile file.

The system message in section 7 intentionally does NOT instruct the agent to write `profile.md` — doing so would create a race condition with the profile-writer subagent's automatic writes.

### 9. Update `_onboarding.welcome.tsx`

The welcome screen now serves two purposes:
1. **Password non-team users**: Email verification gate before entering chat
2. **Team users**: Team context welcome before entering chat

**Changes to the component:**

- Remove `showOrgSlugStep` logic and the `context.setShowOrgSlugStep` / `STEP_PATHS` navigation (lines 216-218). The "Get Started" button calls `completeOnboarding()` directly for both user types.
- Remove `STEP_PATHS` import — no longer needed.
- Keep both the non-team welcome content ("Welcome to camelAI") and team welcome content ("Welcome to {orgName}"). Non-team users only see this screen when email verification is required.
- Keep the email verification UI (the verification notice, resend button, and `emailVerifiedFromLink` banner).
- The "Get Started" button should be disabled when `emailVerificationRequired && !emailVerified` for non-team users. For team users, it's always enabled.
- Remove the "Let's get you set up. This takes about 30 seconds." copy. Replace with: "Verify your email to get started." (for non-team) or keep the existing team copy.
- The `teamWelcomeOnly` path (line 211) now calls `completeOnboarding()` instead of `skipToChat()`.

**Simplified "Get Started" handler:**

```typescript
onClick={async () => {
  try {
    await context.completeOnboarding();
  } catch (error) {
    // Show error (e.g., email not yet verified)
    setError(error instanceof Error ? error.message : 'Failed to complete onboarding');
  }
}}
```

**Loader changes:**

- Remove `showOrgSlugStep` computation (lines 42-48, 47-48) — slug step is gone.
- Remove `showOrgSlugStep` from the return type.
- Keep `orgName` and `teamContext` for the team welcome variant.

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
  index('routes/_onboarding.welcome.tsx'),   // password-verification + team welcome
]),
route('api/onboarding/complete', 'routes/api/onboarding.complete.ts'),
```

### 12. Update boot modal copy (required)

The existing `onboarding-loading-modal.tsx` boot line at index 2 (`BOOT_LINES[2]`) currently reads:

```typescript
// Before
{
  text: 'Loading onboarding context',
  subtitle: 'Claude already knows what you want to build',
}

// After
{
  text: 'Starting first conversation',
  subtitle: 'Claude will ask a couple questions to get you started',
}
```

This is a required change — the old copy is actively misleading since there are no onboarding preferences loaded. The modal component, timing, and all other boot lines are unchanged.

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

Remove **everything except `hasCompletedOnboarding()`**:

```
ONBOARDING_PROGRESS_STORAGE_KEY_PREFIX
getOnboardingProgressStorageKey()
DEFAULT_ONBOARDING_PREFERENCES
normalizePreferences()
OnboardingStepId
OnboardingTransitionDirection
OnboardingProgressState
OnboardingOption
DesignStyleOption
StarterProjectOption
IntegrationInterestOption
STEP_PATHS
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
normalizeOnboardingInput()  — no preferences to normalize
normalizeSlug()             — slug handling removed
isOwnerForOrg()             — slug handling removed
buildIntegrationNameMap()   — preferences removed
writeOnboardingProfile()    — profile-writer subagent handles this
```

### Dead code in `_onboarding.tsx`
```
shouldRevalidate export     — was for multi-step navigation, no longer needed
mergeAnswers()              — no answers state
readStoredProgress()        — no localStorage persistence
saveOnboarding callback     — used deleted POST /api/onboarding endpoint
All step sequence logic     — sequence, currentStepIndex, totalSteps, etc.
All transition animation    — transitionDirection, previousStepIndexRef
All org slug state          — showOrgSlugStep, pendingOrgSlug
All localStorage effects    — progress persistence, reset handling
```

---

## Files Changed (not deleted)

| File | Change |
|------|--------|
| `src/routes.ts` | Remove 7 route entries |
| `src/routes/_onboarding.tsx` | Replace multi-step layout with three-way routing: auto-complete (OAuth), welcome outlet (password/team) |
| `src/routes/_onboarding.welcome.tsx` | Remove org slug logic; "Get Started" calls `completeOnboarding()` directly; keep both non-team (verification) and team welcome content |
| `src/routes/api/onboarding.complete.ts` | Remove slug, preferences, profile write; no request body; static system message; keep email verification gate |
| `src/lib/onboarding.ts` | Remove everything except `hasCompletedOnboarding()` |
| `src/types.ts` | Remove 6 type aliases, simplify `OnboardingPreferences` to `{ completed_at: number \| null }` |
| `src/components/onboarding-loading-modal.tsx` | Update `BOOT_LINES[2]` copy: "Starting first conversation" / "Claude will ask a couple questions to get you started" |
| `src/components/onboarding/onboarding-layout.tsx` | Remove progress-related props/rendering (progress dots component is deleted) |
| `AGENTS.md` | Update Onboarding section to reflect new flow |

---

## What Stays the Same

- **Auth flow**: Signup, login, email verification sending — unchanged
- **Email verification gate**: Password-based signups still must verify before `onboarding/complete` succeeds. The welcome screen serves as the verification holding area.
- **`_app.tsx` guard**: Still checks `onboarding?.completed_at` and redirects to `/onboarding`
- **Post-onboarding boot modal**: Still plays the ~6s terminal animation. Still triggered via `sessionStorage.setItem('showBootModal', '1')`. Copy update only.
- **Pending message handoff**: Still uses `sessionStorage.setItem('pendingMessage:newThread', ...)` pattern
- **Chat.tsx**: No changes needed — it already consumes the boot modal flag and pending message
- **`clientLoader` in `_app.chat.$id.tsx`**: Still intercepts `?newThread=1` for fast loading
- **`AskUserQuestion` component**: Already supports multi-question payloads with step-by-step progression ("1 of 2" / "Next" / "Submit") — no changes needed
- **Control plane / SDK**: System message passed via existing `pendingMessage` pattern — no changes needed
- **Profile-writer subagent**: Already maintains `~/.chiridion/profile.md` automatically — no changes needed
- **Org slug settings**: Users who want to change their slug later can still do so from org settings (existing feature, unchanged)

---

## Implementation Order

1. **Simplify types** — Update `OnboardingPreferences` in `src/types.ts`, remove dead type aliases
2. **Gut `src/lib/onboarding.ts`** — Remove everything except `hasCompletedOnboarding()`
3. **Simplify `onboarding.complete.ts`** — Remove slug/preferences/profile logic, remove body parsing, add static system message, keep email verification gate
4. **Rewrite `_onboarding.tsx`** — Three-way routing: auto-complete for OAuth, outlet for password-verification/team
5. **Update `_onboarding.welcome.tsx`** — Remove slug logic, "Get Started" calls `completeOnboarding()` directly, update non-team copy for verification context
6. **Delete route files** — Remove Q1-Q6, org-slug routes and their entries in `routes.ts`
7. **Delete dead components** — Remove 7 component files from `src/components/onboarding/`
8. **Delete `api/onboarding.ts`** — Remove mid-flow save endpoint and route entry
9. **Update `onboarding-layout.tsx`** — Remove progress-related props/rendering
10. **Update boot modal copy** — Change `BOOT_LINES[2]` text and subtitle
11. **Update `AGENTS.md`** — Update Onboarding section to document new three-path flow and in-chat question pattern
12. **Run tests** — `bun run test:run` to verify nothing breaks

---

## Not in Scope

- Changes to the `AskUserQuestion` component rendering (`src/components/ask-user-question.tsx`) — already works perfectly for this use case
- Changes to the control plane or SDK — the system message is passed via existing `pendingMessage` pattern
- Changes to `ChatThreadDO` or WebSocket handling
- Org slug settings page — users who want to change their slug later can do so from org settings (existing feature)
- Migration of existing user data — old preferences remain in `UserDO` storage harmlessly
- Removing `OrgSlugDO` or slug-related API routes (`/api/orgs/:id/update-slug`, `/api/orgs/:id/check-slug`) — slug customization is removed from onboarding only, not from the product
