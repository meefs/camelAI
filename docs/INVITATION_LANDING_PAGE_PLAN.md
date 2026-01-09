# Invitation Landing Page Implementation Plan

## Overview

This document specifies the requirements, UI/UX flows, and implementation details for the invitation landing page. This page allows invited users to view and accept/decline organization invitations.

**Route:** `/invitations/[orgId]/[invitationId]`

---

## Table of Contents

1. [Requirements](#requirements)
2. [Page States](#page-states)
3. [UI/UX Flows](#uiux-flows)
4. [Design Specifications](#design-specifications)
5. [shadcn Components](#shadcn-components)
6. [API Integration](#api-integration)
7. [Security Considerations](#security-considerations)
8. [File Structure](#file-structure)
9. [Testing Requirements](#testing-requirements)

---

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Page loads without authentication (public access) | Must |
| FR-2 | Display organization name and invited role | Must |
| FR-3 | Users can accept invitations | Must |
| FR-4 | Users can decline invitations | Must |
| FR-5 | Show generic error for invalid/expired/mismatched invitations | Must |
| FR-6 | Redirect unauthenticated users to login before accepting | Must |
| FR-7 | Redirect to org dashboard after successful acceptance | Must |
| FR-8 | Show confirmation dialog before declining | Should |
| FR-9 | Handle loading states gracefully | Must |

### Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-1 | Mobile-responsive design |
| NFR-2 | Consistent with login/signup page styling |
| NFR-3 | Accessible (proper ARIA labels, keyboard navigation) |
| NFR-4 | No information leakage (don't reveal invited email on error) |

---

## Page States

The page has the following distinct states:

### 1. Loading State
- **Trigger:** Initial page load while fetching invitation data
- **Display:** Skeleton placeholder for invitation card
- **Duration:** Until API response received

### 2. Valid Invitation (Unauthenticated)
- **Trigger:** Valid invitation exists, user not logged in
- **Display:** Invitation details + "Sign in to accept" CTA
- **Actions:** Links to login page with redirect back to invitation

### 3. Valid Invitation (Authenticated, Email Matches)
- **Trigger:** Valid invitation, user logged in with matching email
- **Display:** Invitation details + Accept/Decline buttons
- **Actions:** Accept or Decline invitation

### 4. Invalid Invitation (Generic Error)
- **Trigger:** Any of:
  - Invitation ID doesn't exist
  - Invitation has expired (auto-deleted)
  - User's email doesn't match invitation email
  - User is already a member of the org
- **Display:** Generic error message (see Error Messaging below)
- **Actions:** Link to home page

### 5. Accepting State
- **Trigger:** User clicked "Accept invitation"
- **Display:** Button shows loading spinner, disabled
- **Duration:** Until API response

### 6. Decline Confirmation
- **Trigger:** User clicked "Decline"
- **Display:** Confirmation dialog
- **Actions:** Confirm decline or cancel

### 7. Success State
- **Trigger:** Invitation accepted successfully
- **Display:** Brief success message, then redirect
- **Duration:** ~1 second before redirect to org

---

## UI/UX Flows

### Flow 1: New User Accepts Invitation

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Visit invite   │────▶│  See invitation │────▶│  Click "Sign in │
│     link        │     │    details      │     │   to accept"    │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
┌─────────────────┐     ┌─────────────────┐     ┌────────▼────────┐
│  Redirect to    │◀────│  Sign up with   │◀────│  Redirect to    │
│  invite page    │     │  invited email  │     │  /login?redirect│
└────────┬────────┘     └─────────────────┘     └─────────────────┘
         │
┌────────▼────────┐     ┌─────────────────┐
│ Click "Accept"  │────▶│  Redirect to    │
│                 │     │  org dashboard  │
└─────────────────┘     └─────────────────┘
```

### Flow 2: Existing User Accepts Invitation

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Visit invite   │────▶│  Already logged │────▶│  See invitation │
│  link (logged   │     │  in with right  │     │  + Accept/      │
│  in)            │     │  email          │     │  Decline        │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                        ┌─────────────────┐     ┌────────▼────────┐
                        │  Redirect to    │◀────│  Click "Accept" │
                        │  org dashboard  │     │                 │
                        └─────────────────┘     └─────────────────┘
```

### Flow 3: Email Mismatch / Invalid Invitation

```
┌─────────────────┐     ┌─────────────────┐
│  Visit invite   │────▶│  Generic error: │
│  link (wrong    │     │  "Invitation    │
│  email or       │     │   not found"    │
│  expired)       │     │                 │
└─────────────────┘     └─────────────────┘
```

### Flow 4: User Declines Invitation

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Click          │────▶│  Confirmation   │────▶│  Redirect to    │
│  "Decline"      │     │  dialog appears │     │  home page      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

---

## Design Specifications

### Layout

Use a **centered card layout** (simpler than login/signup split-screen since this is a single-action page):

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│                         [Chiridion Logo]                         │
│                                                                  │
│                    ┌────────────────────────┐                    │
│                    │                        │                    │
│                    │   You're invited to    │                    │
│                    │   join [Org Name]      │                    │
│                    │                        │                    │
│                    │   Role: Member         │                    │
│                    │                        │                    │
│                    │  ┌──────┐  ┌────────┐  │                    │
│                    │  │Decline│  │ Accept │  │                    │
│                    │  └──────┘  └────────┘  │                    │
│                    │                        │                    │
│                    └────────────────────────┘                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Error State Layout

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│                         [Chiridion Logo]                         │
│                                                                  │
│                    ┌────────────────────────┐                    │
│                    │                        │                    │
│                    │      [Error Icon]      │                    │
│                    │                        │                    │
│                    │  Invitation not found  │                    │
│                    │                        │                    │
│                    │  This invitation may   │                    │
│                    │  have expired or the   │                    │
│                    │  link is incorrect.    │                    │
│                    │                        │                    │
│                    │  Contact the org       │                    │
│                    │  administrator for a   │                    │
│                    │  new invitation.       │                    │
│                    │                        │                    │
│                    │     ┌───────────┐      │                    │
│                    │     │ Go home   │      │                    │
│                    │     └───────────┘      │                    │
│                    │                        │                    │
│                    └────────────────────────┘                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Visual Styling

| Element | Style |
|---------|-------|
| Background | Default page background (`bg-background`) |
| Card | Use `Card` component with subtle shadow |
| Logo | Use existing `LogoIcon` component |
| Org name | `text-xl font-semibold` |
| Role | Use `Badge` component with appropriate variant |
| Primary CTA (Accept) | `Button` default variant, full width on mobile |
| Secondary CTA (Decline) | `Button` outline variant |
| Error icon | `XCircle` from lucide-react, `text-destructive` |

### Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| Mobile (`< 640px`) | Card fills width with padding, buttons stack vertically |
| Tablet/Desktop (`>= 640px`) | Card max-width ~400px, buttons side-by-side |

---

## shadcn Components

### Required Components (Already Installed)

| Component | Usage |
|-----------|-------|
| `Card`, `CardContent`, `CardDescription`, `CardFooter`, `CardHeader`, `CardTitle` | Main invitation container |
| `Button` | Accept, Decline, Sign in, Go home actions |
| `Badge` | Display invited role |
| `Skeleton` | Loading state placeholder |
| `Alert`, `AlertDescription` | Error message display |
| `AlertDialog`, `AlertDialogAction`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle` | Decline confirmation dialog |

### Component from `@/components/ui/`

| Component | File | Usage |
|-----------|------|-------|
| `LogoIcon` | `logo.tsx` | Branding in header |
| `ConfirmDialog` | `confirm-dialog.tsx` | Could be used for decline confirmation (wrapper around AlertDialog) |

### Lucide Icons

| Icon | Usage |
|------|-------|
| `XCircle` | Error state icon |
| `Loader2` | Loading spinner in buttons |
| `CheckCircle` | Success state (optional) |
| `Users` | Visual element for invitation (optional) |

---

## API Integration

### Endpoints Used

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/invitations/[orgId]/[invitationId]` | GET | No | Fetch invitation details |
| `/api/invitations/[orgId]/[invitationId]` | POST | Yes | Accept invitation |
| `/api/orgs/[id]/invite` | DELETE | Yes | Decline/delete invitation |

### GET Response (Success)

```typescript
{
  email: string;      // Invited email (DO NOT display to user)
  role: OrgRole;      // "admin" | "member" | "viewer"
  org: {
    id: string;
    name: string;
  };
}
```

### GET Response (Not Found)

```
404 - { error: "Invitation not found or expired" }
```

### POST Response (Accept - Success)

```typescript
{
  success: true;
  org: { id: string; name: string; };
  workspace: { id: string; name: string; } | null;
}
```

### POST Response (Accept - Email Mismatch)

```
403 - { error: "This invitation was sent to X. Please log in with that email address." }
```

**Important:** The API currently returns the invited email in the 403 error. For security, the frontend should NOT display this to the user. Instead, show the generic error state.

### Decline Flow

Declining an invitation means deleting it. The user must be authenticated to decline.

```typescript
// DELETE /api/orgs/[orgId]/invite
{ invitation_id: string }
```

---

## Security Considerations

### Information Leakage Prevention

1. **Never display the invited email address** - even though the API returns it
2. **Use generic error messages** that don't reveal why the invitation failed
3. **Don't differentiate** between "expired", "wrong email", and "not found" states

### Generic Error Message

Use this single message for ALL error scenarios:

> **Invitation not found**
>
> This invitation may have expired, the link may be incorrect, or it may have been sent to a different email address.
>
> Please contact the organization administrator for a new invitation.

### Redirect Safety

When redirecting to login, use the existing `getSafeRedirect()` pattern from login page to prevent open redirect attacks:

```typescript
const redirectUrl = `/login?redirect=${encodeURIComponent(`/invitations/${orgId}/${invitationId}`)}`;
```

---

## File Structure

```
src/app/invitations/[orgId]/[invitationId]/
├── page.tsx              # Main page component
└── loading.tsx           # Optional: Loading UI (Next.js convention)
```

### Page Component Structure

```typescript
// page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
// ... other imports

interface InvitationData {
  role: OrgRole;
  org: {
    id: string;
    name: string;
  };
}

type PageState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'valid'; invitation: InvitationData }
  | { status: 'accepting' }
  | { status: 'success' };

export default function InvitationPage() {
  const params = useParams<{ orgId: string; invitationId: string }>();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [showDeclineDialog, setShowDeclineDialog] = useState(false);

  // Fetch invitation on mount
  useEffect(() => {
    fetchInvitation();
  }, [params.orgId, params.invitationId]);

  // ... implementation
}
```

---

## Testing Requirements

### Existing Test Coverage (Backend)

The following are already tested in `workers/main/tests/auth-do.test.ts`:

- [x] Create invitation
- [x] Persist invitations across requests
- [x] Retrieve invitation details
- [x] Accept invitation and add user to org
- [x] Delete invitation

### Existing Integration Tests

In `tests/integration/pages.test.ts`:

- [x] Invitation page loads without auth redirect (currently expects 200 or 404, not 307)

### New Tests Required

#### Unit Tests (`tests/invitation-page.test.tsx`)

| Test Case | Description |
|-----------|-------------|
| `renders loading state initially` | Shows skeleton while fetching |
| `renders valid invitation for unauthenticated user` | Shows invitation details + sign in CTA |
| `renders valid invitation for authenticated user` | Shows invitation details + Accept/Decline buttons |
| `renders error state for invalid invitation` | Shows generic error message |
| `renders error state for expired invitation` | Shows generic error message |
| `shows decline confirmation dialog` | Dialog appears when Decline clicked |
| `handles accept flow` | Calls API, shows loading, redirects on success |
| `handles decline flow` | Calls API, redirects after confirmation |
| `redirects to login with correct redirect param` | Sign in button has proper redirect URL |

#### Integration Tests (`tests/integration/invitation-page.test.ts`)

| Test Case | Description |
|-----------|-------------|
| `GET /invitations/:orgId/:invitationId returns 200 for valid invitation` | Page renders without redirect |
| `accepts invitation when logged in with matching email` | Full accept flow |
| `shows error when logged in with wrong email` | Email mismatch handling |
| `shows error for expired invitation` | Expiration handling |

#### E2E Tests (`e2e/invitation.spec.ts`)

| Test Case | Description |
|-----------|-------------|
| `full invitation accept flow - new user` | Visit link → sign up → accept → verify membership |
| `full invitation accept flow - existing user` | Visit link (logged in) → accept → verify membership |
| `decline invitation flow` | Visit link → decline → verify not a member |
| `invalid invitation shows error` | Visit bad link → see error state |

### Test Setup Helpers

Add to `tests/integration/test-utils.ts`:

```typescript
export async function createTestInvitation(
  orgId: string,
  email: string,
  role: OrgRole = 'member',
  sessionCookie: string
): Promise<{ id: string; expires_at: number }> {
  const response = await fetch(`${baseUrl}/api/orgs/${orgId}/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session=${sessionCookie}`,
    },
    body: JSON.stringify({ email, role }),
  });
  return response.json();
}
```

---

## Implementation Checklist

For the implementing agent:

- [ ] Create page component at `src/app/invitations/[orgId]/[invitationId]/page.tsx`
- [ ] Implement all page states (loading, valid-unauth, valid-auth, error, accepting, success)
- [ ] Add decline confirmation dialog
- [ ] Handle login redirect flow with proper redirect param
- [ ] Ensure error states don't leak information
- [ ] Make responsive for mobile
- [ ] Add unit tests
- [ ] Add integration tests
- [ ] Add E2E tests
- [ ] Test manually:
  - [ ] Create invitation via UI
  - [ ] Visit link while logged out
  - [ ] Sign in with correct email → accept
  - [ ] Visit link with wrong email logged in → see error
  - [ ] Decline flow
  - [ ] Expired invitation error

---

## Additional Recommendations

### 1. Copy Invite Link Feature

Consider adding a "Copy invite link" button in the team settings when viewing pending invitations. This would make it easier for admins to share links since email isn't implemented.

**Location:** `src/components/settings/team-table.tsx` - add to the dropdown menu for invited members.

### 2. Toast Notifications

Use `sonner` (already installed) to show toast notifications for:
- Successfully accepting invitation
- Error accepting invitation
- Successfully declining invitation

### 3. Success Animation

Consider a brief success state with a checkmark animation before redirecting, to give users feedback that their action completed.

### 4. Invitation Email Preview

When email is eventually implemented, the invitation landing page content can serve as a preview of what users will see. Keep the messaging consistent.

---

## Open Questions for Product

1. **After declining:** Should we redirect to home page or show a "you declined" confirmation page?
2. **Already a member:** If the user is already a member, should we show a different message or just redirect them to the org?
3. **Multiple pending invitations:** If a user has invitations to multiple orgs, should there be a way to see them all?

---

## References

- Existing login page: `src/app/login/page.tsx`
- Existing signup page: `src/app/signup/page.tsx`
- Invitation API routes: `src/app/api/invitations/[orgId]/[invitationId]/route.ts`
- Invite creation: `src/app/api/orgs/[id]/invite/route.ts`
- Auth context: `src/contexts/AuthContext.tsx`
- Team settings: `src/components/settings/team-table.tsx`
