# Admin Panel - Search & Invitations Plan

**Status:** Draft
**Date:** 2026-01-08
**Reference:** `ADMIN_PANEL_UPDATE_PLAN.md`

---

## Executive Summary

This document covers two enhancements to the admin panel:

1. **Search Bars** - Server-side search on every list page (Users, Organizations, Workspaces, Threads, Invitations)
2. **Invitations Tab** - New section to view and manage all invitations across organizations

---

## Table of Contents

1. [Search Bars](#search-bars)
2. [Invitations Tab](#invitations-tab)
3. [Implementation Phases](#implementation-phases)

---

## Search Bars

### Requirements

- **Server-side search** - Search must query the backend and return paginated results across the entire dataset (not just the current page)
- Search query should be reflected in the URL (e.g., `/qaml-backdoor/users?search=alice`) for shareability and browser history
- Search should reset pagination to page 1 when query changes
- Empty search returns all results (current behavior)
- Case-insensitive matching
- Partial string matching (e.g., "ali" matches "alice@example.com")

### Searchable Fields by Tab

| Tab | Searchable Fields |
|-----|-------------------|
| **Users** | `id`, `email`, `name` |
| **Organizations** | `id`, `name` |
| **Workspaces** | `id`, `name`, `org_name`, `description` |
| **Threads** | `id`, `title`, `org_name`, `workspace_name` |
| **Invitations** | `id`, `email`, `org_name` |

### Backend Changes

Add `search` parameter to `PaginationParams`:

```typescript
interface PaginationParams {
  offset?: number;
  limit?: number;
  search?: string;  // NEW
}
```

Update each `adminGet*Paginated` RPC method to accept and filter by the search parameter.

---

## Invitations Tab

### Requirements

- New sidebar nav item "Invitations" under Models
- Paginated list of all invitations across all organizations
- Server-side search (same as other tabs)
- Support for pagination

### Data Available

From `OrgDO.invitations` table per org:

| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT | Invitation UUID |
| `email` | TEXT | Invitee email address |
| `role` | TEXT | Invited role (admin/member/viewer - NOT owner) |
| `invited_by` | TEXT | User ID who sent invitation |
| `created_at` | INTEGER | Timestamp when created |
| `expires_at` | INTEGER | Timestamp when expires (7 days from created) |

**Note:** Invitations are deleted when accepted. The admin panel can only show pending and expired invitations. Accepted invitation history can be found in org audit logs (`member_added` events).

### Additional Data to Join/Compute

| Field | Source |
|-------|--------|
| `org_id` | Context (which OrgDO the invitation lives in) |
| `org_name` | Fetch from OrgDO |
| `inviter_email` | Join with UserDO |
| `inviter_name` | Join with UserDO |
| `status` | Computed: `expires_at > Date.now() ? 'pending' : 'expired'` |

### Columns to Display

| Column | Description |
|--------|-------------|
| Email | Invitee email address |
| Organization | Org name (link to org detail) |
| Role | Invited role badge |
| Invited By | Inviter name or email (link to user detail) |
| Status | Pending / Expired badge |
| Created | When invitation was sent |
| Expires | When invitation expires (show relative time like "5d 12h remaining" or "Expired 2d ago") |
| Actions | Copy invitation link, Delete |

### Invitation Link Format

```
{APP_URL}/invitations/{orgId}/{invitationId}
```

### Actions

1. **Copy Link** - Copy invitation URL to clipboard
2. **Delete** - Remove invitation (requires confirmation)

### Backend Requirements

New RPC method needed:

```typescript
adminGetInvitationsPaginated(params: PaginationParams): Promise<PaginatedResult<AdminInvitation>>
```

This needs to:
1. Iterate through all orgs
2. Fetch invitations from each OrgDO
3. Join with org info and inviter user info
4. Apply search filter if provided
5. Sort by `created_at` descending
6. Apply pagination

### New Type

```typescript
export interface AdminInvitation {
  id: string;
  email: string;
  role: OrgRole;
  org_id: string;
  org_name: string;
  invited_by: string;
  inviter_email: string;
  inviter_name: string | null;
  created_at: number;
  expires_at: number;
}
```

---

## Implementation Phases

### Phase 1: Server-Side Search

Add search to all existing admin list pages:
- Users
- Organizations
- Workspaces
- Threads

### Phase 2: Invitations Tab

Add new Invitations section with:
- Sidebar nav item
- Paginated list page
- Server-side search
- Copy link and delete actions

---

## Success Criteria

### Search
- [ ] All list pages have a search input
- [ ] Search queries the backend (not client-side filtering)
- [ ] Search works across entire dataset, not just current page
- [ ] Search query reflected in URL
- [ ] Pagination resets when search changes

### Invitations Tab
- [ ] Invitations nav item appears in sidebar
- [ ] Lists all invitations across all orgs
- [ ] Shows correct status (pending vs expired)
- [ ] Shows time remaining or time since expiration
- [ ] Copy link works
- [ ] Delete action works with confirmation
- [ ] Search works

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-01-08 | 1.0 | Initial draft |
| 2026-01-08 | 1.1 | Switched to server-side search, simplified implementation details |
