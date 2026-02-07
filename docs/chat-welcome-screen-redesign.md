# Chat Welcome Screen Redesign Plan

This document outlines the design and implementation plan for improving the styling of the new chat page (`/chat`). The goal is to create an engaging, personalized welcome experience that adapts based on user context.

---

## Overview

The welcome screen is the first thing users see when they start a new chat. It should:
1. Feel warm and personalized with dynamic greetings
2. Guide new users with helpful starter prompts
3. Help returning users pick up where they left off with their apps
4. Surface connections (integrations) to inspire what they can build

**Important:** No emojis in the app UI. Use Lucide icons instead.

---

## Conditional Rendering Logic

The welcome screen has **three independent sections** that render based on different conditions:

### Apps Section
| Condition | Section Shown |
|-----------|---------------|
| User has authored apps in workspace | "Pick up where you left off" (user's apps) |
| User has NOT authored apps, but workspace has team apps | "What your team is working on" (team's apps) |

### Starter Prompts Section
| Condition | Section Shown |
|-----------|---------------|
| User has authored apps | Hidden (they know what they're doing) |
| User has NOT authored apps | "Need inspiration? Try one of these" (starter prompts) |

**Note:** Starter prompts show for users without authored apps, even if the workspace has team apps. This helps onboard new team members.

### Connections Section (mutually exclusive)
| Condition | Section Shown |
|-----------|---------------|
| User has configured connections | "Your connected tools" (user's connections) |
| User has no connections | "Connect your tools" (available integrations to add) |

---

## Design Mockups

### New User View (No Apps, No Connections)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│                           Hey, Illiana                                     │
│                    What would you like to build?                           │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Build me a personal portfolio website...█                            │  │
│  │                                                                      │  │
│  │ [+] [mic]                                              [→]           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  Need inspiration? Try one of these                                        │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐          │
│  │ [BarChart3] Feedback form   │  │ [Shield] Internal admin     │          │
│  │ + dashboard                 │  │ panel                       │          │
│  │ Collect responses and see   │  │ View and edit customer      │          │
│  │ live results                │  │ records                     │          │
│  └─────────────────────────────┘  └─────────────────────────────┘          │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐          │
│  │ [Calendar] Booking page     │  │ [Zap] Webhook → Slack       │          │
│  │ Calendar sync + auto        │  │ alerts                      │          │
│  │ confirmations               │  │ Stripe events to messages   │          │
│  └─────────────────────────────┘  └─────────────────────────────┘          │
│                                                                            │
│  Connect your tools                                      View all →        │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐               │
│  │ [stripe] Stripe │ │ [slack] Slack   │ │ [db] Snowflake  │  ...          │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘               │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### Returning User View (Has Authored Apps + Has Connections)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│                         Let's build something                              │
│                    What would you like to build?                           │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Set up a webhook that posts to Slack when...█                        │  │
│  │                                                                      │  │
│  │ [+] [mic]                                              [→]           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  Pick up where you left off                              View all →        │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────┐   │
│  │ ████████████   │ │ ██████████████ │ │ ━━━━━━━━━━━━━  │ │ ▢          │   │
│  │ ████████████   │ │ ██████████████ │ │ ━━━━━━━━━━     │ │            │   │
│  │                │ │                │ │ ━━━━━━━        │ │            │   │
│  │ feedback-dash  │ │ flower-memory  │ │ nps-survey     │ │ stripe-sl  │   │
│  │ • 2h ago       │ │ • 4h ago       │ │ • 1d ago       │ │ • 3d ago   │   │
│  └────────────────┘ └────────────────┘ └────────────────┘ └────────────┘   │
│                                                                            │
│  Your connected tools                                    View all →        │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────┐           │
│  │ [stripe] Stripe │ │ [slack] Slack   │ │ [cal] Google Cal    │           │
│  └─────────────────┘ └─────────────────┘ └─────────────────────┘           │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### Team Member View (No Authored Apps, But Workspace Has Apps)

Shows both starter prompts AND team apps to help onboard new team members.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│                           Hey, Illiana                                     │
│                    What would you like to build?                           │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Create a dashboard that shows...█                                    │  │
│  │                                                                      │  │
│  │ [+] [mic]                                              [→]           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  Need inspiration? Try one of these                                        │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐          │
│  │ [BarChart3] Feedback form   │  │ [Shield] Internal admin     │          │
│  │ + dashboard                 │  │ panel                       │          │
│  │ Collect responses and see   │  │ View and edit customer      │          │
│  │ live results                │  │ records                     │          │
│  └─────────────────────────────┘  └─────────────────────────────┘          │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐          │
│  │ [Calendar] Booking page     │  │ [Zap] Webhook → Slack       │          │
│  │ Calendar sync + auto        │  │ alerts                      │          │
│  │ confirmations               │  │ Stripe events to messages   │          │
│  └─────────────────────────────┘  └─────────────────────────────┘          │
│                                                                            │
│  What your team is working on                            View all →        │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────┐   │
│  │ ████████████   │ │ ██████████████ │ │ ━━━━━━━━━━━━━  │ │ ▢          │   │
│  │ ████████████   │ │ ██████████████ │ │ ━━━━━━━━━━     │ │            │   │
│  │                │ │                │ │ ━━━━━━━        │ │            │   │
│  │ team-dashboard │ │ api-docs       │ │ admin-panel    │ │ metrics    │   │
│  │ • 2h ago       │ │ • 4h ago       │ │ • 1d ago       │ │ • 3d ago   │   │
│  └────────────────┘ └────────────────┘ └────────────────┘ └────────────┘   │
│                                                                            │
│  Connect your tools                                      View all →        │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐               │
│  │ [stripe] Stripe │ │ [slack] Slack   │ │ [db] PostgreSQL │  ...          │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘               │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Feature Requirements

### 1. Dynamic Welcome Greeting

**Requirement:** Randomly cycle through 5-10 different greeting messages on each page load.

**Greetings Array (with name):**
```typescript
const GREETINGS_WITH_NAME = [
  "Hey, {name}",
  "Welcome back, {name}",
  "Good to see you, {name}",
  "Ready to build, {name}?",
  "Let's create something, {name}",
  "What's next, {name}?",
];

const GREETINGS_WITHOUT_NAME = [
  "Let's build something",
  "Ready to create?",
  "What will you build today?",
  "Let's get started",
  "Time to build",
];
```

**Subheader:** Always "What would you like to build?"

**Implementation:**
- Use `useMemo` with an empty dependency array to select a random greeting once on mount
- Check if `user?.name` exists to choose the appropriate array
- Replace `{name}` placeholder with the user's first name (split on space, take first part)

---

### 2. Animated Placeholder Text

**Requirement:** Create a typing animation effect in the input placeholder that cycles through example prompts.

**Typing Animation Prompts:**
```typescript
const PLACEHOLDER_PROMPTS = [
  "Build me a waitlist page that collects emails...",
  "Create an API that processes CSV files...",
  "Make a dashboard to track my metrics...",
  "Set up a webhook that posts to Slack when...",
  "Build a form that saves to my database...",
  "Create a landing page for my product...",
  "Make an internal tool to manage users...",
  "Build a simple CRM for my business...",
];
```

**Animation Behavior:**
1. Character-by-character "typing" effect (no cursor needed)
2. Pause for ~2 seconds when complete
3. "Erase" effect (characters disappear one by one, faster than typing)
4. Pause briefly, then start next prompt
5. Loop infinitely

**Implementation:**
- Create a new `AnimatedPlaceholder` component or modify `PromptInput`
- Use `useState` for current text and `useEffect` with `setInterval` for animation
- Typing speed: ~50ms per character
- Erase speed: ~25ms per character
- Display duration: ~2000ms
- Pass animated text to `PromptInput` via new `animatedPlaceholder` prop
- When user focuses/types, stop animation and use static placeholder or hide

**Note:** Different from `SlotMachinePrompt` which uses character scrambling. This should be a clean typing/erasing effect.

---

### 3. Starter Prompts Section (User Has Not Authored Apps)

**Condition:** Show when the current user has not authored any apps in the workspace. This includes:
- Brand new users with no apps at all
- Team members who joined a workspace with existing apps but haven't created their own yet

**Section Header:** "Need inspiration? Try one of these"

**Starter Prompt Cards (2x2 grid):**
```typescript
const STARTER_PROMPTS = [
  {
    title: "Feedback form + dashboard",
    description: "Collect responses and see live results",
    prompt: "Build me a feedback form with a simple admin dashboard to view all submissions in real-time",
    icon: "BarChart3", // Lucide icon name
  },
  {
    title: "Internal admin panel",
    description: "View and edit customer records",
    prompt: "Create an internal admin panel where I can view, search, and edit customer data",
    icon: "Shield",
  },
  {
    title: "Booking page",
    description: "Calendar sync + auto confirmations",
    prompt: "Build a booking page where visitors can schedule appointments and receive confirmation emails",
    icon: "Calendar",
  },
  {
    title: "Webhook to Slack alerts",
    description: "Stripe events to formatted messages",
    prompt: "Set up a webhook endpoint that receives Stripe events and posts formatted notifications to a Slack channel",
    icon: "Zap",
  },
];
```

**Additional prompt variations (randomly rotate 4 from this pool):**
```typescript
const EXTENDED_PROMPTS = [
  {
    title: "Personal portfolio site",
    description: "Showcase your work beautifully",
    prompt: "Build me a personal portfolio website with sections for my projects, about me, and contact information",
    icon: "User",
  },
  {
    title: "Email newsletter signup",
    description: "Grow your audience",
    prompt: "Create a newsletter signup landing page with email validation and a thank you confirmation",
    icon: "Mail",
  },
  {
    title: "API documentation site",
    description: "Interactive docs for your API",
    prompt: "Build an API documentation page with interactive examples and code snippets",
    icon: "FileCode",
  },
  {
    title: "File upload portal",
    description: "Secure file sharing",
    prompt: "Create a secure file upload portal where users can submit documents",
    icon: "Upload",
  },
];
```

**Interaction:**
- Clicking a card populates the input field with the full prompt
- Cards should have subtle hover effect (lift + shadow)
- Use Lucide icons (no emojis)

---

### 4. Pick Up Where You Left Off (User Has Authored Apps)

**Condition:** Show when current user has authored 1+ apps in the workspace.

**Section Layout:**
- Header row: "Pick up where you left off" (left) + "View all →" link (right, links to `/apps`)
- Horizontal row of max 4 app cards
- Only shows apps where `created_by === currentUser.id`

**App Card Design (Slim version):**
```
┌────────────────────┐
│ ████████████████   │  ← App preview image (aspect-video, smaller)
│ ████████████████   │
│                    │
│ feedback-dashboard │  ← App name (truncated)
│ • 2h ago           │  ← Last updated (green dot + relative time)
└────────────────────┘
```

**Data Filtering:**
```typescript
const userAuthoredApps = allWorkspaceApps
  .filter(app => app.created_by === currentUser.id)
  .sort((a, b) => b.updated_at - a.updated_at)
  .slice(0, 4);
```

**Interaction:**
- Clicking an app card triggers same behavior as "Chat" button on `/apps` page
- "View all →" navigates to `/apps`

---

### 5. What Your Team Is Working On (User Has No Apps, But Workspace Has Apps)

**Condition:** Show when:
- Current user has authored 0 apps in the workspace
- BUT workspace has 1+ apps from other team members

**Section Layout:**
- Header row: "What your team is working on" (left) + "View all →" link (right, links to `/apps`)
- Horizontal row of max 4 app cards
- Shows apps from any author in the workspace

**Data Filtering:**
```typescript
const teamApps = allWorkspaceApps
  .filter(app => app.created_by !== currentUser.id) // Apps by others
  .sort((a, b) => b.updated_at - a.updated_at)
  .slice(0, 4);
```

**Interaction:**
- Clicking an app card triggers same behavior as "Chat" button on `/apps` page
- "View all →" navigates to `/apps`

---

### 6. Your Connected Tools (User Has Connections)

**Condition:** Show when user has 1+ connections in the workspace.

**Section Layout:**
- Header row: "Your connected tools" (left) + "View all →" link (right, links to `/connections`)
- Row of buttons showing user's actual configured connections
- Inline format: `[icon] Connection Name`

**Button Design (inline icon + name):**
```
┌───────────────────┐
│ [stripe] Stripe   │
└───────────────────┘
```

**Interaction:**
- Clicking a connection populates: `"Use my {connection name} connection to create "`
- "View all →" link navigates to `/connections`

---

### 7. Connect Your Tools (User Has No Connections)

**Condition:** Show when user has 0 connections in the workspace.

**Section Layout:**
- Header row: "Connect your tools" (left) + "View all →" link (right, links to `/connections`)
- Row of 5-6 integration suggestion buttons
- Inline format: `[icon] Integration Name`

**Button Design (inline icon + name):**
```
┌───────────────────┐
│ [stripe] Stripe   │
└───────────────────┘
```

**Featured Integrations:**
```typescript
const FEATURED_INTEGRATIONS = [
  { type: 'stripe', displayName: 'Stripe' },
  { type: 'slack', displayName: 'Slack' },
  { type: 'notion', displayName: 'Notion' },
  { type: 'hubspot', displayName: 'HubSpot' },
  { type: 'github', displayName: 'GitHub' },
  { type: 'airtable', displayName: 'Airtable' },
  { type: 'postgres', displayName: 'PostgreSQL' },
  { type: 'openai', displayName: 'OpenAI' },
];
```

**Interaction:**
- Clicking an integration button populates input: `"Let's connect {integration name}"`
- "View all →" link navigates to `/connections`

**Integration Icons:**
- Use existing `IntegrationIcon` component from `src/lib/integration-icons.tsx`
- SVG logos are stored in `public/logos/` with light/dark theme support
- Falls back to `Settings` icon for unknown integration types

---

## Data Loading Changes

### Modified Chat Index Loader

```typescript
// src/routes/_app.chat._index.tsx

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const hostname = request.headers.get('host')?.split(':')[0] || undefined;

  const workspaceId = authContext.currentWorkspace?.id;
  const userId = authContext.user?.id;

  // Load ALL apps for current workspace (we'll filter client-side for user vs team)
  let allApps: WorkerScriptWithCreator[] = [];
  if (workspaceId && authContext.currentOrg?.id) {
    const orgStub = env.ORG.get(env.ORG.idFromName(authContext.currentOrg.id));
    const scripts = await orgStub.listWorkerScripts();
    allApps = scripts
      .filter(s => s.workspace_id === workspaceId)
      .sort((a, b) => b.updated_at - a.updated_at);
    // Note: We load all apps, not just 4, because we need to check
    // if user has authored any vs just team apps existing
  }

  // Load connections for current workspace
  let connections: Integration[] = [];
  if (workspaceId) {
    const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
    const records = await wsStub.getIntegrations();
    connections = records.map(recordToIntegration);
  }

  return {
    workspaceId,
    hostname,
    userId,
    userName: authContext.user?.name ?? null,
    allApps,         // All workspace apps (for filtering user vs team)
    connections,     // User's configured connections
    renderedAt: Date.now(),
  };
}
```

### Client-Side Conditional Logic

```typescript
// In WelcomeScreen component

// Separate user-authored apps from team apps
const userApps = allApps.filter(app => app.created_by === userId);
const teamApps = allApps.filter(app => app.created_by !== userId);

// Boolean flags for conditional rendering
const hasUserApps = userApps.length > 0;
const hasTeamApps = teamApps.length > 0;
const hasConnections = connections.length > 0;

// What to show:

// 1. Apps Section
//    - Show "Pick up where you left off" if user has authored apps
//    - Show "What your team is working on" if user has NO authored apps but team has apps
//    - Show neither if workspace has no apps at all
const showUserAppsSection = hasUserApps;
const showTeamAppsSection = !hasUserApps && hasTeamApps;
const userAppsToDisplay = userApps.slice(0, 4);
const teamAppsToDisplay = teamApps.slice(0, 4);

// 2. Starter Prompts Section
//    - Show if user has NOT authored any apps (even if team has apps)
const showStarterPrompts = !hasUserApps;

// 3. Connections Section (always show one or the other)
//    - "Your connected tools" if user has connections
//    - "Connect your tools" if user has no connections
const showYourConnections = hasConnections;
const showConnectSuggestions = !hasConnections;
```

---

## Component Architecture

### New Components

```
src/components/
├── welcome-screen/
│   ├── index.tsx                    # Main WelcomeScreen component
│   ├── welcome-greeting.tsx         # Dynamic greeting header
│   ├── animated-placeholder.tsx     # Typing animation for placeholder
│   ├── section-header.tsx           # Reusable "Title" + "View all →" header
│   ├── starter-prompts.tsx          # Grid of starter prompt cards
│   ├── integration-buttons.tsx      # Integration suggestion buttons (no connections)
│   ├── connected-tools.tsx          # User's actual connections
│   ├── app-cards-row.tsx            # Horizontal row of slim app cards
│   └── slim-app-card.tsx            # Individual slim app card
```

**Note:** Use existing `IntegrationIcon` component from `src/lib/integration-icons.tsx` for integration logos. It already supports light/dark theme variants.

### Component Props

```typescript
// welcome-screen/index.tsx
interface WelcomeScreenProps {
  userId: string;
  userName: string | null;
  allApps: WorkerScriptWithCreator[];
  connections: Integration[];
  hostname?: string;
  renderedAt: number;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  onStartChatForApp: (app: WorkerScriptWithCreator) => void;
  // PromptInput props
  inputValue: string;
  attachments: Attachment[];
  onFilesSelected: (files: File[]) => void;
  onAttachmentRemove: (id: string) => void;
  isCreatingThread: boolean;
}

// section-header.tsx
interface SectionHeaderProps {
  title: string;
  linkText?: string;  // e.g., "View all"
  linkHref?: string;  // e.g., "/apps" or "/connections"
}

// app-cards-row.tsx
interface AppCardsRowProps {
  apps: WorkerScriptWithCreator[];
  hostname?: string;
  renderedAt: number;
  onStartChat: (app: WorkerScriptWithCreator) => void;
}
```

---

## Styling Details

### Welcome Greeting

```tsx
// Greeting style
<div className="text-center mb-8">
  <h1 className="text-3xl md:text-4xl font-serif italic text-foreground mb-2">
    {greeting}
  </h1>
  <p className="text-muted-foreground text-lg">
    What would you like to build?
  </p>
</div>
```

**Typography:**
- Main greeting: `text-3xl md:text-4xl font-serif italic` (matches screenshot aesthetic)
- Subheader: `text-lg text-muted-foreground`

### Starter Prompt Card

```tsx
<button
  onClick={() => onSelect(prompt)}
  className={cn(
    "group relative flex flex-col gap-2 p-4 rounded-xl",
    "border border-border bg-card hover:bg-accent/50",
    "text-left transition-all duration-200",
    "hover:shadow-md hover:-translate-y-0.5"
  )}
>
  <div className="flex items-center gap-2">
    <Icon className="size-5 text-muted-foreground group-hover:text-foreground" />
    <span className="font-semibold text-foreground">{title}</span>
  </div>
  <p className="text-sm text-muted-foreground">{description}</p>
</button>
```

### Integration Button (Inline Icon + Name)

```tsx
import { IntegrationIcon } from '@/lib/integration-icons';

<button
  onClick={() => onSelect(integration)}
  className={cn(
    "inline-flex items-center gap-2 px-4 py-2.5 rounded-lg",
    "border border-border bg-card hover:bg-accent/50",
    "transition-all duration-200 text-sm"
  )}
>
  <IntegrationIcon type={integration.type} size={16} />
  <span className="text-foreground">{integration.displayName}</span>
</button>
```

**Existing Integration Icons:**
The codebase already has an `IntegrationIcon` component at `src/lib/integration-icons.tsx` that:
- Uses SVG files from `public/logos/`
- Supports light/dark theme variants (e.g., `github_light.svg`, `github_dark.svg`)
- Falls back to a `Settings` icon for unknown types

**Available logos (from `logoRegistry`):**
- **Themed** (light/dark variants): anthropic, aws, github, mysql, openai
- **Single** (works for both themes): airtable, bigquery, hubspot, linear, notion, postgres, salesforce, sendgrid, slack, stripe, twilio

### Slim App Card

```tsx
<button
  onClick={() => onStartChat(app)}
  className={cn(
    "group flex flex-col overflow-hidden rounded-xl",
    "border border-border bg-card",
    "hover:shadow-md transition-all duration-200",
    "w-[180px] shrink-0" // Fixed width for carousel
  )}
>
  {/* Preview Image */}
  <div className="relative aspect-video bg-gradient-to-br from-muted/60 to-muted overflow-hidden">
    {previewUrl ? (
      <img
        src={previewUrl}
        alt={app.script_name}
        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
      />
    ) : (
      <div className="flex items-center justify-center h-full">
        <Image className="size-6 text-muted-foreground/40" />
      </div>
    )}
  </div>

  {/* Info */}
  <div className="p-3">
    <p className="font-medium text-sm truncate">{app.script_name}</p>
    <div className="flex items-center gap-1.5 mt-1">
      <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
      <span className="text-xs text-muted-foreground">
        {getRelativeTime(app.updated_at)}
      </span>
    </div>
  </div>
</button>
```

---

## Integration with Chat.tsx

The welcome screen will replace the current simple welcome UI in `Chat.tsx` (lines 2051-2088).

### Key Changes to Chat.tsx

1. **Import WelcomeScreen component**
2. **Pass apps and connections from loader** (need to update loader)
3. **Handle `onStartChatForApp`** - reuse logic from apps page action
4. **Keep existing `startNewChat` function** for regular prompt submission

```tsx
// In Chat.tsx, replace the welcome screen section:

{!shouldShowChat && (
  <WelcomeScreen
    userName={user?.name ?? null}
    apps={apps}
    connections={connections}
    hostname={hostname}
    renderedAt={renderedAt}
    inputValue={welcomeInput}
    onPromptChange={setWelcomeInput}
    onSubmit={startNewChat}
    onStartChatForApp={handleStartChatForApp}
    attachments={attachments}
    onFilesSelected={handleFilesSelected}
    onAttachmentRemove={handleAttachmentRemove}
    isCreatingThread={isCreatingThread}
  />
)}
```

---

## Animation Specifications

### Animated Placeholder

```typescript
const TYPING_SPEED = 50;      // ms per character when typing
const ERASE_SPEED = 25;       // ms per character when erasing
const DISPLAY_DURATION = 2000; // ms to show complete prompt
const PAUSE_BETWEEN = 500;    // ms pause after erase before next prompt

// Animation states: 'typing' | 'displaying' | 'erasing' | 'paused'
```

### Integration Button Rotation (optional enhancement)

If we want to cycle through more integrations than fit:
- Show 6 at a time
- Fade out one, fade in replacement every 3 seconds
- Stagger the transitions so it feels organic

---

## Testing Checklist

### Visual
- [ ] Greeting displays correctly with user's name
- [ ] Greeting displays correctly without user name
- [ ] Animated placeholder types and erases smoothly
- [ ] Animation stops when user focuses input
- [ ] Starter prompts render in 2x2 grid with Lucide icons (no emojis)
- [ ] Integration buttons render with inline SVG logo + name format
- [ ] Integration logos switch correctly between light/dark themes
- [ ] App cards show preview images correctly
- [ ] Responsive layout works on mobile
- [ ] "View all" links are positioned in section headers

### Behavior
- [ ] Clicking starter prompt populates input
- [ ] Clicking integration button populates input with connection prompt
- [ ] Clicking existing connection populates input with "Use my X connection to create "
- [ ] "View all →" in apps section navigates to /apps
- [ ] "View all →" in connections section navigates to /connections
- [ ] Clicking app card starts chat with app context
- [ ] Submit works with pre-filled prompts

### Conditional Rendering - Apps Section
- [ ] User with authored apps sees "Pick up where you left off" (max 4 of their apps)
- [ ] User without authored apps but workspace has apps sees "What your team is working on"
- [ ] User without authored apps but workspace has apps ALSO sees starter prompts
- [ ] Workspace with no apps at all shows only starter prompts

### Conditional Rendering - Connections Section
- [ ] User with connections sees "Your connected tools"
- [ ] User without connections sees "Connect your tools" with suggestions

---

## Implementation Phases

### Phase 1: Data Loading
1. Update `_app.chat._index.tsx` loader to fetch apps and connections
2. Pass new data to Chat component

### Phase 2: Core Components
1. Create `welcome-screen/` component directory
2. Implement `WelcomeGreeting` with random greetings
3. Implement `AnimatedPlaceholder` with typing effect
4. Integrate into Chat.tsx welcome section

### Phase 3: New User Experience
1. Implement `StarterPrompts` component with card grid
2. Implement `IntegrationButtons` component
3. Wire up click handlers to populate input

### Phase 4: Returning User Experience
1. Implement `RecentAppsCarousel` component
2. Implement `ConnectedTools` component
3. Wire up app card click to start chat action
4. Handle `startChatForApp` in chat index (copy from apps page)

### Phase 5: Polish
1. Add hover animations and transitions
2. Test responsive layout
3. Verify conditional rendering logic
4. Final visual polish

---

## Summary

This redesign transforms the chat welcome screen from a simple "Welcome to Chiridion" message into a dynamic, personalized experience that:

1. **Greets users warmly** with rotating, personalized messages
2. **Inspires action** with animated placeholder prompts that type/erase
3. **Guides users without apps** with curated starter prompts (even if their team has apps)
4. **Helps authors pick up** where they left off with their own recent apps
5. **Shows team activity** to new team members via "What your team is working on"
6. **Surfaces existing connections** to remind users what they can build with
7. **Suggests new connections** for users who haven't configured any yet

### Key Design Decisions

- **Inline icon format** for integration buttons: `[logo] Stripe`
- **No emojis** - use Lucide icons for UI, existing SVG logos for integrations
- **Existing `IntegrationIcon` component** - reuse from `src/lib/integration-icons.tsx` with light/dark theme support
- **Max 4 apps** shown with "View all →" link to `/apps`
- **Decoupled sections** - apps/prompts and connections logic are independent
- **Starter prompts persist** for users without authored apps, even if workspace has team apps

The implementation is modular, with each feature in its own component for easy maintenance and testing.
