# Invitation Page Implementation Feedback

## Summary

The invitation flow functionality works correctly. The core issues are **visual design** and a **post-accept refresh bug**. This document provides feedback for the implementing agent.

---

## Issue 1: UI Design Overhaul Required

### Current Problems

The current design has several visual issues:

1. **Awkward icon placement** - Small icon (Users/CheckCircle/XCircle) sits in the top-left corner of the card while content is centered. This creates visual imbalance.

2. **Button layout issues** - Accept and Decline buttons are small and positioned on opposite sides (`justify-between`), looking disconnected.

3. **Role badge is unnecessary** - Displaying the invited role ("Member", "Admin") looks odd and adds visual clutter. Remove it.

4. **Inconsistent state layouts** - Loading, error, success, and invitation states all have different visual structures.

### Design Requirements

All invitation page states should follow a **consistent, centered layout** inspired by the `login-03` shadcn block pattern:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│                    [Logo] Chiridion                     │  ← Logo centered above card
│                                                         │
│              ┌─────────────────────────┐                │
│              │                         │                │
│              │    You're invited to    │                │  ← Title centered
│              │       join [Org]        │                │  ← Org name as subtitle
│              │                         │                │
│              │   ┌─────────────────┐   │                │
│              │   │ Accept invitation│   │                │  ← Full-width primary button
│              │   └─────────────────┘   │                │
│              │   ┌─────────────────┐   │                │
│              │   │     Decline     │   │                │  ← Full-width outline button
│              │   └─────────────────┘   │                │
│              │                         │                │
│              └─────────────────────────┘                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Specific Changes Required

#### Remove from all states:
- The icon in the top-left corner of the card (`<div className="flex size-10 items-center justify-center rounded-full ...">`)
- The role display section (Badge showing "Member", "Admin", etc.)

#### Card structure for ALL states:

```tsx
<Card className="w-full">
  <CardHeader className="text-center">
    <CardTitle className="text-xl">{title}</CardTitle>
    <CardDescription>{description}</CardDescription>
  </CardHeader>
  <CardContent className="flex flex-col gap-3">
    {/* Buttons stacked vertically, full width */}
  </CardContent>
</Card>
```

#### State-specific content:

**1. Loading State:**
```tsx
<CardHeader className="text-center">
  <Skeleton className="mx-auto h-6 w-48" />
  <Skeleton className="mx-auto h-4 w-32" />
</CardHeader>
<CardContent className="flex flex-col gap-3">
  <Skeleton className="h-10 w-full" />
  <Skeleton className="h-10 w-full" />
</CardContent>
```

**2. Valid Invitation (logged out):**
```tsx
<CardHeader className="text-center">
  <CardTitle className="text-xl">You're invited to join</CardTitle>
  <CardDescription className="text-lg font-semibold text-foreground">
    {invitation.org.name}
  </CardDescription>
</CardHeader>
<CardContent>
  <Button asChild className="w-full" size="lg">
    <Link href={loginHref}>Sign in to accept</Link>
  </Button>
</CardContent>
```

**3. Valid Invitation (logged in):**
```tsx
<CardHeader className="text-center">
  <CardTitle className="text-xl">You're invited to join</CardTitle>
  <CardDescription className="text-lg font-semibold text-foreground">
    {invitation.org.name}
  </CardDescription>
</CardHeader>
<CardContent className="flex flex-col gap-3">
  <Button onClick={handleAccept} disabled={isBusy} className="w-full" size="lg">
    {isAccepting ? (
      <>
        <Loader2 className="size-4 animate-spin" />
        Accepting...
      </>
    ) : (
      'Accept invitation'
    )}
  </Button>
  <Button
    variant="outline"
    onClick={() => setDeclineOpen(true)}
    disabled={isBusy}
    className="w-full"
    size="lg"
  >
    Decline
  </Button>
</CardContent>
```

**4. Success State:**
```tsx
<CardHeader className="text-center">
  <CardTitle className="text-xl">Invitation accepted</CardTitle>
  <CardDescription>
    Redirecting to {invitation.org.name}...
  </CardDescription>
</CardHeader>
<CardContent className="flex justify-center">
  <Loader2 className="size-6 animate-spin text-muted-foreground" />
</CardContent>
```

