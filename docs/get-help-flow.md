# Get Help Flow

## Status

February 19, 2026 — Draft v3

## Problem

Users have no way to request help or report issues directly from the app. When something goes wrong or a user has a question, they have to leave camelAI to find a support channel. We want a frictionless in-app flow that:

1. Makes the help entry point discoverable but unobtrusive
2. Collects enough context to resolve the issue quickly
3. Sends a polished confirmation email to the user
4. Sends a detail-rich email to the support team with all the who/what/where/why/how context

---

## Design

### 1. Sidebar Help Button

A `CircleHelp` (lucide) icon sits in the `SidebarFooter`, directly above the existing `NavUser` component. It uses the same `SidebarMenu > SidebarMenuItem > SidebarMenuButton` pattern as nav items, with tooltip support for when the sidebar is collapsed.

```
┌─────────────────────┐
│  WorkspaceSwitcher   │  ← SidebarHeader
├─────────────────────┤
│  ◈ New Chat          │
│  ◈ Computer          │  ← SidebarContent
│  ◈ Chat History      │
│  ◈ Connections       │
│  ◈ Apps              │
│                      │
│                      │
│                      │
├─────────────────────┤
│  ⓘ Get Help          │  ← NEW: SidebarFooter item (above NavUser)
│  👤 Jane Doe         │  ← Existing NavUser
└─────────────────────┘
```

**Collapsed sidebar:**

```
┌───┐
│ ◈ │  ← nav icons
│ ◈ │
│ ◈ │
│ ◈ │
│ ◈ │
│   │
│ ? │  ← CircleHelp icon, tooltip "Get Help"
│ 👤│  ← NavUser avatar
└───┘
```

**Implementation:** This is NOT a link — the button opens the help dialog directly via `onClick`. No route needed. Add `const [helpOpen, setHelpOpen] = useState(false)` in `AppSidebar`, render the `GetHelpDialog` component alongside, and pass open/onOpenChange props.

---

### 2. Help Dialog

A centered `Dialog` (shadcn) with a form. Mobile: use `Sheet` (bottom) for responsive behavior, following the same pattern as `InviteMemberDialog`.

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   Get Help                                        ✕   │
│   Tell us what you need help with. We'll get          │
│   back to you via email.                              │
│                                                       │
│   Category                                            │
│   ┌─────────────────────────────────────────────────┐ │
│   │ Bug report                                  ▾   │ │
│   └─────────────────────────────────────────────────┘ │
│                                                       │
│   Severity                                            │
│   ┌─────────┐  ┌──────────┐  ┌──────────┐            │
│   │ 🟢 Low  │  │ 🟡 Med   │  │ 🔴 High  │            │
│   └─────────┘  └──────────┘  └──────────┘            │
│    ▲ selected                                         │
│                                                       │
│   Description                                         │
│   ┌─────────────────────────────────────────────────┐ │
│   │                                                 │ │
│   │ What happened? What did you expect?             │ │
│   │ Include steps to reproduce if applicable.       │ │
│   │                                                 │ │
│   │                                                 │ │
│   │                                                 │ │
│   └─────────────────────────────────────────────────┘ │
│                                                       │
│                           ┌────────┐  ┌────────────┐  │
│                           │ Cancel │  │  Submit     │  │
│                           └────────┘  └────────────┘  │
│                                                       │
└───────────────────────────────────────────────────────┘
```

#### Severity Selector Detail

Install the `ToggleGroup` component from shadcn (`npx shadcn@latest add toggle-group`). Use `ToggleGroup` with `type="single"` and `variant="outline"` for a segmented-button look. Each option gets a colored dot indicator:

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  ● Low       │  │  ● Medium    │  │  ● High      │
└──────────────┘  └──────────────┘  └──────────────┘
  ▲ green dot       ▲ yellow dot      ▲ red dot
  text-green-500    text-yellow-500   text-destructive
```

- Default value: `"low"` — user can submit without touching this
- Colored dots: inline `<span>` circle with `w-2 h-2 rounded-full` and the severity color as background
- Selected state: the ToggleGroup handles `data-[state=on]` styling automatically
- Values: `low`, `medium`, `high`

#### Form Fields

