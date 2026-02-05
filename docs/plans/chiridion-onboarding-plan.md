# Onboarding Flow Implementation Plan

This document outlines the implementation plan for a new user onboarding flow that collects preferences to personalize the first chat experience.

---

## Problem Statement

Users migrating from our previous AI data analyst product are confused. They don't understand what Chiridion is or how to use it. The old product onboarded by setting up one connection, then showing "your data is connected. Ask a question."

Chiridion is much more capable, but new users (especially non-AI-experts) need guidance on what's possible and how to get started.

**Goal:** Collect lightweight preferences during onboarding so Claude can personalize the first conversation—opening with something specific ("drop in your CSV") rather than a blank page or generic "what do you want to build?"

---

## User Flow Overview

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Signup     │────▶│   Welcome    │────▶│  Org Slug    │────▶│  Q1: AI      │
│   Form       │     │   Screen     │     │ (conditional)│     │  Familiarity │
└──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                           Only shown if:             │
                                           - User is org owner   ┌────┼────────────────────────────┐
                                           - Org is brand new    │    │                            │
                                           - No published apps   ▼    ▼                            │
                                                          "Yes, extensively"  All other answers     │
                                                                 │         │                       │
                                                                 │         ▼                       │
                                                                 │  ┌──────────────┐               │
                                                                 │  │ Q2: Iteration│               │
                                                                 │  │    Style     │               │
                                                                 │  └──────┬───────┘               │
                                                                 │         │                       │
                                                                 │         ▼                       │
                                                                 │  ┌──────────────┐               │
                                                                 │  │  Q3: Stakes  │               │
                                                                 │  │  + Audience  │               │
                                                                 │  └──────┬───────┘               │
                                                                 │         │                       │
                                                                 ▼         ▼                       │
                                                          ┌──────────────────────┐                 │
                                                          │   Q4: Design Style   │                 │
                                                          └──────────┬───────────┘                 │
                                                                     │                             │
                                                          ┌──────────┴───────────┐                 │
                                                          │ (full path only)     │                 │
                                                          ▼                      │                 │
                                                   ┌──────────────┐              │                 │
                                                   │  Q5: Starter │              │                 │
                                                   │   Project    │              │                 │
                                                   └──────┬───────┘              │                 │
                                                          │                      │                 │
                                                          ▼                      ▼                 │
                                                   ┌──────────────────────┐                        │
                                                   │  Q6: Data &          │                        │
                                                   │  Integrations        │                        │
                                                   └──────────┬───────────┘                        │
                                                              │                                    │
                                                              ▼                                    │
                                                       ┌──────────────┐                            │
                                                       │    Chat      │◀───────────────────────────┘
                                                       │ (with hello) │
                                                       └──────────────┘
```

**Branching logic:**
- **Org Slug step:** Only shown to users who are the owner of a brand-new org with zero published apps and one member (themselves). Skipped for users joining an existing org via invitation.
- **Q1 branching:** Users who answer "Yes, extensively" skip Q2, Q3, and Q5. Everyone goes through Q4 (Design) and Q6 (Data & Integrations).

---

## Screen Designs

### Welcome Screen (Post-Signup)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                           [Logo]                                │
│                                                                 │
│                    Welcome to Chiridion                         │
│                                                                 │
│     Chiridion is your AI software engineer. Claude has a        │
│     permanent computer here—it can build, deploy, and           │
│     maintain web applications for you.                          │
│                                                                 │
│     Let's get you set up. This takes about 30 seconds.          │
│                                                                 │
│                                                                 │
│                      [ Get Started ]                            │
│                                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Team variant** (when joining existing org via invitation):
```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                           [Logo]                                │
│                                                                 │
│                  Welcome to Acme Corp                           │
│                                                                 │
│     You're joining a team that's already building.              │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  3 apps deployed  •  Connected to Stripe, Slack     │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     Let's learn a bit about you so Claude can help.             │
│                                                                 │
│                      [ Get Started ]                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Org Slug (Conditional — New Org Owners Only)

