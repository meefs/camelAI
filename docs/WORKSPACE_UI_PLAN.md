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

---

## Phase 2: Implementation Specification

### Components to Install

The following shadcn components need to be installed (some may already exist):

```bash
# Required (verify if missing)
npx shadcn@latest add form
npx shadcn@latest add alert-dialog
npx shadcn@latest add toast
```

**Already installed:** button, card, input, label, dropdown-menu, separator, tooltip, skeleton, badge, dialog, select, switch, table, tabs, avatar, checkbox

---

### File Structure

```
src/app/(app)/settings/
├── layout.tsx              # Settings layout with side nav
├── page.tsx                # Redirects to /settings/profile
├── profile/
│   └── page.tsx            # USER > Profile
├── organization/
│   ├── page.tsx            # Redirects to /settings/organization/general
│   ├── general/
│   │   └── page.tsx        # ORG > General
│   ├── team/
│   │   └── page.tsx        # ORG > Team (members + invitations + workspace access)
│   ├── domains/
│   │   └── page.tsx        # ORG > Domains (placeholder)
│   └── danger-zone/
│       └── page.tsx        # ORG > Danger Zone
└── workspace/
    ├── page.tsx            # Redirects to /settings/workspace/general
    ├── general/
    │   └── page.tsx        # WORKSPACE > General
    └── danger-zone/
        └── page.tsx        # WORKSPACE > Danger Zone

src/components/settings/
├── settings-nav.tsx        # Settings side navigation
├── settings-header.tsx     # Page header component
├── profile-form.tsx        # Profile edit form
├── avatar-picker.tsx       # Avatar color/content picker
├── org-general-form.tsx    # Org name edit form
├── team-table.tsx          # Members/invitations table
├── workspace-access-tags.tsx # Tag-based workspace access control
├── invite-member-dialog.tsx # Invite modal
├── transfer-ownership-dialog.tsx # Transfer ownership confirmation
├── delete-org-dialog.tsx   # Delete org confirmation
├── workspace-general-form.tsx # Workspace edit form
├── create-workspace-dialog.tsx # Create workspace modal
└── archive-workspace-dialog.tsx # Archive confirmation
```

---

### Settings Layout (`settings/layout.tsx`)

**Pattern:** Side nav on left, content area on right (not using the main app Sidebar)

```tsx
// Composition
<div className="flex min-h-screen">
  <SettingsNav />                    {/* Fixed width side nav */}
  <main className="flex-1 p-6">      {/* Content area */}
    {children}
  </main>
</div>
```

**SettingsNav component structure:**
- Uses semantic nav element
- Groups with small uppercase labels (text-xs text-muted-foreground font-medium)
- Links use Button variant="ghost" with full width, left-aligned text
- Active state: bg-muted
- No container/border around the nav (clean/minimal)

```tsx
// SettingsNav structure
<nav className="w-56 shrink-0 border-r p-4">
  <div className="space-y-6">
    {/* USER group */}
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground px-2">User</p>
      <NavLink href="/settings/profile">Profile</NavLink>
    </div>

    {/* ORGANIZATION group */}
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground px-2">Organization</p>
      <NavLink href="/settings/organization/general">General</NavLink>
      <NavLink href="/settings/organization/team">Team</NavLink>
      <NavLink href="/settings/organization/domains">Domains</NavLink>
      <NavLink href="/settings/organization/danger-zone">Danger Zone</NavLink>
    </div>

    {/* WORKSPACE group */}
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground px-2">Workspace</p>
      <NavLink href="/settings/workspace/general">General</NavLink>
      <NavLink href="/settings/workspace/danger-zone">Danger Zone</NavLink>
    </div>
  </div>
</nav>
```

---

### Page Header Pattern

Each settings page uses a consistent header:

```tsx
<div className="space-y-6">
  <div>
    <h1 className="text-2xl font-semibold">Page Title</h1>
    <p className="text-muted-foreground">Brief description of this section.</p>
  </div>
  <Separator />
  {/* Page content */}
</div>
```

---

### USER > Profile

**Components:** Form, Input, Label, Button, Avatar, Dialog

```tsx
// Layout
<SettingsHeader
  title="Profile"
  description="Manage your personal account settings."
/>

<div className="space-y-8 max-w-2xl">
  {/* Avatar section */}
  <div className="flex items-center gap-4">
    <Avatar className="h-20 w-20">
      <AvatarFallback style={{ backgroundColor: user.avatar.color }}>
        {user.avatar.content}
      </AvatarFallback>
    </Avatar>
    <Button variant="outline" onClick={openAvatarPicker}>
      Change avatar
    </Button>
  </div>

  {/* Profile form */}
  <Form>
    <FormField name="name">
      <Label>Display name</Label>
      <Input placeholder="Your name" />
    </FormField>

    <FormField name="email">
      <Label>Email</Label>
      <Input disabled value={user.email} />
      <p className="text-xs text-muted-foreground">
        Email cannot be changed.
      </p>
    </FormField>

    <Button type="submit">Save changes</Button>
  </Form>
</div>
```

