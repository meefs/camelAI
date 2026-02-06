# Team & Org Feature Remediation Plan

This plan addresses features that were designed and partially built during the original team/org migration but are currently broken, incomplete, or missing entirely. The features below were all discussed and agreed upon — they just need to be finished or fixed.

---

## Part 1: Feature Remediation

### 1. Defer Viewer Role (Do Not Implement Yet)

The `viewer` role exists in the type system but should **not** be enforced or selectable in this round. Instead:

- **Comment out** the `viewer` option from the role selector in the invite dialog and any role-editing UI. It should not appear as a choice for admins right now.
- **Keep** `'viewer'` in the `OrgRole` type definition — don't remove it from the backend.
- **Add a `TODO` block** in the following locations documenting the planned viewer behavior:
  - `src/types.ts` near the `OrgRole` type
  - `src/components/settings/invite-member-dialog.tsx` near the role options
  - `src/components/settings/team-table.tsx` near the role dropdown
  - Any route guard files (e.g., `src/lib/auth.server.ts`) where role checks happen

The TODO should document the following planned behavior:

> **Viewer role (deferred):** Members with viewer access can view any apps that are private to the workspace, including apps that are not published publicly. This is designed for enterprise use cases where a company wants to share internal apps within the org without making them public. Viewers can view apps but cannot: create apps, use chat, access the computer tab, manage team settings, or perform any write operations. They are read-only consumers of workspace output.

---

### 2. Role Descriptions in Role Selector

When an admin assigns or edits a member's role, the UI should show a brief description of what each role means. Add a one-line description below or beside each role option in both the invite dialog and the role-editing dropdown on the team page.

The descriptions:

- **Owner** — "Full access to everything. Only the owner can transfer ownership. One per org."
- **Admin** — "Full access to everything. Can manage team members, workspaces, and all settings."
- **Member** — "Can access assigned workspaces — chat, apps, computer, and connections. Cannot manage the team or org settings."

Note: the owner's only exclusive privilege over admins is transferring ownership. Admins can do everything else (invite/remove members, change roles, create workspaces, manage connections, etc.). Org deletion is superuser-only via the admin panel — neither owners nor admins can do it from the regular UI. There is exactly one owner per org; if the owner is removed, the system auto-promotes the oldest admin.

The "Owner" role should not be selectable when inviting or editing — it's only assignable through the ownership transfer flow. It should still appear as a label on the owner's row in the team table though, with its description visible if the admin hovers or inspects it.

---

### 3. Workspace Access Management on Team Page

Admins should be able to control which workspaces each member can access. Members without access to a workspace should not know it exists.

**Desired behavior:**
- On the team settings page, an admin can see and edit which workspaces each member has access to
- The workspace access tags component (already built) should be populated with real data
- `canManageMembers` should reflect the current user's actual role (owner/admin = true, otherwise false)

**Current state:**
- The backend is fully implemented (WorkspaceDO members table, get/set access, filtered workspace lists)
- The `WorkspaceAccessTags` component is built and functional
- But the team page loader never fetches workspace data — it has:
  ```typescript
  const workspaces: never[] = [];  // TODO: Get workspaces from loader
  const canManageMembers = true;   // TODO: Calculate based on user's role
  ```
- So the workspace access UI renders empty and the edit mode is non-functional and non-accessible on the front end (edit button is no longer shown in the UI)
- All users see admin controls regardless of their role

---

### 4. Default Workspace Access Grants

When a new member joins an org or a new workspace is created, members should automatically have full access to all workspaces by default.

**Desired behavior:**
- When a member joins an org (invitation accepted), they receive `full` access to all existing non-archived workspaces
- When a new workspace is created, all existing org members receive `full` access to it
- This is the default — admins can then restrict access afterward

**Current state:**
- No code grants access on member join or workspace creation
- New members may end up with `none` access to all workspaces
- The system implicitly falls back to `full` in some code paths but this is inconsistent and unreliable

---

### 5. Archived Workspace Query Filtering

Archived workspaces should not appear in standard queries. They should only be visible in admin contexts.

**Desired behavior:**
- `OrgDO.getWorkspaces()` should exclude archived workspaces by default (add a parameter like `includeArchived` for admin use)
- Archived workspaces should only be visible in the admin panel
- Any other raw workspace queries should also respect the archived flag

**Current state:**
- Archive fields exist (`archived`, `archived_at`, `archived_by`) on Workspace and Org
- `OrgDO.getWorkspaces()` has no `WHERE archived = 0` clause — it returns everything
- Filtering happens inconsistently at the helper level in `listOrgWorkspaces()`

---

### 6. Workspace Archive Cleanup