This screen lets the user customize their organization's URL slug before any apps are published. It only appears when all of these conditions are true:
- User is the **owner** of their current org
- The org has **one member** (just them — it's brand new)
- The org has **zero published apps** (no deployed workers)

When these conditions aren't met (e.g., user joined via invitation, or org already has apps), this step is silently skipped.

**Why here (between Welcome and Q1)?** The slug is about org identity and setup, not personal preferences. Placing it immediately after "Welcome" frames it as "set up your space" before we move into "tell us about you." It also ensures the slug is chosen before any app could be deployed.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  [←]                                               [Skip ─►]   │
│                                                                 │
│                                                                 │
│                Choose your app URL                              │
│                                                                 │
│     Every app you publish gets a URL like:                      │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │                                                     │     │
│     │       my-app──┐           ┌──.chiridion.app         │     │
│     │               ▼           ▼                         │     │
│     │     https://my-app--your-slug.chiridion.app         │     │
│     │                          ▲                          │     │
│     │                     ┌────┘                          │     │
│     │                  your slug                          │     │
│     │                                                     │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │                                                     │     │
│     │   ┌───────────────────────────────────┐    ✓        │     │
│     │   │ acme-corp                         │  Available  │     │
│     │   └───────────────────────────────────┘             │     │
│     │                                                     │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  URL preview:                                       │     │
│     │  https://my-app──acme-corp.chiridion.app            │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     This can't be changed later.                                │
│                                                                 │
│                                                                 │
│                        [ Continue ]                              │
│                                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Availability states (inline, to the right of the input):**

```
Available:        ✓ Available          (green check + green text)
Taken:            ✕ Already taken      (red X + red text)
Checking:         ⟳ Checking...        (spinner + muted text)
Invalid format:   ✕ Letters, numbers,  (red X + red text)
                    and hyphens only
Too short:        ✕ At least 3         (red X + red text)
                    characters
```

**Behavior:**
- Pre-filled with the auto-generated slug from org creation (format: `{name}-{id-prefix}`, e.g. `acme-corp-85b`)
- User can edit it freely
- Availability check fires on each keystroke, **debounced** (e.g., 300ms)
- While debounce timer is pending or check is in flight, show the "Checking..." spinner state
- "Continue" button is **disabled** until the slug is confirmed available
- Slug validation rules: lowercase alphanumeric + hyphens, 3–24 chars, no leading/trailing hyphens
- **URL preview** below the input updates live as they type, showing `https://my-app--{their-slug}.chiridion.app`
- "Skip" keeps the auto-generated slug (no change needed)
- The warning "This can't be changed later." is shown in muted text below the input area

**Implementation details (codebase-audited):**

1. **Current behavior to preserve**
   - Slug is generated in `workers/main/src/auth.ts` via `generateOrgSlug(name, id.slice(0, 3))`, then persisted in `OrgDO.createOrg()`.
   - Slug is used in deployed app hostnames as `{scriptName}--{orgSlug}` (for example, `my-app--acme-85b.chiridion.app`), which is wired through dispatcher parsing and deploy proxy rewrite logic.
   - “Published app exists” should use OrgDO worker scripts (`listWorkerScripts()`); a new deployment is recorded by `registerWorkerScript()` and should lock slug changes.
   - Canonical script naming order is **`{script}--{orgSlug}`**; if any comments mention the reverse order, treat those comments as stale.

2. **Where this onboarding question goes + exact copy**
   - Keep this step at `/onboarding/org-slug`, immediately after Welcome and before Q1.
   - Recommended screen copy:
     - Title: `Choose your app URL`
     - Body: `Every app you publish uses this format: https://my-app--your-slug.chiridion.app`
     - Field label: `Organization slug`
     - Helper/warning: `This can only be changed now, before your first app is published.`
     - CTA: `Continue`
     - Secondary: `Skip`
   - URL preview line should render live as: `https://my-app--{slug}.{getVanityDomain(host)}`

3. **Slug uniqueness strategy (resolved)**
   - Use a **Durable Object slug registry** (not KV) for race-safe uniqueness.
   - Reason: KV is eventually consistent and can double-allocate during concurrent claims; slug ownership is a hard uniqueness constraint.
   - Implementation shape:
     - Add new DO class (for example `OrgSlugDO`) keyed by slug name (`idFromName(slug)`).
     - Methods: `getOwner()`, `claim(orgId)`, `release(orgId)`.
     - Add binding + migration in `wrangler.jsonc`, export in `workers/main/src/index.ts`, add env types in worker/frontend env interfaces.

4. **New API endpoint: `POST /api/orgs/:id/check-slug`**
   - File: `src/routes/api/orgs.$id.check-slug.ts` (+ route entry in `src/routes.ts`).
   - Input: `{ slug: string }`.
   - Validation:
     - Normalize to lowercase trimmed slug.
     - Format regex: `/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/`.
   - Auth/authorization:
     - Require auth.
     - Require `params.id === authContext.currentOrg.id`.
     - Require current user role is `owner` for that org.
   - Availability check:
     - If slug equals current org slug, return available.
     - Otherwise query slug-registry DO ownership.
   - Response: `{ available: boolean, reason?: 'invalid_format' | 'taken' | 'not_owner' }`.
   - Called from UI on 300ms debounce while typing.

5. **New API endpoint: `POST /api/orgs/:id/update-slug`**
   - File: `src/routes/api/orgs.$id.update-slug.ts` (+ route entry in `src/routes.ts`).
   - Input: `{ slug: string }`.
   - Auth/authorization:
     - Require auth, same-org path check, owner role.
   - Calls `OrgDO.updateSlug(newSlug, actorId)` (new method).
   - Returns updated org (or `{ success: true, slug }` minimal payload).
   - Error mapping:
     - `400` invalid format.
     - `403` not owner / not eligible.
     - `409` slug taken or slug already finalized.

6. **OrgDO changes (`workers/main/src/auth.ts`)**
   - Add `updateSlug(newSlug: string, actorId: string)` that:
     - Validates slug format.
     - Verifies actor is owner (`isOwner(actorId)`).
     - Verifies org is still “brand new enough”:
       - `getMemberCount() === 1`
       - `listWorkerScripts().length === 0`
     - Enforces one-time change by rejecting if an audit log entry with action `slug_changed` already exists.
     - Claims new slug in slug-registry DO before writing org info.
     - Updates `Organization.slug` via `setInfo()`.
     - Logs audit event `slug_changed` with `{ previous_slug, new_slug }`.
     - Releases previous slug claim after successful update.
   - Update `createOrg()` to claim the auto-generated slug in registry at creation time.
     - If collision occurs, retry with a longer ID suffix variant before failing.

7. **Onboarding loader condition + UI behavior**
   - `_onboarding.tsx` loader should compute `showOrgSlugStep` from:
     - Current user role in `authContext.orgs` for `currentOrg.id` is `owner`.
     - `orgStub.getMemberCount() === 1`.
     - `orgStub.listWorkerScripts().length === 0`.
   - Pass `currentOrg.slug` and `showOrgSlugStep` to onboarding routes.
   - `slug-input.tsx` behavior:
     - Debounced check (300ms) via `useFetcher`.
     - State machine: `idle`, `checking`, `available`, `taken`, `invalid`.
     - Continue disabled until status is `available` or unchanged current slug.
     - Skip keeps current slug unchanged and advances.

---

### Q1: AI Coding Familiarity (Everyone)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  [←]                                               [Skip ─►]    │
│                                                                 │
│                                                                 │
│              Have you built things with AI before?              │
│                                                                 │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  Yes, extensively                                │     │
│     │     I use Claude Code, Cursor, Copilot regularly    │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  Yes, occasionally                               │     │
│     │     I've vibe-coded a few things                    │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  A little                                        │     │
│     │     I've chatted with AI but haven't built much     │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  This is new to me                               │     │
│     │     First time trying something like this           │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│                                                                 │
│                         ● ○ ○ ○ ○ ○                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Clicking an option auto-advances to next screen
- "Yes, extensively" → Skip to Q4
- All others → Continue to Q2

---

### Q2: Iteration Style (Full Path Only)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  [←]                                               [Skip ─►]    │
│                                                                 │
│                                                                 │
│          When we're building together, what feels better?       │
│                                                                 │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  Show me something quick                         │     │
│     │     I'll react and we'll iterate from there         │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  Ask me questions first                          │     │
│     │     I want to make sure we're aligned before you    │     │
│     │     build                                           │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  Depends on the project                          │     │
│     │     I'll tell you each time                         │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│                                                                 │
│                         ● ● ○ ○ ○ ○                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Q3: Stakes + Audience (Full Path Only)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  [←]                                               [Skip ─►]    │
│                                                                 │
│                                                                 │
│              What are you hoping to build first?                │
│                                                                 │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  Something quick to try this out                 │     │
│     │     Just experimenting, no pressure                 │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  A tool for myself                               │     │
│     │     Should work reliably, but just for me           │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  Something for my team                           │     │
│     │     Others on my team will use this                 │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  Something for customers / the public            │     │
│     │     Needs to handle real users                      │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  ○  Something I could charge for                    │     │
│     │     Production-grade, polished                      │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│                         ● ● ● ○ ○ ○                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Q4: Design Style (Everyone)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  [←]                                               [Skip ─►]    │
│                                                                 │
│                                                                 │
│                  What vibe do you usually like?                 │
│                                                                 │
│          You can always ask Claude to try a different           │
│                      style in chat later.                       │
│                                                                 │
│                                                                 │
│     ┌───────────────┐  ┌───────────────┐  ┌───────────────┐     │
│     │███████████████│  │███████████████│  │███████████████│     │
│     │███████████████│  │███████████████│  │███████████████│     │
│     │███████████████│  │███████████████│  │███████████████│     │
│     │███████████████│  │███████████████│  │███████████████│     │
│     │███████████████│  │███████████████│  │███████████████│     │
│     │┌─────────────┐│  │┌─────────────┐│  │┌─────────────┐│     │
│     ││ Colorful &  ││  ││  Sleek &    ││  ││ Minimal &   ││     │
│     ││  Playful    ││  ││  Modern     ││  ││   Clean     ││     │
│     │└─────────────┘│  │└─────────────┘│  │└─────────────┘│     │
│     └───────────────┘  └───────────────┘  └───────────────┘     │
│                                                                 │
│     ┌───────────────┐  ┌───────────────┐  ┌───────────────┐     │
│     │███████████████│  │███████████████│  │               │     │
│     │███████████████│  │███████████████│  │               │     │
│     │███████████████│  │███████████████│  │   I'll tell   │     │
│     │███████████████│  │███████████████│  │   you each    │     │
│     │███████████████│  │███████████████│  │     time      │     │
│     │┌─────────────┐│  │┌─────────────┐│  │               │     │
│     ││   Warm &    ││  ││   Bold &    ││  │               │     │
│     ││  Friendly   ││  ││  Dramatic   ││  │               │     │
│     │└─────────────┘│  │└─────────────┘│  │               │     │
│     └───────────────┘  └───────────────┘  └───────────────┘     │
│                                                                 │
│                         ● ● ● ● ○ ○                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Card layout:** Full-bleed preview image with label overlay at bottom (gradient fade).

**Preview images (AVIF format, ~47KB total):**

| Style | File | Size |
|-------|------|------|
| Colorful & Playful | `/images/onboarding/ob-preview-colorful-and-playful.avif` | 10KB |
| Sleek & Modern | `/images/onboarding/ob-preview-sleek-and-modern.avif` | 11KB |
| Minimal & Clean | `/images/onboarding/ob-preview-minimal-and-clean.avif` | 7KB |
| Warm & Friendly | `/images/onboarding/ob-preview-warm-and-friendly.avif` | 12KB |
| Bold & Dramatic | `/images/onboarding/ob-preview-bold-and-dramatic.avif` | 8KB |

**Implementation:**
```tsx
const DESIGN_STYLES = [
  { id: 'colorful', label: 'Colorful & Playful', image: '/images/onboarding/ob-preview-colorful-and-playful.avif' },
  { id: 'sleek', label: 'Sleek & Modern', image: '/images/onboarding/ob-preview-sleek-and-modern.avif' },
  { id: 'minimal', label: 'Minimal & Clean', image: '/images/onboarding/ob-preview-minimal-and-clean.avif' },
  { id: 'warm', label: 'Warm & Friendly', image: '/images/onboarding/ob-preview-warm-and-friendly.avif' },
  { id: 'bold', label: 'Bold & Dramatic', image: '/images/onboarding/ob-preview-bold-and-dramatic.avif' },
  { id: 'per_project', label: "I'll tell you each time", image: null },
];

// Card component
<button className="relative overflow-hidden rounded-xl border aspect-[4/3]">
  <img src={style.image} className="absolute inset-0 w-full h-full object-cover" />
  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-3">
    <span className="text-white font-medium text-sm">{style.label}</span>
  </div>
</button>
```

---

### Q5: Starter Project (Full Path Only)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  [←]                                               [Skip ─►]    │
│                                                                 │
│                                                                 │
│                 What do you want to build first?                │
│                                                                 │
│               Pick a starter project to get going               │
│                                                                 │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  [📊]  Data analytics                               │     │
│     │        Turn spreadsheets and data into insights     │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  [🌐]  Personal site                                │     │
│     │        Your corner of the internet                  │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  [🛠️]  Business tool                                │     │
│     │        Internal tools, dashboards, admin panels     │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  [👥]  Team productivity                            │     │
│     │        Help your team work better together          │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─────────────────────────────────────────────────────┐     │
│     │  [🎮]  Something fun                                │     │
│     │        Games, experiments, creative projects        │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│                                                                 │
│              I have something else in mind [Skip]               │
│                                                                 │
│                         ● ● ● ● ● ○                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Starter project options map to Claude's first message behavior:**

| Selection | Claude's opener strategy |
|-----------|-------------------------|
| Data analytics | Invite them to drag-and-drop a CSV/Excel file |
| Personal site | Ask about their vibe and what they want to showcase |
| Business tool | Ask what workflow is painful or what data they need to manage |
| Team productivity | Ask about their team's current workflow |
| Something fun | Jump right into building something playful |
| Skip | Ask what they're thinking about |

---

### Q6: Data Sources & Integrations (Everyone, Last Question)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  [←]                                               [Skip ─►]    │
│                                                                 │
│                                                                 │
│             What data or tools do you want to use?              │
│                                                                 │
│         Select all that apply. We'll set them up later.         │
│                                                                 │
│                                                                 │
│     ┌─ FILES (drag & drop into chat) ─────────────────────┐     │
│     │                                                     │     │
│     │   [CSV]     [Excel]    [SQLite]   [JSON]            │     │
│     │                                                     │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│     ┌─ CONNECTIONS (live API access) ─────────────────────┐     │
│     │                                                     │     │
│     │   [Stripe]  [Slack]   [Notion]   [GitHub]           │     │
│     │                                                     │     │
│     │   [Google   [Airtable] [Linear]  [+12 more]         │     │
│     │    Sheets]                                          │     │
│     │                                                     │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
│                                                                 │
│                  I'll figure this out later [Skip]              │
│                                                                 │
│                         ● ● ● ● ● ●                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key distinction:**
- **Files section** — These are drag-and-drop into chat, no connector needed. Selecting these tells Claude they want to work with local data files.
- **Connections section** — These are live API integrations. Selecting these signals interest but doesn't set them up yet.

---

## Data Model

### Onboarding Preferences Type

Add to `src/types.ts`:

```typescript
export interface OnboardingPreferences {
  ai_familiarity: 'extensive' | 'occasional' | 'a_little' | 'new' | null;
  iteration_style: 'show_quick' | 'ask_first' | 'depends' | null;
  stakes: 'trying_out' | 'for_myself' | 'for_team' | 'for_public' | 'for_money' | null;
  design_style: 'colorful' | 'sleek' | 'minimal' | 'warm' | 'bold' | 'per_project' | null;
  starter_project: 'data_analytics' | 'personal_site' | 'business_tool' | 'team_productivity' | 'something_fun' | null;
  data_interests: {
    files: ('csv' | 'excel' | 'sqlite' | 'json')[];
    integrations: string[]; // integration template IDs
  };
  completed_at: number | null;
}
```

### Storage Locations

**1. UserDO (permanent preferences)**

Add to `workers/main/src/auth.ts` — requires migration to schema version 7:

```typescript
interface UserProfile {
  // ... existing fields
  onboarding?: OnboardingPreferences;
}
```

**2. User profile file (Claude's persistent memory)**

Written to `~/.chiridion/profile.md` on first chat:

```markdown
## Preferences
- AI familiarity: Occasional
- Iteration style: Show me something quick
- Stakes: A tool for myself
- Design preference: Minimal & clean
- Starter project: Data analytics
- Data interests: CSV, Excel, Notion
```

**3. Invisible starter message (first conversation only)**

Injected as system context when creating first thread:

```
New user completed onboarding. Here's what we know:
- AI familiarity: Occasional
- Iteration style: Show me something quick
- Stakes: A tool for myself
- Design preference: Minimal & clean
- Starter project: Data analytics
- Data interests: CSV, Excel

This is their very first conversation. They chose "Data analytics" as their starter project.

Welcome them warmly and invite them to drag and drop a CSV, Excel file, or any data file into the chat to get started. Keep it simple and encouraging.
```

---

## Component Architecture

### New Files

```
src/
├── routes/
│   ├── _onboarding.tsx              # Onboarding layout with progress
│   ├── _onboarding.welcome.tsx      # Welcome screen
│   ├── _onboarding.org-slug.tsx     # Org slug chooser (conditional)
│   ├── _onboarding.q1.tsx           # AI familiarity
│   ├── _onboarding.q2.tsx           # Iteration style
│   ├── _onboarding.q3.tsx           # Stakes
│   ├── _onboarding.q4.tsx           # Design style
│   ├── _onboarding.q5.tsx           # Starter project
│   ├── _onboarding.q6.tsx           # Data & integrations
│   └── api/
│       ├── onboarding.ts            # Save preferences endpoint
│       └── orgs.$id.check-slug.ts   # Slug availability check endpoint
│       └── orgs.$id.update-slug.ts  # Slug update endpoint
├── components/
│   └── onboarding/
│       ├── onboarding-layout.tsx    # Shared layout with nav
│       ├── onboarding-option.tsx    # Clickable option card
│       ├── onboarding-progress.tsx  # Dot progress indicator
│       ├── design-style-card.tsx    # Visual style preview card
│       ├── slug-input.tsx           # Slug text input with live availability check
│       └── data-interest-grid.tsx   # Multi-select grid for Q6
```

### Routes Configuration

Add to `src/routes.ts`:

```typescript
{
  path: 'onboarding',
  file: 'routes/_onboarding.tsx',
  children: [
    { path: '', file: 'routes/_onboarding.welcome.tsx' },
    { path: 'org-slug', file: 'routes/_onboarding.org-slug.tsx' },
    { path: 'ai-familiarity', file: 'routes/_onboarding.q1.tsx' },
    { path: 'iteration-style', file: 'routes/_onboarding.q2.tsx' },
    { path: 'stakes', file: 'routes/_onboarding.q3.tsx' },
    { path: 'design-style', file: 'routes/_onboarding.q4.tsx' },
    { path: 'starter-project', file: 'routes/_onboarding.q5.tsx' },
    { path: 'data-interests', file: 'routes/_onboarding.q6.tsx' },
  ],
}
```

---

## Component Specifications

### OnboardingLayout

```tsx
// src/components/onboarding/onboarding-layout.tsx
interface OnboardingLayoutProps {
  children: React.ReactNode;
  currentStep: number;
  totalSteps: number;
  onBack?: () => void;
  onSkip?: () => void;
  showBack?: boolean;
  showSkip?: boolean;
}

export function OnboardingLayout({
  children,
  currentStep,
  totalSteps,
  onBack,
  onSkip,
  showBack = true,
  showSkip = true,
}: OnboardingLayoutProps) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      {/* Header with back/skip */}
      <div className="w-full max-w-lg flex justify-between items-center mb-8">
        {showBack && onBack ? (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4 mr-1" />
            Back
          </Button>
        ) : <div />}

        {showSkip && onSkip && (
          <Button variant="ghost" size="sm" onClick={onSkip}>
            Skip
            <ArrowRight className="size-4 ml-1" />
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="w-full max-w-lg">
        {children}
      </div>

      {/* Progress dots */}
      <OnboardingProgress current={currentStep} total={totalSteps} />
    </div>
  );
}
```

### OnboardingOption

```tsx
// src/components/onboarding/onboarding-option.tsx
interface OnboardingOptionProps {
  selected?: boolean;
  onClick: () => void;
  title: string;
  description?: string;
  icon?: React.ReactNode;
}

export function OnboardingOption({
  selected,
  onClick,
  title,
  description,
  icon,
}: OnboardingOptionProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left p-4 rounded-xl border transition-all",
        "hover:border-primary/50 hover:bg-muted/50",
        selected && "border-primary bg-primary/5"
      )}
    >
      <div className="flex items-start gap-3">
        {icon && (
          <div className="mt-0.5 text-muted-foreground">{icon}</div>
        )}
        <div className="flex-1">
          <div className="font-medium">{title}</div>
          {description && (
            <div className="text-sm text-muted-foreground mt-0.5">
              {description}
            </div>
          )}
        </div>
        <div className={cn(
          "size-5 rounded-full border-2 mt-0.5 transition-all",
          selected ? "border-primary bg-primary" : "border-muted-foreground/30"
        )}>
          {selected && <Check className="size-3 text-primary-foreground m-auto" />}
        </div>
      </div>
    </button>
  );
}
```

### OnboardingProgress

```tsx
// src/components/onboarding/onboarding-progress.tsx
interface OnboardingProgressProps {
  current: number;
  total: number;
}

export function OnboardingProgress({ current, total }: OnboardingProgressProps) {
  return (
    <div className="flex gap-2 mt-8">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "size-2 rounded-full transition-all",
            i < current ? "bg-primary" : "bg-muted-foreground/30"
          )}
        />
      ))}
    </div>
  );
}
```

### DataInterestGrid (Q6)

```tsx
// src/components/onboarding/data-interest-grid.tsx
interface DataInterestGridProps {
  selectedFiles: string[];
  selectedIntegrations: string[];
  onToggleFile: (file: string) => void;
  onToggleIntegration: (id: string) => void;
  integrationTemplates: IntegrationTemplate[];
}

const FILE_TYPES = [
  { id: 'csv', label: 'CSV', icon: FileSpreadsheet },
  { id: 'excel', label: 'Excel', icon: FileSpreadsheet },
  { id: 'sqlite', label: 'SQLite', icon: Database },
  { id: 'json', label: 'JSON', icon: FileJson },
];

export function DataInterestGrid({
  selectedFiles,
  selectedIntegrations,
  onToggleFile,
  onToggleIntegration,
  integrationTemplates,
}: DataInterestGridProps) {
  return (
    <div className="space-y-6">
      {/* Files section */}
      <div>
        <div className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
          <span>Files</span>
          <span className="text-xs font-normal">(drag & drop into chat)</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {FILE_TYPES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onToggleFile(id)}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border transition-all",
                selectedFiles.includes(id)
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50"
              )}
            >
              <Icon className="size-6" />
              <span className="text-sm">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Integrations section */}
      <div>
        <div className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
          <span>Connections</span>
          <span className="text-xs font-normal">(live API access)</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {integrationTemplates.slice(0, 8).map((template) => (
            <button
              key={template.id}
              onClick={() => onToggleIntegration(template.id)}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border transition-all",
                selectedIntegrations.includes(template.id)
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50"
              )}
            >
              <img src={template.icon_url} className="size-6" alt="" />
              <span className="text-sm truncate w-full text-center">{template.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

---

## API Endpoint

### Save Onboarding Preferences

```typescript
// src/routes/api/onboarding.ts
import type { Route } from './+types/onboarding';
import { requireAuthContext } from '@/lib/auth.server';

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const { authEnv, user } = authContext;

  const data = await request.json() as OnboardingPreferences;

  // Save to UserDO
  const userDO = authEnv.USER_DO.get(authEnv.USER_DO.idFromString(user.id));
  await userDO.updateOnboarding(data);

  return { success: true };
}
```

---

## First Chat Integration

### Injecting Onboarding Context

When creating the first thread after onboarding, inject context into the conversation:

```typescript
// src/routes/_app.chat._index.tsx - modify createThread action

function buildOnboardingContext(prefs: OnboardingPreferences): string {
  const lines = ['New user just completed onboarding. Here\'s what we know:', ''];

  const familiarityLabels = {
    extensive: 'Extensive (uses AI coding tools regularly)',
    occasional: 'Occasional (has vibe-coded a few things)',
    a_little: 'A little (chatted with AI, hasn\'t built much)',
    new: 'New to AI (first time)',
  };
  if (prefs.ai_familiarity) {
    lines.push(`- AI familiarity: ${familiarityLabels[prefs.ai_familiarity]}`);
  }

  const iterationLabels = {
    show_quick: 'Show me something quick, then iterate',
    ask_first: 'Ask questions first before building',
    depends: 'Depends on the project',
  };
  if (prefs.iteration_style) {
    lines.push(`- Iteration style: ${iterationLabels[prefs.iteration_style]}`);
  }

  const stakesLabels = {
    trying_out: 'Just trying this out, experimenting',
    for_myself: 'A tool for myself',
    for_team: 'Something for my team',
    for_public: 'Something for customers/public',
    for_money: 'Something production-grade I could charge for',
  };
  if (prefs.stakes) {
    lines.push(`- Stakes: ${stakesLabels[prefs.stakes]}`);
  }

  const designLabels = {
    colorful: 'Colorful & playful',
    sleek: 'Sleek & modern',
    minimal: 'Minimal & clean',
    warm: 'Warm & friendly',
    bold: 'Bold & dramatic',
    per_project: 'Will specify per project',
  };
  if (prefs.design_style) {
    lines.push(`- Design preference: ${designLabels[prefs.design_style]}`);
  }

  if (prefs.data_interests.files.length > 0) {
    lines.push(`- Interested in file types: ${prefs.data_interests.files.join(', ').toUpperCase()}`);
  }

  if (prefs.data_interests.integrations.length > 0) {
    lines.push(`- Interested in connecting: ${prefs.data_interests.integrations.join(', ')}`);
  }

  // Add starter project guidance
  if (prefs.starter_project) {
    lines.push('');
    lines.push('This is their very first conversation with you.');

    const guidance = {
      data_analytics: 'They chose "Data analytics" as their starter project. Welcome them warmly and invite them to drag and drop a CSV, Excel file, or any data file into the chat to get started. Keep it simple and encouraging.',
      personal_site: 'They chose "Personal site" as their starter project. Ask about their vibe and what they want to showcase on their site.',
      business_tool: 'They chose "Business tool" as their starter project. Ask what workflow is painful or what data they need to manage.',
      team_productivity: 'They chose "Team productivity" as their starter project. Ask about their team\'s current workflow and what feels clunky.',
      something_fun: 'They chose "Something fun" as their starter project. Jump right into building something playful—suggest a few fun project ideas.',
    };

    lines.push('');
    lines.push(guidance[prefs.starter_project] || 'Ask what they\'re thinking about building.');
  }

  return lines.join('\n');
}
```

---

## Implementation Checklist

### Phase 1: Data Model & API
- [ ] Add `OnboardingPreferences` type to `src/types.ts`
- [ ] Add migration to UserDO (schema version 7) for onboarding field
- [ ] Add `updateOnboarding()` method to UserDO
- [ ] Create `/api/onboarding` endpoint for saving preferences
- [ ] Add `onboarding` field to user auth state returned by `requireAuthContext()`
- [ ] Add `updateSlug()` method to OrgDO (with owner + zero-apps guard)
- [ ] Add slug registry Durable Object (`claim/getOwner/release`) for atomic uniqueness
- [ ] Register auto-generated slug claim during `createOrg()`
- [ ] Create `POST /api/orgs/:id/check-slug` endpoint (format validation + uniqueness)
- [ ] Create `POST /api/orgs/:id/update-slug` endpoint (owner-only, zero-apps guard)

### Phase 2: Onboarding UI Components
- [ ] Create `src/components/onboarding/onboarding-layout.tsx`
- [ ] Create `src/components/onboarding/onboarding-option.tsx`
- [ ] Create `src/components/onboarding/onboarding-progress.tsx`
- [ ] Create `src/components/onboarding/design-style-card.tsx`
- [ ] Create `src/components/onboarding/slug-input.tsx` (debounced input + availability indicator)
- [ ] Create `src/components/onboarding/data-interest-grid.tsx`

### Phase 3: Onboarding Routes
- [ ] Add onboarding routes to `src/routes.ts`
- [ ] Create `src/routes/_onboarding.tsx` layout
- [ ] Create `src/routes/_onboarding.welcome.tsx`
- [ ] Create `src/routes/_onboarding.org-slug.tsx` (org slug chooser, conditional)
- [ ] Create `src/routes/_onboarding.q1.tsx` (AI familiarity)
- [ ] Create `src/routes/_onboarding.q2.tsx` (Iteration style)
- [ ] Create `src/routes/_onboarding.q3.tsx` (Stakes)
- [ ] Create `src/routes/_onboarding.q4.tsx` (Design style)
- [ ] Create `src/routes/_onboarding.q5.tsx` (Starter project)
- [ ] Create `src/routes/_onboarding.q6.tsx` (Data & integrations)

### Phase 4: Flow Integration
- [ ] Redirect new users to `/onboarding` after signup (modify `src/routes/api/auth.signup.ts`)
- [ ] Determine whether to show org slug step (owner + 1 member + 0 apps check)
- [ ] Handle branching logic (extensive users skip Q2, Q3, Q5)
- [ ] Save progress to localStorage on each step (`chiridion:onboarding:progress`)
- [ ] Resume from localStorage if user refreshes mid-onboarding
- [ ] Block navigation to `/chat` until onboarding complete
- [ ] Mark onboarding complete, clear localStorage, redirect to `/chat` on finish
- [ ] Existing users joining new org: show team welcome → `/chat` (skip questions)

### Phase 5: First Chat Context
- [ ] Modify `createThread` action to inject onboarding context for first-time users
- [ ] Write preferences to `~/.chiridion/profile.md` on first message
- [ ] Test Claude's personalized openers with different preference combinations

### Phase 6: Design Polish
- [ ] Generate preview images for design style options (Q4)
- [ ] Add keyboard navigation (arrow keys between options, enter to confirm)
- [ ] Add transition animations between steps
- [ ] Test on mobile viewports

---

## Component Dependencies

### shadcn/ui Components (Already Installed)
- `Button` — Back, Skip, Get Started, Continue actions
- `Card` — Design style preview cards (Q4)
- `Input` — Slug text input (org slug step)

### Lucide Icons
- `ArrowLeft` — Back button
- `ArrowRight` — Skip button
- `Check` — Selected option indicator, slug available indicator
- `X` — Slug taken/invalid indicator
- `Loader2` — Slug checking spinner
- `FileSpreadsheet` — CSV/Excel icons
- `Database` — SQLite icon
- `FileJson` — JSON icon
- `BarChart3` — Data analytics icon
- `Globe` — Personal site icon
- `Wrench` — Business tool icon
- `Users` — Team productivity icon
- `Gamepad2` — Something fun icon

---

## File Changes Summary

| File | Action |
|------|--------|
| `src/types.ts` | **Modify** — Add `OnboardingPreferences` type |
| `workers/main/src/auth.ts` | **Modify** — Add onboarding field to UserDO (migration v7), add `updateSlug()` to OrgDO, register slug claims during `createOrg()` |
| `workers/main/src/org-slug-registry.ts` (or `workers/main/src/auth.ts`) | **Create/Modify** — Durable Object for atomic slug claim/check/release |
| `src/routes.ts` | **Modify** — Add onboarding routes (including `org-slug`) |
| `src/routes/_onboarding.tsx` | **Create** — Onboarding layout (includes logic to determine if slug step is shown) |
| `src/routes/_onboarding.welcome.tsx` | **Create** — Welcome screen |
| `src/routes/_onboarding.org-slug.tsx` | **Create** — Org slug chooser (conditional step) |
| `src/routes/_onboarding.q1.tsx` | **Create** — AI familiarity |
| `src/routes/_onboarding.q2.tsx` | **Create** — Iteration style |
| `src/routes/_onboarding.q3.tsx` | **Create** — Stakes |
| `src/routes/_onboarding.q4.tsx` | **Create** — Design style |
| `src/routes/_onboarding.q5.tsx` | **Create** — Starter project |
| `src/routes/_onboarding.q6.tsx` | **Create** — Data & integrations |
| `src/routes/api/onboarding.ts` | **Create** — Save preferences endpoint |
| `src/routes/api/orgs.$id.check-slug.ts` | **Create** — Slug availability check endpoint |
| `src/routes/api/orgs.$id.update-slug.ts` | **Create** — Slug update endpoint |
| `src/components/onboarding/onboarding-layout.tsx` | **Create** |
| `src/components/onboarding/onboarding-option.tsx` | **Create** |
| `src/components/onboarding/onboarding-progress.tsx` | **Create** |
| `src/components/onboarding/design-style-card.tsx` | **Create** |
| `src/components/onboarding/slug-input.tsx` | **Create** — Debounced slug input with availability indicator |
| `src/components/onboarding/data-interest-grid.tsx` | **Create** |
| `src/routes/_app.chat._index.tsx` | **Modify** — Inject onboarding context |
| `src/routes/api/auth.signup.ts` | **Modify** — Redirect to `/onboarding` after signup |
| `src/lib/auth.server.ts` | **Modify** — Include onboarding in auth context |
| `public/images/onboarding/*.avif` | **Already added** — Design style preview images |

---

## Testing Requirements

### Core Onboarding Flow

| Test | Description |
|------|-------------|
| `new-user-sees-onboarding` | New user after signup is redirected to `/onboarding` |
| `onboarding-only-once` | User with `onboarding.completed_at` set is never redirected to `/onboarding` again |
| `onboarding-completion-redirects-to-chat` | After Q6, user is redirected to `/chat` |
| `first-chat-has-invisible-context` | First thread created after onboarding includes the invisible starter message with preferences |
| `profile-written-on-first-message` | `~/.chiridion/profile.md` is created/updated when user sends first message |

### Org Slug Step

| Test | Description |
|------|-------------|
| `slug-shown-for-new-org-owner` | New user who just created their org sees the org slug step after Welcome |
| `slug-hidden-for-invited-user` | User joining an existing org via invitation does NOT see the org slug step |
| `slug-hidden-for-non-owner` | User who is not the org owner does NOT see the org slug step |
| `slug-hidden-if-apps-exist` | If org already has published apps, slug step is skipped even for owner |
| `slug-prefilled-with-auto-generated` | Input is pre-filled with the current auto-generated slug (e.g., `acme-corp-85b`) |
| `slug-availability-check-debounced` | Typing rapidly only fires one availability check after debounce (300ms) |
| `slug-available-shows-checkmark` | Available slug shows green check + "Available" text |
| `slug-taken-shows-x` | Taken slug shows red X + "Already taken" text |
| `slug-invalid-format-shows-error` | Invalid chars show red X + format error message |
| `slug-too-short-shows-error` | Slug under 3 chars shows red X + "At least 3 characters" |
| `slug-continue-disabled-until-available` | "Continue" button is disabled until slug is confirmed available |
| `slug-url-preview-updates-live` | URL preview below input updates as user types |
| `slug-skip-keeps-auto-generated` | Clicking "Skip" proceeds with the original auto-generated slug |
| `slug-saved-on-continue` | Clicking "Continue" calls the update-slug endpoint and persists the new slug |
| `slug-cannot-be-changed-later` | After leaving the slug step, there is no UI to change it again (the slug step only shows during onboarding) |

### Team/Invitation Flow

| Test | Description |
|------|-------------|
| `new-user-invited-to-team-sees-full-onboarding` | User who has never completed onboarding, joining via invitation, sees full onboarding flow (with team welcome variant) |
| `existing-user-invited-to-team-skips-onboarding` | User who has `onboarding.completed_at` set, joining via invitation, sees ONLY the team welcome screen, then goes straight to `/chat` |
| `team-welcome-shows-org-context` | Team welcome screen displays org name, app count, and connected integrations |
| `team-welcome-next-goes-to-chat` | For existing users, "Get Started" on team welcome goes directly to `/chat`, not Q1 |

### Branching Logic

| Test | Description |
|------|-------------|
| `extensive-skips-to-q4` | User selecting "Yes, extensively" on Q1 goes directly to Q4 (Design Style) |
| `extensive-skips-q5` | Extensive users do NOT see Q5 (Starter Project) — flow is Q1 → Q4 → Q6 → Chat |
| `non-extensive-sees-full-path` | Users selecting "occasionally", "a little", or "new" see Q1 → Q2 → Q3 → Q4 → Q5 → Q6 |
| `back-navigation-works` | Back button returns to previous question in the path taken |
| `back-from-q4-extensive` | Extensive user pressing back on Q4 returns to Q1 (not Q3) |

### Skip Behavior

| Test | Description |
|------|-------------|
| `skip-sets-null-value` | Skipping a question sets that preference to `null`, not a default |
| `skip-advances-to-next` | Skip button advances to next question in the flow |
| `partial-onboarding-still-completes` | User who skips all questions still has `onboarding.completed_at` set |
| `cannot-skip-entire-onboarding` | There is no "skip all" option — user must click through each screen |
| `must-complete-to-reach-chat` | User cannot navigate directly to `/chat` until onboarding is complete |

### First Chat Context

| Test | Description |
|------|-------------|
| `context-includes-all-answered-questions` | Invisible message includes all non-null preferences |
| `context-excludes-skipped-questions` | Skipped questions (null values) are not mentioned in context |
| `starter-project-drives-opener-guidance` | Context includes specific guidance based on starter project selection |
| `data-analytics-mentions-drag-drop` | If starter project is "data_analytics", context mentions drag-and-drop |
| `file-interests-included` | Selected file types (CSV, Excel, etc.) appear in context |
| `integration-interests-included` | Selected integrations appear in context |

### Persistence

| Test | Description |
|------|-------------|
| `preferences-saved-to-userdo` | Onboarding preferences are stored in UserDO |
| `preferences-survive-logout` | Logging out and back in preserves onboarding completion status |
| `preferences-per-user-not-per-org` | Onboarding completion is tied to user, not org — user in multiple orgs only onboards once |

### Progress Persistence (localStorage)

| Test | Description |
|------|-------------|
| `progress-saved-to-localstorage` | Current step and answers are saved to localStorage on each step |
| `refresh-resumes-from-localstorage` | Refreshing page resumes from saved step |
| `cleared-storage-restarts-onboarding` | If localStorage is cleared, onboarding restarts from welcome |
| `completed-onboarding-clears-progress` | localStorage progress is cleared after `onboarding.completed_at` is set |

**localStorage key:** `chiridion:onboarding:progress`

```typescript
interface OnboardingProgress {
  currentStep: string; // e.g., 'q2', 'q4'
  answers: Partial<OnboardingPreferences>;
  startedAt: number;
}
```

### Edge Cases

| Test | Description |
|------|-------------|
| `direct-nav-to-onboarding-when-complete` | Manually navigating to `/onboarding` when already complete redirects to `/chat` |
| `onboarding-requires-auth` | Unauthenticated users cannot access `/onboarding/*` routes |
| `cannot-skip-to-chat` | User cannot navigate to `/chat` before completing onboarding |

### Integration Tests (E2E)

```typescript
// e2e/onboarding.spec.ts

test.describe('Onboarding Flow', () => {
  test('new user completes full onboarding path', async ({ page }) => {
    // 1. Sign up new user
    // 2. Verify redirect to /onboarding
    // 3. Click through welcome → Q1 (select "A little") → Q2 → Q3 → Q4 → Q5 → Q6
    // 4. Verify redirect to /chat
    // 5. Verify Claude's first message acknowledges preferences
  });

  test('extensive user takes short path', async ({ page }) => {
    // 1. Sign up new user
    // 2. Q1: select "Yes, extensively"
    // 3. Verify next screen is Q4 (not Q2)
    // 4. Complete Q4 → Q6
    // 5. Verify redirect to /chat
  });

  test('existing user joining team skips onboarding', async ({ page }) => {
    // 1. Create user A, complete onboarding
    // 2. Create org B, invite user A
    // 3. User A accepts invitation
    // 4. Verify user sees team welcome screen (not Q1)
    // 5. Click "Get Started"
    // 6. Verify redirect to /chat (not Q1)
  });

  test('new user joining team sees full onboarding', async ({ page }) => {
    // 1. Create org with existing user
    // 2. Invite new email
    // 3. New user signs up via invitation link
    // 4. Verify user sees team welcome variant
    // 5. Click "Get Started"
    // 6. Verify next screen is Q1 (full onboarding)
  });
});
```

---

## Design Decisions (Resolved)

| Decision | Resolution |
|----------|------------|
| **Design style previews** | Static AVIF images at `/images/onboarding/ob-preview-*.avif` (~47KB total) |
| **Skip behavior** | Users can skip individual questions (sets value to `null`), but cannot skip entire onboarding |
| **Re-onboarding** | Users cannot redo onboarding. Design preferences are written to user profile and can be changed by telling Claude in chat. |
| **Progress persistence** | localStorage only. If user bounces and clears storage, onboarding restarts from beginning. |
| **Org slug placement** | Between Welcome and Q1. It's about org identity/setup, not personal preferences, so it comes before the preference questions. |
| **Org slug skip** | Skipping keeps the auto-generated slug. No change is made. |
| **Org slug permanence** | Slug cannot be changed after onboarding. Warning text shown on the screen. This is a one-time choice. |

---

## Org Slug — Codebase Reference for Implementation Agent

> This section contains all the codebase context needed to implement the org slug onboarding step.

### Current Slug Generation

**File:** `workers/main/src/auth.ts` (lines 29–44)

```typescript
function generateOrgSlug(name: string, idPrefix: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'org';
  return `${base}-${idPrefix}`;
}
```

- Called during `OrgDO.createOrg()` at line 1035: `const slug = generateOrgSlug(name, id.slice(0, 3));`
- Slug stored in `Organization` interface as `slug` field (defined in `src/types.ts` lines 141–151)
- Stored as JSON in OrgDO's `org_info` SQLite table, key `'data'`

### How Slugs Are Used for Subdomains

**URL format:** `https://{scriptName}--{orgSlug}.chiridion.app`

- **Dispatcher:** `workers/dispatcher/src/index.ts` — `parseWorkerRoute()` extracts `scriptName` and `orgSlug` from hostname
- **URL builders:** `src/lib/app-url.ts` — `getAppUrl()` and `getAppIframeUrl()` construct URLs using the slug
- **Deploy flow:** `workers/main/src/cf-api-proxy.ts` line 654 — retrieves slug via `orgStub.getSlug()` and constructs `dispatchScriptName = {scriptName}--{orgSlug}`
- **KV index:** Deployed apps indexed as `script:{scriptName}--{orgSlug}` in `APP_KV`

### OrgDO Slug Methods

**File:** `workers/main/src/auth.ts`

- `getSlug()` (line 1020) — Returns slug from org info, falls back to generating from name
- `getInfo()` (line 985) — Returns full org info including slug; auto-generates slug if missing (lines 1006–1008)
- `setInfo()` (line 1025) — Writes org info JSON to SQLite
- `createOrg()` (line 1033) — Generates and stores slug at creation time
- **No `updateSlug()` exists yet** — needs to be created

### What Needs to Be Built (Implementation Details)

This plan uses a **Durable Object slug registry** (not KV) for race-safe uniqueness.

Required slug deliverables:
1. `OrgDO.updateSlug()` with owner + one-member + zero-worker-script guards.
2. Slug registry DO with atomic `claim/getOwner/release`.
3. `POST /api/orgs/:id/check-slug` endpoint.
4. `POST /api/orgs/:id/update-slug` endpoint.
5. Auto-generated slug claim in `createOrg()`.
6. `slug-input.tsx` with debounced availability checks and inline status.
7. `_onboarding.tsx` logic to show/hide the slug step.

### Relevant Test File

**File:** `tests/dispatcher-url-parsing.test.ts` (lines 288–328) — existing tests for `generateOrgSlug()` with various inputs

---

## Open Questions

- [ ] **Team welcome data:** How do we fetch app count and integration list for the team welcome variant?
