# Workspace UI/UX Plan

**Status:** Phase 1 - Flow Inventory
**Date:** 2026-01-07
**Reference:** `WORKSPACE_ORG_SCHEMA_PLAN.md`, `WORKSPACE_IMPLEMENTATION_FEEDBACK.md`

---

## Overview

This document captures all user flows required to support the new workspace architecture. The backend changes introduce:

- **Organizations** with multiple workspaces
- **Workspaces** as the unit of compute (each has its own container, threads, connections)
- **Role-based access** at org level (owner, admin, member, viewer)
- **Permission-based access** at workspace level (full, read_only, none)
- **Avatars** for users and workspaces
- **Audit logging** for org and workspace changes

---

## Flow Inventory by Activity

### 1. Authentication & Onboarding

| Flow | Description | Notes |
|------|-------------|-------|
| **Sign up** | Create account → auto-creates default org + default workspace → land in chat | New users get `{name}'s Organization` with `Default Workspace` |
| **Log in** | Authenticate → restore last org/workspace → land in chat | Uses `last_workspace_id` per org |
| **Log in (orphaned user)** | Authenticate → detect orphan state → auto-create org/workspace → land in chat | User was removed from all orgs |
| **Log out** | Clear session → redirect to login | |
| **Accept invitation (existing user)** | Click invite link → authenticate → join org → land in org | If orphaned, clears orphan status |
| **Accept invitation (new user)** | Click invite link → sign up → join org → land in org | Role determined by invitation |

---

### 2. Organization Management

| Flow | Description | Required Role |
|------|-------------|---------------|
| **View org list** | See all orgs user belongs to | Any |
| **Switch organization** | Select different org → load that org's last-used workspace | Any |
| **Create organization** | Create new org → become owner → auto-create default workspace | Any |
| **Edit organization** | Change org name | Admin+ |
| **Archive organization** | Soft-delete org and all workspaces | Owner (sole member only) |
| **View org audit log** | See history of org-level changes | Admin+ |

REVIEWER FEEDBACK: A note on switching organizations, The main thing a user will switch between between will actually be the workspaces, not orgs. Users will be able to switch between workspaces easily in the workspace switcher component that is available in the side nav. I do think we should still show the lists of works that a user is currently a part of in the settings page, perhaps under org settings.  As for view org audit logs, let's call that out of scope for now. 

---


### 3. Organization Membership

| Flow | Description | Required Role |
|------|-------------|---------------|
| **View members** | See list of all org members with roles | Any |
| **Invite member** | Send invitation email with role selection | Admin+ |
| **Cancel invitation** | Revoke pending invitation | Admin+ |
| **Change member role** | Update member's org role (admin/member/viewer) | Admin+ (owner to change to owner) |
| **Remove member** | Kick member from org | Admin+ |
| **Leave organization** | Remove self from org | Member+ (owner blocked) |
| **Transfer ownership** | Give owner role to another member → old owner becomes admin | Owner only |

REVIEWER FEEDBACK: This is great. no notes on the flows you've captured here. I just want to highlight that I think this should be within the settings page. 

---

### 4. Workspace Management

| Flow | Description | Required Role |
|------|-------------|---------------|
| **View workspace list** | See all accessible workspaces in current org | Any (filtered by access) |
| **Switch workspace** | Select different workspace → updates session → load that workspace | Has access |
| **Create workspace** | Create new workspace in current org | Admin+ |
| **Edit workspace** | Change name, description, avatar | Admin+ |
| **Archive workspace** | Soft-delete workspace (preserves data) | Admin+ |
| **View workspace audit log** | See history of workspace-level changes | Admin+ |

REVIEWER FEEDBACK: This is also great. I just want to highlight that the workspace list will be in the workspace switcher of the side nav. it could be worth it to have it listed in two places like one on the workspace switcher where it's just casual, quick, easy switch between your workspaces, and then one in the actual settings where they can do more powerful things like create, edit, archive, that type of stuff. Another point to note, let's consider the audit logs out of scope for this first pass. 

---

### 5. Workspace Access Control

| Flow | Description | Required Role |
|------|-------------|---------------|
| **View workspace members** | See list of org members with their access levels | Admin+ |
| **Restrict member access** | Set member to `read_only` or `none` | Admin+ |
| **Restore member access** | Reset member to default (`full`) access | Admin+ |
| **View own access level** | See what access level you have for current workspace | Any |

**Access Level Behaviors:**
- `full` - Can read/write, send messages, modify files
- `read_only` - Can view threads and files, cannot send messages or modify
- `none` - Workspace hidden from user's list, direct access returns 404

