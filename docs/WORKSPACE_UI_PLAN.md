# Workspace UI/UX Plan

**Status:** Phase 1 Complete - Ready for Phase 2
**Date:** 2026-01-07
**Reference:** `WORKSPACE_ORG_SCHEMA_PLAN.md`, `WORKSPACE_IMPLEMENTATION_FEEDBACK.md`

---

## Overview

This document defines the UI/UX changes required to support the new workspace architecture. The scope is focused on:

- **Settings page** - New page for user, organization, and workspace management
- **Workspace switcher** - Enhanced to show org context and access levels
- **User menu** - Avatar dropdown with Settings and Logout

### Out of Scope
- Audit logs (org and workspace level)
- Viewer role restrictions (deferred until app publishing)
- Chat & Computer UI (unchanged)
- Connections in Settings (stays in existing Connections tab with role-based visibility)

---

## Navigation Model

### Workspace Switcher (Sidebar Header)
The primary navigation mechanism. Users switch between workspaces, not orgs.

**Enhancements needed:**
- Show **org name as a tag/bubble** next to each workspace
- Show **access level badge** for read-only workspaces
- Workspaces with `none` access are hidden from list

### User Menu (Avatar Click)
Dropdown menu from avatar in sidebar.

**Options:**
- Settings → navigates to `/settings`
- Logout → clears session, redirects to login

---

## Settings Page Structure

**Route:** `/settings` (with tab navigation via URL params or nested routes)

**Layout:** Side nav on left, content area on right. Side nav is minimal (no container/border), organized into groups with headers.

### Side Nav Structure

```
USER
├── Profile

ORGANIZATION
├── General
├── Team
├── Domains (placeholder)
├── Danger Zone

WORKSPACE
├── General
├── Danger Zone
```

---

## Settings Tabs - Detailed Specifications

### USER > Profile

**Purpose:** View and edit personal account information

**Flows:**
| Flow | Description |
|------|-------------|
| View profile | See name, email, avatar |
| Edit name | Update display name |
| Edit avatar | Change color and content (initials or emoji) |

**Future (not this pass):** Password change, 2FA

---

### ORGANIZATION > General

**Purpose:** View and edit organization info

**Flows:**
| Flow | Description | Required Role |
|------|-------------|---------------|
| View org info | See org name | Any |
| Edit org name | Change organization name | Admin+ |

**Notes:**
- Shows the org that the current workspace belongs to
- Non-admins see read-only view

---

### ORGANIZATION > Team

**Purpose:** Manage org members, invitations, and workspace access

**Flows:**
| Flow | Description | Required Role |
|------|-------------|---------------|
| View members | See all org members with roles | Any |
| View pending invitations | See outstanding invites | Admin+ |
| Invite member | Send invitation with role selection | Admin+ |
| Cancel invitation | Revoke pending invite | Admin+ |
| Change member role | Update role (admin/member/viewer) | Admin+ |
| Remove member | Kick member from org | Admin+ |
| Leave organization | Remove self (owner blocked) | Member+ |
| Set workspace access | Configure which workspaces each member can access | Admin+ |

**UI Concept:**
- Table with columns: Name, Email, Role, Workspace Access, Actions
- Invite button opens modal/dialog for new invitations
- Pending invitations shown in same table or as separate section above

**Workspace Access Column - Tag-Based UX:**

By default, members have access to ALL workspaces. Each workspace they can access appears as a tag.

```
Default (not hovered):
[Workspace A] [Workspace B] [+ Add]

Hovered on a tag:
[Workspace A  ✏️  ×]
              ↑   ↑
           toggle  remove
```

**Tag interactions:**
- **Hover** reveals two icons: pencil (toggle) and X (remove)
- **Click pencil** → toggles between full access and read-only
- **Click X** → removes access entirely (tag disappears)
- **Click "+ Add"** → dropdown of workspaces they don't have access to, click to grant full access

**Pencil icon states:**
- **Solid pencil** = full access (can edit)
- **Crossed-out or muted pencil** = read-only (view only)

**Tag visual states:**
- **Solid/normal tag** = full access
- **Muted/outlined tag** = read-only (visible even without hovering)

**Access Level Reference:**
- `full` - Can read/write, send messages, modify files
- `read_only` - Can view threads and files, cannot modify
- `none` - Workspace hidden from user's list entirely

---

### ORGANIZATION > Domains

**Purpose:** Configure custom domains for hosting projects

**Status:** Placeholder - backend not implemented yet

**UI:** Empty state with message like "Custom domains coming soon" or similar