After archiving a workspace, the server should handle session reassignment so the user doesn't end up on a broken page. Note: orgs with zero workspaces are a valid state — we already have an empty-state screen for that.

**Desired behavior:**
- After archiving a workspace, if it was the user's active workspace, the server should reassign them to another workspace (or null if none remain). Don't rely solely on client-side fallback.
- If a user's session points to an archived workspace on page load, the server should gracefully redirect them to a valid workspace or the empty state.

**Current state:**
- The `WorkspacesList` component detects current-workspace archival and switches client-side, which works in the happy path
- No server-side validation — stale sessions pointing to archived workspaces are only caught by a fragile `workspaces[0]` fallback in `getAuthContext()`

---

### 7. Billing Status Display

The billing status should be read from the org data instead of hardcoded.

**Desired behavior:**
- The org memberships list should show the actual `billing_status` from each org
- The billing settings placeholder page should display the org's current billing status (free or paying)

**Current state:**
- `BillingStatus = 'free' | 'paying'` exists in types, stored in OrgDO
- The org memberships list hardcodes `billing_status: 'free' as const` instead of reading from org data
- The billing settings page says "coming soon" but doesn't even show the current status

---

### 8. Team Management Permission Gating

Only owners and admins should see team management controls.

**Desired behavior:**
- `canManageMembers` should be calculated from the current user's org role
- Members should see the team list but not invite/remove/role-edit controls
- The workspace list's "Create workspace" button should also be gated to admins/owners