REVIEWER FEEDBACK: can we combine between workspace access control with organization membership? I feel like these two screens could be combined pretty easily. like when you add people to a team you can also choose which workspaces they have access to. I'm imagining a table and one of the fields you can like have sort of like a multi-select or multi-tab. Don't let my imaginings inform your design if you have a cleaner design decision in mind. 

---

### 6. Connections (Workspace-Scoped)

| Flow | Description | Required Role |
|------|-------------|---------------|
| **View connections** | See list of integrations in current workspace | Has workspace access |
| **Add connection** | Configure new integration (API key, OAuth, etc.) | Admin+ |
| **Edit connection** | Update connection settings or credentials | Admin+ |
| **Enable/disable connection** | Toggle connection availability to agent | Admin+ |
| **Delete connection** | Remove connection from workspace | Admin+ |

REVIEWER FEEDBACK: I like this. Um. Um, we already have a connections tab. What are you thinking? Like, do you think it's worth having connections repeated again in the settings page? or do you think we should just let this happen on the connections tab and sort of like restrict what people see based off of their role (member versus admin+). 

---

### 7. User Profile & Settings

| Flow | Description | Notes |
|------|-------------|-------|
| **View profile** | See own user info (name, email, avatar) | |
| **Edit profile** | Change name | |
| **Edit avatar** | Change avatar color and content (initials or emoji) | |
| **View org memberships** | See all orgs user belongs to with roles | Same as org list |

REVIEWER FEEDBACK: For view org membership, does this need to be in a separate place or can we design like the organization membership to encompass workspaces and user too? unless you are an admin to the org, really all you need to see is that you are in an org, which you already see from the workspaces you have access to. you don't necessarily need to see your role, unless you're an admin+ and are actively managing that.

---

### 8. Chat & Computer (Core Product)

These flows are largely unchanged but now operate within workspace context:

| Flow | Description | Notes |
|------|-------------|-------|
| **View threads** | List threads in current workspace | Scoped to workspace |
| **Create thread** | Start new chat thread | Scoped to workspace |
| **Send message** | Chat with agent | WebSocket now connects to workspace container |
| **View thread** | Read thread history | |
| **Delete thread** | Remove thread | |
| **View computer** | File browser for workspace container | Scoped to workspace |
| **Create/edit files** | File operations via agent | Scoped to workspace |
| **Publish app** | Make file accessible via URL | Future feature |

REVIEWER FEEDBACK: As you mentioned, these flows really aren't changed. I think we should skip this for our UI design phase. 

---

### 9. Edge Case & Error Flows

| Flow | Trigger | Behavior |
|------|---------|----------|
| **Orphaned user login** | User has no org memberships | Auto-create new org + workspace, land in chat |
| **Archived workspace in session** | Workspace was archived while user had it selected | Clear workspace from session, redirect to workspace picker |
| **No workspace selected** | Session has null workspace_id | Prompt user to select or create workspace |
| **Access denied to workspace** | User tries to access workspace with `none` permission | 404 (not 403, to hide existence) |
| **Owner tries to leave** | Owner attempts to leave or be removed | Block with error, prompt to transfer ownership |
| **Last admin leaves** | Would leave org with no admins | ??? (need to determine policy) |

REVIEWER FEEDBACK: For the archived workspace in session, we should probably throw an error page as opposed to just immediately redirecting. Also the workspace picker is not going to be a page, So we shouldn't redirect there. The owner should have admin access. So you're saying last admin leaves would be the org with no admins. the owner would be the admin.

---

## Logical Groupings for UI

Based on the flows above, here are natural groupings for the UI:

### Group A: Global Navigation
- Org switcher (view/switch orgs)
- Workspace switcher (view/switch workspaces)
- User menu (profile, logout)

REVIEWER FEEDBACK: In terms of global navigation, no org switcher. We just have a workspace switcher and you can see your org list within the settings page. Same with user menu. We should have just a very robust settings page where we cover org level settings and workspace level settings and user level settings, all within that settings page, as opposed to some sort of like global navigation between these things. and the link to the settings page should be in the user menu. So when a user clicks on their avatar in the side nav, that little pop-up menu should have the option of settings and logout. 

### Group B: Settings - User
- Profile editing (name, avatar)
- Account settings (future: password change, 2FA)

### Group C: Settings - Organization
- Org info (name)
- Members list
- Invitations (pending, send new)
- Ownership transfer
- Archive org
- Org audit log