| Field | Type | Required | Details |
|-------|------|----------|---------|
| Category | `Select` | Yes | Options: `Bug report`, `Feature request`, `Question`, `Account & billing`, `Other` |
| Severity | `ToggleGroup` | Yes (defaults to `low`) | Options: `Low` (green), `Medium` (yellow), `High` (red) |
| Description | `Textarea` | Yes | Free-form details, `min-h-[120px]`, placeholder: `"What happened? What did you expect? Include steps to reproduce if applicable."` |

No subject field — the subject line for emails is auto-generated from the description using AI (see Section 3).

#### Hidden Fields (sent automatically, not shown to user)

The dialog captures these transparently and includes them as hidden form fields:

| Field | Source | Purpose |
|-------|--------|---------|
| `pageUrl` | `window.location.href` | The URL the user was on when they opened the dialog |
| `screenSize` | `${window.innerWidth}x${window.innerHeight}` | Viewport dimensions |

#### Validation

Use `parseWithZod` + `useForm` (Conform), matching the existing codebase pattern:

```typescript
const getHelpFormSchema = z.object({
  category: z.enum(['bug', 'feature', 'question', 'billing', 'other']),
  severity: z.enum(['low', 'medium', 'high']).default('low'),
  description: z.string().min(1, 'Please describe your issue'),
  pageUrl: z.string().optional(),
  screenSize: z.string().optional(),
})
```

Validate on blur, revalidate on input (`shouldValidate: "onBlur"`, `shouldRevalidate: "onInput"`).

#### Submission

Use `useFetcher` to `POST /api/help` with form fields. On success, close dialog + `toast.success("Help request sent! Check your email for confirmation.")`.

#### Loading State

While submitting, disable both buttons and show `Loader2` spinner in the submit button: `"Sending..."`.

---

### 3. API Route: `POST /api/help`

New route at `src/routes/api/help.ts`.

**Server-side logic:**

1. `requireAuthContext(request, context)` — get full user/org/workspace context
2. Parse + validate form data with zod schema
3. Generate a subject line from the description using AI (background, non-blocking for emails)
4. Send two emails in parallel using `waitUntil` (non-blocking):
   - **Email A** → User + CC support address (confirmation email)
   - **Email B** → Support address only (detailed internal email)