**5. Error State:**
```tsx
<CardHeader className="text-center">
  <CardTitle className="text-xl">Invitation not found</CardTitle>
  <CardDescription className="text-balance">
    This invitation may have expired, the link may be incorrect, or it was sent to a different email address.
  </CardDescription>
</CardHeader>
<CardContent className="flex flex-col gap-3">
  <p className="text-center text-sm text-muted-foreground">
    Please contact the organization administrator for a new invitation.
  </p>
  <Button asChild className="w-full" size="lg">
    <Link href="/">Go home</Link>
  </Button>
</CardContent>
```

### Page wrapper structure

Use the `login-03` pattern with `bg-muted` background:

```tsx
<div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
  <div className="flex w-full max-w-sm flex-col gap-6">
    <Link href="/" className="flex items-center justify-center gap-2">
      <LogoIcon />
      <span className="text-lg font-semibold tracking-tight">Chiridion</span>
    </Link>
    <Card className="w-full">
      {/* Card content based on state */}
    </Card>
  </div>
</div>
```

### Visual Reference

The design should look similar to shadcn's `login-03` block but simpler (no form fields, just action buttons):
- Muted background (`bg-muted`)
- Logo centered above card
- Card with centered text content
- Full-width stacked buttons
- Clean, minimal aesthetic

---

## Issue 2: Workspace Switcher Not Updating After Accept

### Current Behavior

After accepting an invitation:
1. User is redirected to `/`
2. The workspace switcher shows only the user's previous workspaces
3. After a page refresh, the user is correctly switched to the new org's workspace

### Expected Behavior

After accepting an invitation, the workspace switcher should immediately show the new organization's workspace without requiring a manual page refresh.

### Root Cause

The redirect happens via `router.push('/')` which performs client-side navigation. The `AuthContext` likely has stale data and needs to be refreshed after the invitation is accepted.

### Fix Options

**Option A: Force full page reload (simplest)**

Change the redirect from client-side navigation to a full page reload:

```tsx
// In handleAccept success case, instead of:
setStatus('success');
// which then triggers router.push('/') after timeout

// Do a full reload:
setStatus('success');
setTimeout(() => {
  window.location.href = '/';
}, 1000);
```

**Option B: Refresh AuthContext after accept (better UX)**

If there's a `refreshUser()` or similar method in AuthContext, call it after accepting:

```tsx
const { user, loading: authLoading, refreshUser } = useAuth();

// After successful accept:
const response = await fetch(`/api/invitations/${orgId}/${invitationId}`, {
  method: 'POST',
});
if (response.ok) {
  await refreshUser?.(); // Refresh auth state
  setStatus('success');
}
```

Check `src/contexts/AuthContext.tsx` for available refresh methods.

**Option C: Use the response data to redirect to correct workspace**

The POST response includes the org and workspace data:
```json
{
  "success": true,
  "org": { "id": "...", "name": "..." },
  "workspace": { "id": "...", "name": "..." }
}
```

Use this to redirect directly to the new workspace's chat:
```tsx
const data = await response.json();
if (data.success && data.workspace) {
  window.location.href = `/chat/${data.workspace.id}`;
}
```

### Recommended Approach

Use **Option A** (full page reload) for now since it's simplest and guarantees fresh state. The 1-second delay before redirect already exists, so users won't notice the reload.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/app/invitations/[orgId]/[invitationId]/page.tsx` | Complete UI redesign + refresh fix |

---

## Testing Checklist

After implementing changes, verify:

- [ ] Loading state shows centered skeleton (no icon)
- [ ] Valid invitation (logged out) shows org name + "Sign in to accept" button
- [ ] Valid invitation (logged in) shows org name + Accept/Decline buttons stacked
- [ ] Success state shows centered message + spinner (no checkmark icon in corner)
- [ ] Error state shows centered message + "Go home" button (no error icon in corner)
- [ ] Role badge is NOT displayed anywhere
- [ ] Buttons are full-width and stacked vertically
- [ ] Page has `bg-muted` background
- [ ] Logo is centered above the card
- [ ] After accepting, user is redirected and sees the new workspace in switcher

---

## Summary of Required Changes

1. **Remove** the icon circles from all card states
2. **Remove** the role badge display
3. **Change** button layout to full-width stacked (not side-by-side)
4. **Add** `bg-muted` to page background
5. **Center** the logo above the card (not inside)
6. **Use** consistent CardHeader/CardContent structure across all states
7. **Fix** post-accept redirect to refresh workspace state (use `window.location.href` instead of `router.push`)