REVIEWER FEEDBACK: Again, let's remove the org audit log for now. So within organization settings, The way that I view this is is settings page will have a side nav. in the side nav, we'll have different categories with tabs under each category. So the side nav will have user settings and the tab will be profile editing account settings. than within organization. they will have org info then members lists invitations um well yeah Yeah, I think members list, invitations, org transfer, those should all be in one tab. So I'm envisioning a table where you can see everybody who's a part of the current org you are in. As a user, like as an admin, you can manage invitations add new people remove people and also see which workspaces each member has access to and which type of access (edit, read only, none). then we have a third tab for organization settings. that's some name that implies more serious settings, and that's where the owner can transfer ownership. Perhaps we still show that tab to admins, but the ownership transfer button is disabled unless they are the owner. and we should also have a delete button and that delete should be disabled unless they were the owner. Also something we haven't touched on at all yet, at the org level, I want to introduce something called domains. Domains will be where users can configure a custom domain to host their projects on. for now we should not have anything there we haven't built anything out around this but I I want it to be grouped at the organization level. 

### Group D: Settings - Workspace
- Workspace info (name, description, avatar)
- Member access control
- Connections/integrations
- Archive workspace
- Workspace audit log

REVIEWER FEEDBACK: So I have similar feedback here. I like the workspace info. for member access control, I believe that should be at the org level, not at the workspace level for the connections/integrations. I like the idea of this tab, but please consider the feedback I gave earlier. Do you think it makes sense to have this in two places or do you think we should just just lean into the connections tab being its own thing outside of settings. And then as for archive workspace, I don't want that to be its own unique tab. we should call it something else and then archive workspace is an option within that and only admins have access to that. Also again, audit logs are out of scope for now. 

### Group E: Main App
- Thread list (sidebar)
- Chat interface
- Computer/file browser

REVIEWER FEEDBACK: So do not make changes to things that aren't covered in the scope of these changes. So first off, no thread list in the sidebar. There isn't one already. I do not want to add one. chat interface and the computer tabs do not change at all please 

---

## Open Questions

1. **Where should workspace switcher live?** In sidebar header? In a dropdown with org switcher? 
REVIEWER FEEDBACK: The workspace switcher should live where it lives now in the sidebar header. I want to have the org that the workspace belongs to listed in like a little bubble or like a little tag in that workspace switcher list. 

2. **How to handle "no workspace selected" state?** Modal? Dedicated page? Auto-select default?
REVIEWER FEEDBACK: this is something that should never happen. happen, they should default to a workspace. They should not be able to have no workspace selected. we should send them to their most recently use workspace if they're in this state or error out and give them a button to create a workspace. 

3. **Should workspace list show access level indicator?** e.g., read-only badge on restricted workspaces
REVIEWER FEEDBACK: Yes. Yes. wherever we list the workspace, we should also highlight anything the user might not already be aware of, like if they are read-only. 

4. **How to surface audit logs?** Inline in settings? Separate "Activity" tab? Filterable?
REVIEWER FEEDBACK: Let's call audit logs out of scope. 

5. **Settings page structure:** Single page with tabs/sections? Or separate routes per category?
REVIEWER FEEDBACK: the settings page layout have a super low key side nav. it shouldn’t have a container around it or anything. I'd like the side nav organized into groups groups with headers on the groups. definitely make sure you use the components library here. 

6. **Viewer role restrictions:** When app publishing ships, viewers need a different experience. Plan for this?
REVIEWER FEEDBACK: Please consider this out of scope. publishing apps has not been done at all yet. and we will work on this later. 

7. **Empty states:** What to show when org has no workspaces? When workspace has no threads?
REVIEWER FEEDBACK: When an org has no workspaces, this should not happen. we should block the delete of the last workspace. there should always be at least one workspace. When a workspace has no threads, that's no big deal. we handle that well already. the chat history is in its empty state, no big deal

8. **Mobile considerations:** Any flows that need special mobile treatment?
REVIEWER FEEDBACK: No, as long as you use our components library, mobile should be handled pretty gracefully. will comb over things to ensure they work well for mobile at a later date. 

---

## Summary Statistics

| Category | Flow Count |
|----------|------------|
| Authentication & Onboarding | 6 |
| Organization Management | 6 |
| Organization Membership | 7 |
| Workspace Management | 6 |
| Workspace Access Control | 4 |
| Connections | 5 |
| User Profile | 4 |
| Chat & Computer | 7 |
| Edge Cases | 5+ |
| **Total** | **~50 flows** |

---

## Next Steps

After Phase 1 review:
- Phase 2: Information architecture and navigation design
- Phase 3: Wireframes for key flows
- Phase 4: Component inventory and design system alignment
- Phase 5: Implementation plan with priorities

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-01-07 | 1.0 | Initial flow inventory (Phase 1) |
| 2026-01-07 | 1.1 | Initial flow inventory Review with notes added by Illiana (Phase 1) |