---

### ORGANIZATION > Danger Zone

**Purpose:** Sensitive org-level operations

**Flows:**
| Flow | Description | Required Role |
|------|-------------|---------------|
| Transfer ownership | Give owner role to another member | Owner only |
| Delete organization | Permanently delete org and all workspaces | Owner only |

**UI Concept:**
- Visually distinct section (red border or warning styling)
- Transfer ownership: Dropdown to select new owner + confirm button
- Delete org: Button with confirmation dialog (requires typing org name)
- Both actions disabled (greyed out) for non-owners with tooltip explaining why

---

### WORKSPACE > General

**Purpose:** View and edit current workspace info

**Flows:**
| Flow | Description | Required Role |
|------|-------------|---------------|
| View workspace info | See name, description, avatar | Any |
| Edit workspace | Change name, description, avatar | Admin+ |
| Create workspace | Create new workspace in org | Admin+ |

**Notes:**
- Shows info for the currently selected workspace
- Option to create new workspace (perhaps a button that opens a modal)
- Non-admins see read-only view

---

### WORKSPACE > Danger Zone

**Purpose:** Sensitive workspace-level operations

**Flows:**
| Flow | Description | Required Role |
|------|-------------|---------------|
| Archive workspace | Soft-delete workspace (preserves data) | Admin+ |

**Constraints:**
- Cannot archive the last workspace in an org
- Archived workspaces are hidden but data preserved

**UI Concept:**
- Similar styling to org danger zone
- Archive button with confirmation dialog
- Disabled if this is the only workspace

---

## Connections (Existing Tab - Not in Settings)

Connections remain in the existing Connections tab. No duplication in Settings.

**Role-based behavior:**
| Role | Can View | Can Add/Edit/Delete |
|------|----------|---------------------|
| Member | ✅ | ❌ |
| Admin+ | ✅ | ✅ |

**UI changes needed:**
- Hide add/edit/delete controls for non-admins
- Show read-only list of connections for members

---

## Edge Cases & Error Handling

| Scenario | Behavior |
|----------|----------|
| **Orphaned user login** | Auto-create new org + workspace, land in chat |
| **Archived workspace in session** | Show error page explaining workspace was archived, with button to select another workspace |
| **No workspace selected** | Should never happen; default to most recent workspace. If none exists, show error with "Create Workspace" button |
| **Access denied to workspace** | Return 404 (not 403) to hide existence |
| **Owner tries to leave** | Block with error, prompt to transfer ownership first |
| **Last workspace deletion** | Block - every org must have at least one workspace |

---

## Authentication Flows (Unchanged but Documented)

| Flow | Behavior |
|------|----------|
| **Sign up** | Create account → auto-create default org + workspace → land in chat |
| **Log in** | Authenticate → restore last org/workspace → land in chat |
| **Log in (orphaned)** | Authenticate → detect orphan → auto-create org/workspace → land in chat |
| **Log out** | Clear session → redirect to login |
| **Accept invitation (existing user)** | Authenticate → join org → land in org's default workspace |
| **Accept invitation (new user)** | Sign up → join org → land in org's default workspace |

---

## Summary of UI Components Needed

| Area | New/Modified | Description |
|------|--------------|-------------|
| Settings Page | New | Full settings page with side nav |
| Settings Side Nav | New | Grouped navigation component |
| Profile Tab | New | User profile editing form |
| Org General Tab | New | Org info display/edit |
| Team Tab | New | Members table with workspace access |
| Domains Tab | New | Placeholder empty state |
| Org Danger Zone | New | Transfer ownership, delete org |
| Workspace General Tab | New | Workspace info display/edit |
| Workspace Danger Zone | New | Archive workspace |
| User Menu | Modified | Add Settings link to avatar dropdown |
| Workspace Switcher | Modified | Add org tags, access level badges |
| Connections Tab | Modified | Role-based visibility for controls |
| Error Page (Archived WS) | New | Error state for archived workspace |

---

## Next Steps (Phase 2)

Phase 2 will detail:
1. Specific shadcn/ui components to use for each element
2. Layout specifications (spacing, responsive behavior)
3. Component composition patterns
4. Form validation and error states
5. Loading states
6. Implementation order/priorities

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-01-07 | 1.0 | Initial flow inventory |
| 2026-01-07 | 1.1 | Added reviewer feedback |
| 2026-01-07 | 2.0 | Revised plan incorporating all feedback |
| 2026-01-07 | 2.1 | Refined workspace access UX with tag-based hover interactions |