**AvatarPicker Dialog:**
- Color grid (8 preset colors from AVATAR_COLORS)
- Text input for content (2 chars max, or single emoji)
- Live preview of avatar

---

### ORGANIZATION > General

**Components:** Form, Input, Label, Button
**Role check:** Admin+ can edit, others see read-only

```tsx
<SettingsHeader
  title="Organization"
  description="Manage your organization settings."
/>

<div className="space-y-6 max-w-2xl">
  <Form>
    <FormField name="name">
      <Label>Organization name</Label>
      <Input
        defaultValue={org.name}
        disabled={!isAdmin}
      />
    </FormField>

    {isAdmin && (
      <Button type="submit">Save changes</Button>
    )}
  </Form>
</div>
```

---

### ORGANIZATION > Team

**Components:** Table, Badge, Button, Dialog, DropdownMenu, Tooltip

This is the most complex page. It combines:
1. Members list with roles
2. Pending invitations
3. Workspace access per member (tag-based UX)

```tsx
<SettingsHeader
  title="Team"
  description="Manage members, invitations, and workspace access."
/>

{/* Invite button (Admin+ only) */}
{isAdmin && (
  <div className="flex justify-end mb-4">
    <Button onClick={openInviteDialog}>
      <Plus className="h-4 w-4 mr-2" />
      Invite member
    </Button>
  </div>
)}

{/* Pending invitations section (Admin+ only) */}
{isAdmin && pendingInvitations.length > 0 && (
  <div className="mb-8">
    <h3 className="text-sm font-medium mb-3">Pending invitations</h3>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Invited</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pendingInvitations.map(inv => (
          <TableRow key={inv.id}>
            <TableCell>{inv.email}</TableCell>
            <TableCell><Badge variant="outline">{inv.role}</Badge></TableCell>
            <TableCell>{formatDate(inv.created_at)}</TableCell>
            <TableCell>
              <Button variant="ghost" size="sm" onClick={() => cancelInvite(inv.id)}>
                Cancel
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
)}

{/* Members table */}
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Member</TableHead>
      <TableHead>Role</TableHead>
      <TableHead>Workspace access</TableHead>
      <TableHead></TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {members.map(member => (
      <TableRow key={member.user_id}>
        <TableCell>
          <div className="flex items-center gap-3">
            <Avatar className="h-8 w-8">
              <AvatarFallback style={{ backgroundColor: member.avatar.color }}>
                {member.avatar.content}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium">{member.name || member.email}</p>
              {member.name && (
                <p className="text-xs text-muted-foreground">{member.email}</p>
              )}
            </div>
          </div>
        </TableCell>
        <TableCell>
          {isAdmin && member.role !== 'owner' ? (
            <RoleSelect value={member.role} onChange={...} />
          ) : (
            <Badge variant={member.role === 'owner' ? 'default' : 'outline'}>
              {member.role}
            </Badge>
          )}
        </TableCell>
        <TableCell>
          <WorkspaceAccessTags
            member={member}
            workspaces={workspaces}
            canEdit={isAdmin}
          />
        </TableCell>
        <TableCell>
          {isAdmin && member.user_id !== currentUser.id && member.role !== 'owner' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => removeMember(member.user_id)}>
                  Remove from organization
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

---

### WorkspaceAccessTags Component

The tag-based workspace access control from Phase 1 feedback:

```tsx
// WorkspaceAccessTags.tsx
interface WorkspaceAccessTagsProps {
  member: Member;
  workspaces: Workspace[];
  canEdit: boolean;
}

// Each tag shows workspace name
// Hover reveals: pencil (toggle full/read-only) and X (remove access)
// Muted/outlined style = read-only
// Solid style = full access
// "+ Add" button shows dropdown of workspaces user doesn't have access to

<div className="flex flex-wrap gap-1.5">
  {memberWorkspaces.map(ws => (
    <WorkspaceTag
      key={ws.id}
      workspace={ws}
      accessLevel={ws.accessLevel}
      canEdit={canEdit}
      onToggleAccess={() => toggleAccess(ws.id)}
      onRemove={() => removeAccess(ws.id)}
    />
  ))}
  {canEdit && hiddenWorkspaces.length > 0 && (
    <AddWorkspaceDropdown
      workspaces={hiddenWorkspaces}
      onAdd={(wsId) => grantAccess(wsId)}
    />
  )}
</div>