**Current state:**
- `canManageMembers = true` is hardcoded on the team page
- `canManage = true` is hardcoded on the workspaces page
- All authenticated users see all admin controls (backend rejects unauthorized changes, but UI doesn't reflect permissions)

---

### 9. Connection Duplication Across Workspaces

An org admin should be able to duplicate a connection from one workspace to another workspace within the same org. They should not be able to duplicate to a workspace outside the org.

This needs both a backend API and a UI trigger. The most natural place for the UI is probably in the workspace connections settings — a "Copy to workspace" action on each connection.

---

### 10. Proactive Orphan Handling on Member Removal

When a user is kicked from an org, the system should detect if they have no remaining orgs and mark them as orphaned immediately — not wait until their next login.

**Desired behavior:**
- After `removeOrgMember()`, check if the user has zero remaining orgs
- If so, call `setOrphaned()` on the UserDO right then
- On next login, the existing `handleOrphanedUserLogin()` flow already creates a new org for them

**Current state:**
- `removeOrgMember()` does not call `setOrphaned()`
- Orphan detection only happens at login time via `checkUserOrphaned()`
- A removed user's session stays valid until it expires — they could see errors in the UI before being properly orphaned

---

### 11. Owner Transfer UI in Settings

The backend action handler for `transferOrgOwnership` already exists in the team settings route (intent `transferOrgOwnership`), but there is no UI that triggers it. The team-table component has zero references to "transfer" — no button, no menu item, no dialog.

**Desired behavior:**
- On the team page, the owner should see a "Transfer ownership" option for any admin or member
- Use a confirmation dialog (shadcn, not browser default)
- After transfer, the previous owner is demoted to admin

---

### 12. Archive Organization UI in Settings

The org general settings page (`settings/organization/general`) currently only has a name field and a save button. There is no way for an org owner to archive their org from the regular UI — it's only available in the superuser admin panel.

**Desired behavior:**
- Add a "Danger zone" section at the bottom of the org general settings page
- Include an "Archive organization" option, visible only to the org owner
- Use a shadcn confirmation dialog with the org name typed to confirm (similar to GitHub's repo deletion pattern)
- Archiving should soft-delete the org and all its workspaces, then redirect the user to their next available org (or orphan recovery if none)

**Current state:**
- `OrgDO.archiveOrg()` exists in the backend and works
- The `archiveOrg` helper exists in `auth-do.ts`
- Only accessible via the admin panel's `_admin.orgs.$id.tsx` route behind `requireSuperuser()`

---

### 13. Confirmation Dialogs Audit

Several destructive actions use the browser's default `confirm()` dialog instead of shadcn confirmation dialogs.

**Desired behavior:**
- All destructive confirmations should use shadcn `AlertDialog` — never `window.confirm()`
- Known instances: "Leave Organization" on the org list, "Archive Workspace" on the workspaces list
- Audit all team/org/workspace flows and replace any remaining `window.confirm()` calls

---

## Part 2: Test Suite Remediation

### The Root Problem: Shadow Implementation in Test Helpers

The test helper file `workers/main/tests/test-helpers.ts` is a ~800-line parallel implementation of the business logic in `src/lib/auth-do.ts`. The workers tests call test-helper functions instead of production functions, and the test helpers do things the production code does not. This means tests pass green while production is broken.

Here are the specific divergences:

**`acceptInvitation`** — The test helper grants `full` workspace access to all non-archived workspaces after accepting. The production code does not. This is why the "default workspace access grants" feature appears to work in tests but is broken in production.

**`removeOrgMember`** — The test helper revokes workspace access for all workspaces and calls `checkUserOrphaned()` to mark the user as orphaned if they have zero orgs. The production code does neither.

**`createWorkspace`** — The test helper registers the workspace in OrgDO via `orgStub.addWorkspace()` and grants `full` access to all existing org members. The production code does neither.

**`archiveWorkspace`** — The test helper updates the OrgDO workspace list and clears `last_workspace_id` for affected users. The production code does neither.

### Required Fix

**Eliminate the shadow implementation.** The test helpers must call the production `auth-do.ts` functions, not reimplement them. The helpers can still handle test-only concerns (creating test users with known passwords, cleaning up after tests), but all business logic must flow through production code paths.

Specifically:
- `test-helpers.ts` setup functions (e.g., creating a user + org for a test) should call production `auth-do.ts` functions like `acceptInvitation`, `createWorkspace`, `removeOrgMember`, etc.
- Any logic that exists only in test-helpers and not in production is a bug — that logic needs to move into `auth-do.ts` first, then the test helper should call the production function
- After this change, if the production code is missing a step (like granting workspace access), the tests will fail too — which is exactly what we want

### Test Gaps to Fill

The following tests do not exist anywhere in the codebase and need to be written. These should be **integration tests** (real HTTP requests against the real dev server with real DOs) unless noted otherwise, because that's the only layer that exercises the production code path end-to-end.

#### Team Page Data Loading
- Load the team settings page as an admin. Assert that workspace data is present for each member (not an empty array).
- Load the team settings page as a regular member. Assert that admin controls (invite button, remove button, role dropdown) are not present in the response.

#### Default Workspace Access on Invitation Accept
- Create an org with 2 workspaces. Invite a new user. Accept the invitation. Verify the new user has `full` access to both workspaces by calling the workspace access API or checking that they can list both workspaces.
- Create a workspace in an org that already has 3 members. Verify all 3 existing members automatically have `full` access to the new workspace.

#### Workspace Archive
- Archive a workspace that is the user's active workspace. Verify the server reassigns them to another workspace (or null).
- Archive a workspace. Verify it does not appear in `getWorkspaces()` results (only in admin queries).
- Verify that a stale session pointing to an archived workspace gracefully recovers on page load.

#### Member Removal and Orphaning
- Remove a user from their only org. Verify `is_orphaned` is set to `true` immediately (not deferred to next login).
- Remove a user from one of two orgs. Verify `is_orphaned` is NOT set.
- Remove a user from their only org. Log in as that user. Verify the orphan recovery flow creates a new org.

#### Workspace Access Restrictions
- As an admin, revoke a member's access to a workspace. Verify the member can no longer see or access that workspace.
- As an admin, set a member to `read_only` on a workspace. Verify the member can read but not write (and cannot use WebSocket/chat).

#### Permission Gating
- As a member (not admin/owner), attempt to create a workspace via the API. Should be rejected.
- As a member, attempt to invite someone via the API. Should be rejected.
- As a member, attempt to change another user's role. Should be rejected.

#### Billing Status
- Create an org. Verify the org memberships list returns the actual `billing_status` from OrgDO (not hardcoded `'free'`).

#### Connection Duplication
- Create a connection on workspace A. Duplicate it to workspace B within the same org. Verify it exists on workspace B.
- Attempt to duplicate a connection to a workspace in a different org. Should be rejected.

#### Owner Transfer
- As an owner, transfer ownership to a member. Verify the old owner is now admin and the new owner is now owner.
- As a non-owner, attempt to transfer ownership. Should be rejected.

---

## Priority Order

1. **Test helpers fix + Items 3, 4, 8** — Eliminate the shadow implementation in test-helpers.ts, then fix default workspace access grants, archive filtering, and permission gating. These are the most critical production bugs.
2. **Items 2, 3** — Role descriptions and workspace access management on the team page. Wires up the UI that's already built.
3. **Items 5, 6, 7** — Archive cleanup, workspace archive session handling, and billing status display. Prevents stale sessions and data issues.
4. **Items 1, 10, 11, 12, 13** — Viewer deferral TODOs, orphan handling, transfer UI, archive org UI, dialog audit. Polish and completeness.
5. **Item 9** — Connection duplication. New feature, lowest urgency.
6. **All test gaps** — Write the integration tests listed above. Every feature fix should have a corresponding test before it's considered done.