5. Return `{ success: true }` immediately (don't block on email delivery or AI generation)

#### AI-Generated Subject Line

Subject generation goes through the shared auxiliary helper (`runAuxiliaryAiChatCompletion` with `AUXILIARY_AI_MODEL` from `src/lib/auxiliary-ai.server.ts`) — the same single utility model used for thread titles, chat group emoji, and completion summaries:

```typescript
const subject = await runAuxiliaryAiChatCompletion(env.AI, {
  systemPrompt: 'Summarize the following support request into a short subject line (under 80 characters). Respond with only the subject line, no quotes or extra punctuation.',
  userMessage: description,
  maxTokens: 30,
});
return normalizeSubject(subject) ?? categoryLabel;
```

**Fallback:** If AI generation fails or returns empty, fall back to the human-readable category label (e.g., "Bug report").

**Timing:** Generate subject *before* sending emails since both emails need it. Wrap the entire email flow (AI + send) in `waitUntil()` so the API returns instantly regardless:

```typescript
waitUntil(
  (async () => {
    const subject = await generateHelpSubject(env, description, categoryLabel);
    await Promise.all([
      sendHelpConfirmationEmail({ env, to: user.email, subject, ... }),
      sendHelpSupportEmail({ env, to: SUPPORT_EMAIL, subject, ... }),
    ]);
  })().catch(err => console.error('Help email delivery failed:', err))
);
```

#### Data Sourced for Emails

| Field | Source | Used In |
|-------|--------|---------|
| User name | `authContext.user.name` | Both emails |
| User email | `authContext.user.email` | Both emails (To + body) |
| User ID | `authContext.user.id` | Support email |
| Org name | `authContext.currentOrg.name` | Support email |
| Org slug | `authContext.currentOrg.slug` | Support email |
| Org ID | `authContext.currentOrg.id` | Support email |
| Billing status | `authContext.currentOrg.billing_status` | Support email |
| Workspace name | `authContext.currentWorkspace?.name` | Support email |
| Workspace ID | `authContext.currentWorkspace?.id` | Support email |
| Category | Form field | Both emails |
| Severity | Form field | Both emails |
| Description | Form field | Both emails |
| Subject | AI-generated from description | Both emails |
| Page URL | Form hidden field (`window.location.href`) | Support email |
| Screen size | Form hidden field (`${innerWidth}x${innerHeight}`) | Support email |
| Submitted at | `new Date().toISOString()` | Support email |
| User-Agent | `request.headers.get('user-agent')` | Support email |
| Referer | `request.headers.get('referer')` | Support email |

**Support email constant:** `SUPPORT_EMAIL = 'support@camelai.com'`

**Route registration:** Add to `src/routes.ts` as an API route:
```typescript
route("api/help", "routes/api/help.ts"),
```

---

### 4. Email A: User Confirmation Email

Sent to: **user email**, CC: **support@camelai.com**
Reply-To: **support@camelai.com** (so replies go to the support team)
Subject: `We received your request — {ai-generated subject}`

New React Email template at `src/lib/email/templates/help-confirmation-email.tsx`.

Uses the same `containerStyle` and design language as the existing `OrgInvitationEmailTemplate`, with additional polish for a warm, branded feel.

#### Logo Strategy

The email uses the full-name brand SVG (`/camelAI-fullname-logo-lightmode.svg`) rendered via the `<Img>` component from `@react-email/components`. The SVG is already hosted in `public/` and served by Cloudflare.

```typescript
import { Img } from '@react-email/components';

<Img
  src={`${baseUrl}/camelAI-fullname-logo-lightmode.svg`}
  alt="camelAI"
  width={160}
  height={39}
  style={{ margin: '0' }}
/>
```

- **`baseUrl`** is passed as a template prop, resolved via `resolveAppBaseUrl()` (same helper used by other emails)
- **Dimensions:** Original is 1932×466 (4.15:1 ratio). Scale to `width: 160, height: 39` for a tasteful email header size
- **`alt="camelAI"`** ensures the brand name is visible even when images are blocked
- SVG renders well in Apple Mail, Gmail (web + mobile), Yahoo, and Outlook.com. For Outlook desktop (Windows), the `alt` text provides the fallback. This is acceptable — no current email templates use images at all, so this is a step up.

#### Email Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                                                                 │
│    [camelAI fullname logo]     ← SVG via <Img>, 160×39          │
│                                  alt="camelAI" for fallback     │
│                                                                 │
│    ─────────────────────────────────────────────────────────    │
│                                                                 │
│    Hey {firstName}!                                             │
│                                                                 │
│    We've received your help request and our team is             │
│    already on it.                                               │
│                                                                 │
│    Here's what you sent us:                                     │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                                                         │   │
│   │  Category     Bug report                                │   │
│   │  Severity     High                                      │   │
│   │                                                         │   │
│   │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │   │
│   │                                                         │   │
│   │  "When I upload a file larger than 50MB, the agent      │   │
│   │   stops responding. I expected it to process the         │   │
│   │   file or show an error..."                              │   │
│   │                                                         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│    What happens next?                                           │
│                                                                 │
│    We'll respond to {userEmail} as soon as we can —             │
│    typically within a few hours during business hours.           │
│                                                                 │
│    In the meantime, just reply to this email if you             │
│    have anything to add.                                        │
│                                                                 │
│    ─────────────────────────────────────────────────────────    │
│                                                                 │
│    Thanks for using camelAI,                                    │
│    The camelAI Team                                             │
│                                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Template props:**

```typescript
interface HelpConfirmationEmailTemplateProps {
  baseUrl: string;          // From resolveAppBaseUrl() — for logo src
  firstName: string;        // user.name?.split(' ')[0] || "there"
  userEmail: string;
  category: string;         // Human-readable label (e.g., "Bug report")
  severity: string;         // Human-readable label (e.g., "High")
  description: string;      // Truncated to 500 chars with "..." if longer
}
```

**Styling details:**

- **Logo:** `<Img>` with `width: 160, height: 39`, top of email, left-aligned. `margin-bottom: 24px` to give breathing room before the divider
- **Top/bottom dividers:** `border-top: 1px solid #e5e7eb` — thin horizontal lines to frame the content
- **Summary box:** `background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px`
- **Summary labels** (Category, Severity): `color: #6b7280; font-size: 13px; font-weight: 600`
- **Summary values:** `color: #111827; font-size: 13px`
- **Dashed separator** inside box: `border-top: 1px dashed #e5e7eb` between metadata and description
- **Description quote:** `color: #374151; font-style: italic; font-size: 14px; line-height: 1.6`
- **"What happens next?" heading:** `font-size: 15px; font-weight: 600; color: #111827`
- **Response time text:** `color: #4b5563; font-size: 14px; line-height: 1.6`
- **Sign-off:** `color: #6b7280; font-size: 13px`
- Same `containerStyle` (max-width 560px, 24px padding, system font stack) as existing templates

---

### 5. Email B: Support Team Email

Sent to: **support@camelai.com**
Subject: `[{severity}] [{category}] {ai-generated subject} — {user name} ({org slug})`

Example: `[High] [Bug] Agent freezes on large file upload — Jane Doe (acme-inc)`

New React Email template at `src/lib/email/templates/help-support-email.tsx`.

This is an information-dense internal email designed for fast triage. Structured around the 5 Ws:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│    New Help Request                                         │
│    Severity: ● High                                         │
│                                                             │
│    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                             │
│    WHO                                                      │
│    Name:         Jane Doe                                   │
│    Email:        jane@acme.com                              │
│    User ID:      usr_abc123                                 │
│                                                             │
│    WHERE                                                    │
│    Org:          Acme Inc (acme-inc)                        │
│    Org ID:       org_xyz789                                 │
│    Plan:         paying                                     │
│    Workspace:    My Project                                 │
│    Workspace ID: ws_def456                                  │
│    Page URL:     https://camelai.com/chat/abc123            │
│                                                             │
│    WHAT                                                     │
│    Category:     Bug report                                 │
│    Severity:     High                                       │
│    Subject:      Agent freezes on large file upload         │
│                                                             │
│    WHY / HOW (User Description)                             │
│    ┌─────────────────────────────────────────────────────┐  │
│    │ When I upload a file larger than 50MB, the agent     │  │
│    │ stops responding. I expected it to process the file  │  │
│    │ or show an error. This happens every time I try.     │  │
│    │ I'm using Chrome on macOS.                           │  │
│    └─────────────────────────────────────────────────────┘  │
│                                                             │
│    CONTEXT                                                  │
│    Submitted:    2026-02-19T14:32:00.000Z                   │
│    User-Agent:   Mozilla/5.0 (Macintosh; Intel Mac OS X ..) │
│    Screen size:  1440x900                                   │
│    Referer:      https://camelai.com/chat/abc123             │
│                                                             │
│    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Severity indicator in header:** Color-coded dot next to severity text.
- High: `color: #ef4444` (red)
- Medium: `color: #eab308` (yellow)
- Low: `color: #22c55e` (green)

**Template props:**

```typescript
interface HelpSupportEmailTemplateProps {
  // WHO
  userName: string | null;
  userEmail: string;
  userId: string;
  // WHERE
  orgName: string;
  orgSlug: string;
  orgId: string;
  billingStatus: string;
  workspaceName: string | null;
  workspaceId: string | null;
  pageUrl: string | null;
  // WHAT
  category: string;
  severity: string;
  subject: string;
  // WHY / HOW
  description: string;        // Full description, no truncation
  // CONTEXT
  submittedAt: string;
  userAgent: string | null;
  screenSize: string | null;
  referer: string | null;
}
```

**Styling details:**

- Section headers (WHO, WHERE, etc.): `font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280`
- Labels: `color: #6b7280; font-size: 13px; display: inline-block; min-width: 120px`
- Values: `color: #111827; font-size: 13px`
- Description box: `background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; white-space: pre-wrap`
- Same `containerStyle` as other templates

---

### 6. Email Delivery

Both emails go through the existing `deliverEmail()` function in `email.server.ts`.

Add two new exported functions to `email.server.ts`:

```typescript
export async function sendHelpConfirmationEmail(args: {
  env: EmailEnvBindings;
  baseUrl: string;
  to: string;
  firstName: string;
  userEmail: string;
  category: string;
  severity: string;
  subject: string;
  description: string;
}): Promise<EmailDeliveryResult>

export async function sendHelpSupportEmail(args: {
  env: EmailEnvBindings;
  to: string;
  userName: string | null;
  userEmail: string;
  userId: string;
  orgName: string;
  orgSlug: string;
  orgId: string;
  billingStatus: string;
  workspaceName: string | null;
  workspaceId: string | null;
  pageUrl: string | null;
  category: string;
  severity: string;
  subject: string;
  description: string;
  submittedAt: string;
  userAgent: string | null;
  screenSize: string | null;
  referer: string | null;
}): Promise<EmailDeliveryResult>
```

Both functions follow the same pattern as `sendOrgInvitationEmail`: render the React Email template with `createElement`, extract plain text with `toPlainText`, call `deliverEmail()`.

In the API route, the entire flow (AI subject generation + both email sends) runs inside `waitUntil()`:

```typescript
import { waitUntil } from 'cloudflare:workers';

waitUntil(
  (async () => {
    const subject = await generateHelpSubject(env, description, categoryLabel);
    await Promise.all([
      sendHelpConfirmationEmail({ env, to: userEmail, subject, ... }),
      sendHelpSupportEmail({ env, to: SUPPORT_EMAIL, subject, ... }),
    ]);
  })().catch(err => console.error('Help email delivery failed:', err))
);
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/routes/api/help.ts` | API action route — auth, validation, AI subject generation, email dispatch |
| `src/components/get-help-dialog.tsx` | Help dialog with form (desktop Dialog / mobile Sheet) |
| `src/lib/email/templates/help-confirmation-email.tsx` | React Email template for user confirmation |
| `src/lib/email/templates/help-support-email.tsx` | React Email template for support team |

## Files to Modify

| File | Change |
|------|--------|
| `src/components/sidebar/app-sidebar.tsx` | Add `CircleHelp` button + `useState` for dialog open state in `SidebarFooter`, above `NavUser`. Render `<GetHelpDialog>`. |
| `src/lib/email.server.ts` | Add `sendHelpConfirmationEmail()` and `sendHelpSupportEmail()` exports |
| `src/routes.ts` | Register `route("api/help", "routes/api/help.ts")` in the API routes section |

## Components to Install

```bash
npx shadcn@latest add toggle-group
```

## Components Used

| Component | Source |
|-----------|--------|
| `CircleHelp` | `lucide-react` |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` | `@/components/ui/dialog` |
| `Sheet`, `SheetContent`, `SheetHeader`, `SheetTitle`, `SheetFooter` | `@/components/ui/sheet` |
| `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` | `@/components/ui/select` |
| `ToggleGroup`, `ToggleGroupItem` | `@/components/ui/toggle-group` |
| `Textarea` | `@/components/ui/textarea` |
| `Button` | `@/components/ui/button` |
| `Label` | `@/components/ui/label` |
| `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton` | `@/components/ui/sidebar` |
| `useIsMobile` | `@/hooks/use-mobile` |
| `useAuthData` | `@/hooks/use-auth-data` |
| `useFetcher` | `react-router` |
| `useForm`, `getFormProps`, `getTextareaProps`, `getSelectProps` | `@conform-to/react` |
| `parseWithZod` | `@conform-to/zod` |
| `toast` | `sonner` |
| `Html`, `Head`, `Preview`, `Body`, `Container`, `Section`, `Text`, `Hr`, `Img` | `@react-email/components` |
| `render`, `toPlainText` | `@react-email/render` |

---

## Tests

### Unit Tests (Vitest)

All test files go in `tests/` following existing conventions. Run with `bun run test`.

#### 1. `tests/help-api.test.ts` — API Route

| Test | What it verifies |
|------|-----------------|
| `returns 401 for unauthenticated requests` | Route calls `requireAuthContext` and rejects without a valid session |
| `returns 400 when category is missing` | Zod validation rejects missing required fields |
| `returns 400 when description is empty` | Zod validation rejects empty description string |
| `returns 400 for invalid category value` | Zod enum rejects values outside the allowed set |
| `defaults severity to low when not provided` | Schema default works correctly |
| `returns success: true for valid submission` | Happy path — valid form data returns `{ success: true }` |
| `calls sendHelpConfirmationEmail with correct args` | Mock `sendHelpConfirmationEmail`, assert it's called with user email, category, severity, description |
| `calls sendHelpSupportEmail with correct args` | Mock `sendHelpSupportEmail`, assert it's called with all context fields (user, org, workspace, browser data) |
| `passes pageUrl and screenSize from form data` | Hidden fields are forwarded to the support email function |
| `passes User-Agent and Referer headers` | Request headers are extracted and included in support email args |

#### 2. `tests/help-email-templates.test.ts` — Email Templates

| Test | What it verifies |
|------|-----------------|
| `HelpConfirmationEmailTemplate renders without errors` | Template renders to HTML string without throwing |
| `confirmation email renders logo image with correct src` | Rendered HTML contains `<img>` with `src="{baseUrl}/camelAI-fullname-logo-lightmode.svg"` and `alt="camelAI"` |
| `confirmation email contains user's first name` | `firstName` prop appears in rendered output |
| `confirmation email contains category and severity` | Both fields appear in the summary box |
| `confirmation email truncates long descriptions` | Descriptions over 500 chars are truncated with "..." |
| `confirmation email shows full description when under 500 chars` | Short descriptions render in full |
| `HelpSupportEmailTemplate renders without errors` | Template renders to HTML string without throwing |
| `support email contains all WHO fields` | User name, email, and ID appear in rendered output |
| `support email contains all WHERE fields` | Org name, slug, ID, billing status, workspace name/ID, page URL appear |
| `support email contains all WHAT fields` | Category, severity, subject appear |
| `support email contains full description` | No truncation for support email |
| `support email contains all CONTEXT fields` | Submitted at, user-agent, screen size, referer appear |
| `support email handles null workspace gracefully` | When workspace is null, renders "N/A" or omits without error |
| `support email handles null userName gracefully` | When name is null, falls back to email or "Unknown" |
| `support email severity dot uses correct color` | High → red, Medium → yellow, Low → green in rendered HTML |

#### 3. `tests/help-email-delivery.test.ts` — Email Delivery Functions

| Test | What it verifies |
|------|-----------------|
| `sendHelpConfirmationEmail calls deliverEmail with correct subject` | Subject line matches expected format |
| `sendHelpConfirmationEmail sends to user email` | `to` field is the user's email address |
| `sendHelpConfirmationEmail passes baseUrl to template` | Logo image src is constructed with the provided baseUrl |
| `sendHelpSupportEmail calls deliverEmail with correct subject` | Subject includes severity, category, AI subject, user name, and org slug |
| `sendHelpSupportEmail sends to support email` | `to` field is `support@camelai.com` |
| `both functions produce valid HTML and plain text` | `render()` and `toPlainText()` succeed without errors |

#### 4. `tests/help-subject-generation.test.ts` — AI Subject Generation

| Test | What it verifies |
|------|-----------------|
| `generates subject from description` | AI binding is called with correct model and prompt, returns trimmed subject |
| `truncates subject to 100 characters` | Long AI responses are capped |
| `falls back to category label when AI returns empty` | Empty `response` falls back to category |
| `falls back to category label when AI call throws` | Network/API errors fall back gracefully |

### Component Tests (Vitest + jsdom)

#### 5. `tests/get-help-dialog.test.tsx` — Dialog Component

| Test | What it verifies |
|------|-----------------|
| `renders dialog when open is true` | Dialog content is in the DOM |
| `does not render when open is false` | Dialog content is not in the DOM |
| `renders category select with all options` | All 5 category options are present |
| `severity defaults to low` | Low toggle is selected on initial render |
| `submit button is disabled when description is empty` | Form validation prevents empty submissions |
| `submit button shows loading state while submitting` | Spinner + "Sending..." text appears during `fetcher.state !== 'idle'` |
| `calls onOpenChange(false) on cancel click` | Cancel button closes the dialog |
| `includes hidden pageUrl field` | Hidden input with `window.location.href` value is in the form |
| `includes hidden screenSize field` | Hidden input with viewport dimensions is in the form |

---

## Not in Scope

- File/screenshot attachments on the help form (future enhancement)
- Help request history or ticketing system
- In-app response/reply thread
- Rate limiting on the help endpoint (can add later if abused)
- Admin panel view of help requests