// WorkspaceTag internal structure
<div
  className={cn(
    "group relative inline-flex items-center gap-1 px-2 py-1 rounded-md text-sm",
    accessLevel === 'full'
      ? "bg-secondary text-secondary-foreground"
      : "bg-secondary/50 text-muted-foreground border border-dashed"
  )}
>
  <span>{workspace.name}</span>

  {/* Hover actions */}
  {canEdit && (
    <div className="hidden group-hover:flex items-center gap-0.5 ml-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onToggleAccess}
            className="p-0.5 hover:bg-background rounded"
          >
            {accessLevel === 'full' ? (
              <Pencil className="h-3 w-3" />
            ) : (
              <PencilOff className="h-3 w-3" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {accessLevel === 'full' ? 'Make read-only' : 'Grant full access'}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onRemove}
            className="p-0.5 hover:bg-background rounded"
          >
            <X className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Remove access</TooltipContent>
      </Tooltip>
    </div>
  )}
</div>
```

---

### ORGANIZATION > Domains

**Components:** Card (empty state)

```tsx
<SettingsHeader
  title="Domains"
  description="Configure custom domains for your projects."
/>

<Card className="p-8 text-center">
  <Globe className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
  <h3 className="font-medium mb-2">Custom domains coming soon</h3>
  <p className="text-sm text-muted-foreground">
    You'll be able to host your projects on your own domain.
  </p>
</Card>
```

---

### ORGANIZATION > Danger Zone

**Components:** Card, Button, AlertDialog, Select, Input

```tsx
<SettingsHeader
  title="Danger Zone"
  description="Irreversible actions for your organization."
/>

<div className="space-y-6 max-w-2xl">
  {/* Transfer ownership */}
  <Card className="border-destructive/50">
    <CardHeader>
      <CardTitle className="text-base">Transfer ownership</CardTitle>
      <CardDescription>
        Transfer this organization to another member. You will become an admin.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex items-center gap-4">
        <Select disabled={!isOwner}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Select new owner" />
          </SelectTrigger>
          <SelectContent>
            {members.filter(m => m.role !== 'owner').map(m => (
              <SelectItem key={m.user_id} value={m.user_id}>
                {m.name || m.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="destructive"
          disabled={!isOwner || !selectedNewOwner}
          onClick={openTransferDialog}
        >
          Transfer
        </Button>
      </div>
      {!isOwner && (
        <p className="text-xs text-muted-foreground mt-2">
          Only the organization owner can transfer ownership.
        </p>
      )}
    </CardContent>
  </Card>

  {/* Delete organization */}
  <Card className="border-destructive/50">
    <CardHeader>
      <CardTitle className="text-base">Delete organization</CardTitle>
      <CardDescription>
        Permanently delete this organization and all its workspaces. This cannot be undone.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Button
        variant="destructive"
        disabled={!isOwner}
        onClick={openDeleteDialog}
      >
        Delete organization
      </Button>
      {!isOwner && (
        <p className="text-xs text-muted-foreground mt-2">
          Only the organization owner can delete the organization.
        </p>
      )}
    </CardContent>
  </Card>
</div>
```

**Delete confirmation dialog:** Requires typing org name to confirm.

---

### WORKSPACE > General

**Components:** Form, Input, Label, Button, Avatar, Dialog

```tsx
<SettingsHeader
  title="Workspace"
  description="Manage settings for the current workspace."
/>

<div className="space-y-8 max-w-2xl">
  {/* Current workspace info */}
  <div className="flex items-center gap-4">
    <Avatar className="h-16 w-16">
      <AvatarFallback style={{ backgroundColor: workspace.avatar.color }}>
        {workspace.avatar.content}
      </AvatarFallback>
    </Avatar>
    {isAdmin && (
      <Button variant="outline" onClick={openAvatarPicker}>
        Change avatar
      </Button>
    )}
  </div>

  <Form>
    <FormField name="name">
      <Label>Workspace name</Label>
      <Input defaultValue={workspace.name} disabled={!isAdmin} />
    </FormField>

    <FormField name="description">
      <Label>Description</Label>
      <Textarea
        defaultValue={workspace.description || ''}
        disabled={!isAdmin}
        placeholder="Optional description"
      />
    </FormField>

    {isAdmin && (
      <Button type="submit">Save changes</Button>
    )}
  </Form>

  {/* Create new workspace (Admin+ only) */}
  {isAdmin && (
    <>
      <Separator />
      <div>
        <h3 className="font-medium mb-2">Create new workspace</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Add another workspace to this organization.
        </p>
        <Button variant="outline" onClick={openCreateDialog}>
          <Plus className="h-4 w-4 mr-2" />
          Create workspace
        </Button>
      </div>
    </>
  )}
</div>
```

---

### WORKSPACE > Danger Zone

**Components:** Card, Button, AlertDialog

```tsx
<SettingsHeader
  title="Danger Zone"
  description="Irreversible actions for this workspace."
/>

<div className="max-w-2xl">
  <Card className="border-destructive/50">
    <CardHeader>
      <CardTitle className="text-base">Archive workspace</CardTitle>
      <CardDescription>
        Archive this workspace. It will be hidden but data will be preserved.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Button
        variant="destructive"
        disabled={!isAdmin || isLastWorkspace}
        onClick={openArchiveDialog}
      >
        Archive workspace
      </Button>
      {isLastWorkspace && (
        <p className="text-xs text-muted-foreground mt-2">
          Cannot archive the only workspace in an organization.
        </p>
      )}
      {!isAdmin && (
        <p className="text-xs text-muted-foreground mt-2">
          Only admins can archive workspaces.
        </p>
      )}
    </CardContent>
  </Card>
</div>
```

---

### Workspace Switcher Enhancement

**File:** `src/components/sidebar/team-switcher.tsx` → rename to `workspace-switcher.tsx`

Changes needed:
1. Rename component to `WorkspaceSwitcher`
2. Fetch workspaces instead of orgs
3. Show org name as badge next to each workspace
4. Show access level indicator for read-only workspaces
5. Current item shows workspace name + org tag

```tsx
// Updated dropdown item structure
<DropdownMenuItem
  key={ws.id}
  onClick={() => switchWorkspace(ws.id)}
  className="gap-2 p-2"
>
  <Avatar className="h-6 w-6">
    <AvatarFallback style={{ backgroundColor: ws.avatar.color }}>
      {ws.avatar.content}
    </AvatarFallback>
  </Avatar>
  <span className="truncate flex-1">{ws.name}</span>
  <Badge variant="outline" className="text-xs">
    {ws.org_name}
  </Badge>
  {ws.access_level === 'read_only' && (
    <Badge variant="secondary" className="text-xs">
      Read-only
    </Badge>
  )}
  {ws.id === currentWorkspace?.id && (
    <Check className="h-4 w-4 text-muted-foreground" />
  )}
</DropdownMenuItem>
```

---

### NavUser Enhancement

**File:** `src/components/sidebar/nav-user.tsx`

Add Settings link to dropdown:

```tsx
<DropdownMenuContent>
  <DropdownMenuLabel>...</DropdownMenuLabel>
  <DropdownMenuSeparator />
  <DropdownMenuItem asChild>
    <Link href="/settings/profile">
      <Settings className="h-4 w-4 mr-2" />
      Settings
    </Link>
  </DropdownMenuItem>
  <DropdownMenuItem onClick={handleLogout}>
    <LogOut className="h-4 w-4 mr-2" />
    Log out
  </DropdownMenuItem>
</DropdownMenuContent>
```

---

### Connections Tab Updates

**File:** `src/app/(app)/connections/connections-client.tsx`

Add role-based visibility:

```tsx
const { currentOrg } = useAuth();
const isAdmin = currentOrg?.role === 'owner' || currentOrg?.role === 'admin';

// Hide add/edit/delete buttons for non-admins
{isAdmin && (
  <Button onClick={openAddDialog}>Add connection</Button>
)}

// In connection list, hide action buttons for non-admins
{isAdmin && (
  <DropdownMenu>
    {/* Edit, Delete options */}
  </DropdownMenu>
)}
```

---

### Implementation Priority

1. **Phase 2a - Foundation:**
   - Settings layout + nav component
   - Settings route structure
   - Profile page (simplest, validates patterns)

2. **Phase 2b - Workspace Switcher:**
   - Rename team-switcher → workspace-switcher
   - Update to show workspaces with org badges
   - Add access level indicators

3. **Phase 2c - User Menu:**
   - Add Settings link to nav-user dropdown

4. **Phase 2d - Organization Settings:**
   - Org General page
   - Team page (most complex - members table + workspace access tags)
   - Domains placeholder
   - Danger Zone

5. **Phase 2e - Workspace Settings:**
   - Workspace General page
   - Danger Zone
   - Create workspace dialog

6. **Phase 2f - Connections:**
   - Role-based visibility updates

---

### Loading & Error States

**Loading:** Use Skeleton components matching the content shape
**Errors:** Use toast notifications for action failures
**Form validation:** Use react-hook-form + zod schemas

---

### Responsive Behavior

- Settings side nav collapses to horizontal tabs on mobile (< 768px)
- Tables become card-based lists on mobile
- Dialogs use Sheet on mobile (slide up from bottom)

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-01-07 | 1.0 | Initial flow inventory |
| 2026-01-07 | 1.1 | Added reviewer feedback |
| 2026-01-07 | 2.0 | Revised plan incorporating all feedback |
| 2026-01-07 | 2.1 | Refined workspace access UX with tag-based hover interactions |
| 2026-01-07 | 3.0 | Phase 2 complete: Full implementation specification with components, layouts, and code examples |
