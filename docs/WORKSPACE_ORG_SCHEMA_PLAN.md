# Workspace & Organization Schema Restructuring Plan

**Status:** Draft v2
**Author:** Claude
**Date:** 2026-01-06
**Scope:** Backend only (UI/UX in follow-up PR)

## Executive Summary

This document outlines the plan to restructure Chiridion's data model to support:
- Users belonging to multiple organizations
- Organizations containing multiple workspaces (persistent computers/containers)
- Connections (integrations) scoped to workspaces, not orgs
- Role-based access control: `owner`, `admin`, `member`, `viewer` (viewer not enforced yet)
- Workspace-level access control (admins can restrict which workspaces members can access)
- Audit logging for membership, permissions, and workspace changes
- Future billing tied to organizations (not enforced in this PR)

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Target State](#target-state)
3. [Data Model Changes](#data-model-changes)
4. [Edge Cases & Business Logic](#edge-cases--business-logic)
5. [Soft Delete Strategy](#soft-delete-strategy)
6. [Audit Logging Plan](#audit-logging-plan)
7. [Migration Strategy](#migration-strategy)
8. [Implementation Phases](#implementation-phases)
9. [API Changes](#api-changes)
10. [Testing Plan](#testing-plan)
11. [Success Criteria](#success-criteria)

---

## Current State Analysis

### Existing Code Structure

| File | Current Responsibilities | Changes Needed |
|------|-------------------------|----------------|
| `workers/main/src/auth.ts` | SessionDO, UserDO, OrgDO with SQL schemas | Add workspace_id to SessionDO, add roles to UserDO/OrgDO, add avatar fields |
| `workers/main/src/org-container.ts` | OrgContainer class, one container per org | Rename to WorkspaceContainer, change ID derivation |
| `workers/main/src/durable-objects.ts` | ChatIndexDO (per org), ChatThreadDO (per thread) | ChatIndexDO becomes per-workspace |
| `workers/main/src/rpc-service.ts` | DoRpcService facade for all DO operations | Add workspace CRUD, permission methods, orphan handling |
| `src/types.ts` | Frontend/shared types | Add workspace types, update role types |
| `wrangler.jsonc` | DO bindings and migrations | Add WORKSPACE binding |

### Current SQL Schemas

**SessionDO** (`workers/main/src/auth.ts:115-136`):
```sql
CREATE TABLE session_data (
  key TEXT PRIMARY KEY,  -- Always 'data'
  value TEXT NOT NULL    -- JSON: { user_id, org_id, created_at, last_accessed, expires_at }
)
```

**UserDO** (`workers/main/src/auth.ts:195-256`):
```sql
CREATE TABLE profile (
  key TEXT PRIMARY KEY,  -- 'data' or 'password_hash'
  value TEXT NOT NULL    -- JSON UserProfile
)
CREATE TABLE orgs (
  org_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,     -- Currently: 'admin' | 'member'
  joined_at INTEGER NOT NULL
)
```

**OrgDO** (`workers/main/src/auth.ts:369-424`):
```sql
CREATE TABLE org_info (key TEXT PRIMARY KEY, value TEXT NOT NULL)
CREATE TABLE members (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,     -- Currently: 'admin' | 'member'
  joined_at INTEGER NOT NULL
)
CREATE TABLE invitations (...)
CREATE TABLE integrations (...)  -- Will move to WorkspaceDO
```

**ChatIndexDO** (`workers/main/src/durable-objects.ts:63-128`):
```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```
- Currently: One ChatIndexDO per org (keyed by org ID)
- Target: One ChatIndexDO per workspace (keyed by workspace ID)

### Current Container Routing

**`org-container.ts:394-397`**:
```typescript
export function getContainerIdForOrg(org: string): string {
  const safeOrg = org.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `org-${safeOrg}`.slice(0, 63);
}
```

**R2 prefix** (`org-container.ts:187-188`):
```typescript
const prefix = `${orgId}/`;
envVars.R2_PREFIX = prefix;
```

### Current Role System

- Only two roles: `admin` and `member` (`auth.ts:41-43`, `auth.ts:52-56`)
- Creator automatically becomes `admin` (`auth.ts:447-448`)
- No ownership concept - any admin can do anything

---

## Target State

### New Data Relationships

```
User (UserDO)
├── belongs to many Orgs (via orgs table with role)
├── has many Sessions
├── has avatar (color + content)
└── can be "orphaned" (no org memberships)

Organization (OrgDO)
├── has many Members (roles: owner, admin, member, viewer)
├── has many Invitations
├── has many Workspaces
├── has billing_status ('free' | 'paying')
└── has audit_log entries

Workspace (WorkspaceDO) ← NEW
├── belongs to one Org
├── has one Container
├── has many Threads (via ChatIndexDO keyed by workspace)
├── has many Connections (integrations) ← MOVED FROM ORG
├── has member access list (who can access this workspace)
├── has avatar (color + content)
└── has audit_log entries

Session (SessionDO)
├── tracks active org_id
└── tracks active workspace_id (NEW)

Container (WorkspaceContainer, renamed)
├── ID = `ws-{workspace-id}` (changed from `org-{org-id}`)
├── R2 prefix = `{orgId}/{workspaceId}/` (changed)
└── contains Threads (now workspace-scoped)
```

---

## Data Model Changes

### 1. WorkspaceDO (New Durable Object)

**File:** `workers/main/src/workspace.ts` (new)

```typescript
// SQL Schema
CREATE TABLE _schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE workspace_info (
  key TEXT PRIMARY KEY,  -- Always 'data'
  value TEXT NOT NULL    -- JSON WorkspaceInfo
);

CREATE TABLE members (
  user_id TEXT PRIMARY KEY,
  access_level TEXT NOT NULL,  -- 'full' | 'read_only' | 'none'
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  integration_type TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  config TEXT NOT NULL,
  credentials_encrypted TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER          -- Soft delete
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,       -- 'member_added', 'member_removed', 'integration_created', etc.
  actor_id TEXT NOT NULL,     -- User who performed action
  target_id TEXT,             -- User/integration affected (if applicable)
  details TEXT,               -- JSON with additional context
  created_at INTEGER NOT NULL
);

// WorkspaceInfo structure
interface WorkspaceInfo {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: number;

  // Avatar
  avatar_color: string;         // Hex code, e.g., "#4F46E5"
  avatar_content: string;       // 2-char initials or emoji, e.g., "WS" or "🚀"

  // Soft delete
  archived: boolean;
  archived_at: number | null;
  archived_by: string | null;

  // Future: compute tier (not enforced in this PR)
  compute_tier: 'standard';     // Only 'standard' for now
}

// Member access - explicit restrictions only
// Default: All org members have 'full' access
// This table only stores EXPLICIT restrictions
interface WorkspaceMember {
  user_id: string;
  access_level: 'full' | 'read_only' | 'none';
  granted_by: string;
  granted_at: number;
}
```

**Key design decisions:**
- **Connections (integrations) moved here** - Each workspace has its own connections
- **Member access is restrictive** - By default all org members can access all workspaces. This table only stores explicit restrictions (e.g., "user X has no access" or "user X is read-only")
- **Users cannot see workspaces they don't have access to** - If `access_level = 'none'`, workspace is hidden from user's workspace list
- **Soft delete via archived flag** - Workspace data preserved for potential recovery

### 2. OrgDO Changes

**File:** `workers/main/src/auth.ts` - Modify existing OrgDO class

```typescript
// Schema migration v2
if (version < 2) {
  // Add workspaces registry table
  this.sql.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Add billing fields to org_info (update existing JSON)
  // Add audit_log table
  this.sql.exec(`
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_id TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // Drop integrations table (moved to WorkspaceDO)
  // Note: Migration script will move data first

  this.sql.exec('UPDATE _schema_version SET version = 2');
}

// Updated OrgInfo structure
interface OrgInfo {
  id: string;
  name: string;
  created_at: number;
  created_by: string;

  // Billing (not enforced in this PR)
  billing_status: 'free' | 'paying';

  // Soft delete
  archived: boolean;
  archived_at: number | null;
  archived_by: string | null;
}

// Updated role enum - stored in members table
type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
```

**Role definitions:**

| Role | Manage Members | Manage Workspaces | Manage Billing | Transfer Ownership | Access Chat/Computer |
|------|---------------|-------------------|----------------|-------------------|---------------------|
| owner | ✅ | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ❌ | ✅ |
| member | ❌ | ❌ | ❌ | ❌ | ✅ |
| viewer | ❌ | ❌ | ❌ | ❌ | ❌ (published apps only)* |

*`viewer` role: Cannot access chat or computer tab. Can only view published applications. **Not enforced in this PR** - add FIXME comment for when app publishing is implemented.

**Constraints:**
- Every org must have exactly ONE owner
- Owner cannot leave org without transferring ownership first
- On ownership transfer, old owner becomes `admin` (not removed)
- `viewer` role enforcement deferred - FIXME in code

### 3. SessionDO Changes

**File:** `workers/main/src/auth.ts` - Modify existing SessionDO class

```typescript
// Schema migration v2
if (version < 2) {
  // workspace_id added to session JSON (no schema change needed, just data structure)
  this.sql.exec('UPDATE _schema_version SET version = 2');
}

// Updated SessionData structure
interface SessionData {
  user_id: string;
  org_id: string;
  workspace_id: string | null;   // NEW: null = no workspace selected
  created_at: number;
  last_accessed: number;
  expires_at: number;
}

// New method
async switchWorkspace(workspaceId: string | null): Promise<void> {
  const data = await this.getData();
  if (data) {
    data.workspace_id = workspaceId;
    await this.setData(data);
  }
}
```

### 4. UserDO Changes

**File:** `workers/main/src/auth.ts` - Modify existing UserDO class

```typescript
// Schema migration v4
if (version < 4) {
  // orgs.role column already exists, just need to update valid values
  // Add avatar fields to profile JSON (no schema change)
  this.sql.exec('UPDATE _schema_version SET version = 4');
}

// Updated UserProfile structure
interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  is_superuser: boolean;

  // NEW: Avatar
  avatar_color: string;         // Hex code, e.g., "#4F46E5"
  avatar_content: string;       // 2-char initials or emoji

  // NEW: Orphan state
  is_orphaned: boolean;
  orphaned_at: number | null;
}

// Updated role type in orgs table
type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

// Helper to generate default avatar
function generateDefaultAvatar(name: string | null, email: string): { color: string; content: string } {
  const source = name || email;
  const initials = source.slice(0, 2).toUpperCase();

  // Generate consistent color from string
  const hash = source.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const colors = ['#4F46E5', '#7C3AED', '#EC4899', '#F59E0B', '#10B981', '#3B82F6', '#EF4444', '#8B5CF6'];
  const color = colors[hash % colors.length];

  return { color, content: initials };
}
```

**Avatar content options:**
- Default: First 2 characters of name (or email if no name)
- User can customize to: any 2-character string OR a single emoji
- Emoji detection: Check if string is a single emoji using regex

### 5. ChatIndexDO Changes

**File:** `workers/main/src/durable-objects.ts` - Update DO naming

```typescript
// No schema changes needed
// The change is in how we KEY the DO:
// - Before: env.CHAT_INDEX.idFromName(orgId)
// - After:  env.CHAT_INDEX.idFromName(workspaceId)

// Update rpc-service.ts:166-168
function getIndexStub(env: DoRpcEnv, workspaceId: string) {
  return env.CHAT_INDEX.get(env.CHAT_INDEX.idFromName(workspaceId));
}
```

### 6. Container Changes

**File:** `workers/main/src/org-container.ts` → rename to `workspace-container.ts`

```typescript
// Rename class
export class WorkspaceContainer extends Container<WorkspaceContainerEnv> {
  // ...existing implementation...

  // Update buildEnvVars to accept workspaceId and orgId
  async buildEnvVars(workspaceId: string, orgId: string): Promise<Record<string, string>> {
    // ...
    envVars.WORKSPACE_ID = workspaceId;
    envVars.ORG_ID = orgId;

    // Updated R2 prefix
    const prefix = `${orgId}/${workspaceId}/`;
    envVars.R2_PREFIX = prefix;

    // Fetch integrations from WORKSPACE (not org)
    // ...
  }
}

// Updated helper functions
export function getContainerIdForWorkspace(workspaceId: string): string {
  const safeId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `ws-${safeId}`.slice(0, 63);
}

export function getWorkspaceContainer(env: WorkspaceContainerEnv, workspaceId: string) {
  const containerId = getContainerIdForWorkspace(workspaceId);
  return env.SANDBOX.get(env.SANDBOX.idFromName(containerId));
}
```

### 7. Type Definitions

**File:** `src/types.ts` - Add new types

```typescript
// Roles
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type WorkspaceAccessLevel = 'full' | 'read_only' | 'none';
export type BillingStatus = 'free' | 'paying';

// Avatar
export interface Avatar {
  color: string;    // Hex code
  content: string;  // 2-char or emoji
}

// Workspace
export interface Workspace {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: number;
  avatar: Avatar;
  archived: boolean;
}

export interface WorkspaceWithAccess extends Workspace {
  access_level: WorkspaceAccessLevel;  // Computed from permissions
}

// Updated Organization
export interface Organization {
  id: string;
  name: string;
  created_at: number;
  created_by: string;
  billing_status: BillingStatus;
  archived: boolean;
}

export interface OrgMembership {
  org_id: string;
  org_name: string;
  role: OrgRole;           // Updated from 'admin' | 'member'
  joined_at: number;
}

// Updated User
export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
  avatar: Avatar;
  is_orphaned: boolean;
}

// Audit log entry (shared structure)
export interface AuditLogEntry {
  id: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: number;
}
```

---

## Edge Cases & Business Logic

### EC1: User Kicked from Org

**Scenario:** User is removed from their only org.

**Flow:**
1. Admin calls `removeOrgMember(orgId, userId)`
2. System removes membership from both OrgDO and UserDO
3. System logs audit entry: `{ action: 'member_removed', actor_id, target_id: userId }`
4. System checks if user has any remaining org memberships
5. If no memberships remain:
   - Set `user.is_orphaned = true` and `user.orphaned_at = Date.now()`
   - **Do NOT delete user** (preserves email mapping, allows re-invitation)
6. On next login:
   - Detect orphaned user (check `is_orphaned` flag)
   - Create new default org: `"{user.name || 'My'}'s Organization"`
   - Create default workspace: `"Default Workspace"` with initials avatar
   - Clear orphaned status
   - Update session with new org_id and workspace_id
   - Log user in to new org/workspace

**Implementation locations:**
- `rpc-service.ts:removeOrgMember` - Add orphan check
- `rpc-service.ts` - Add `handleOrphanedUserLogin(userId)` method
- Login API route - Call orphan handler

### EC2: Owner Leaves Org (Blocked)

**Scenario:** Org owner wants to leave but org has other members.

**Flow:**
1. Owner attempts to leave via `removeOrgMember`
2. System checks if user is owner: `SELECT role FROM members WHERE user_id = ?`
3. If owner, system returns error: `"Cannot leave organization. Transfer ownership first."`
4. Owner must call `transferOwnership(orgId, newOwnerId)` first
5. System validates:
   - `newOwnerId` is existing member (any role)
   - Actor is current owner
6. System atomically:
   - Sets new owner's role to `'owner'`
   - Sets old owner's role to `'admin'`
   - Logs audit: `{ action: 'ownership_transferred', actor_id: oldOwner, target_id: newOwner }`

**Implementation locations:**
- `rpc-service.ts:removeOrgMember` - Add owner check
- `rpc-service.ts` - Add `transferOwnership(orgId, newOwnerId, actorId)` method
- `auth.ts:OrgDO` - Add `transferOwnership` method

### EC3: Last Member Leaves Org (Sole Owner Deletes)

**Scenario:** Only remaining member (owner) wants to delete the org.

**Flow:**
1. Owner calls `archiveOrg(orgId)` (only available to sole owner)
2. System validates: exactly 1 member AND that member is owner
3. System archives org and all workspaces:
   - Set `org.archived = true`, `archived_at`, `archived_by`
   - For each workspace: set `archived = true`
   - Log audit: `{ action: 'org_archived', actor_id: ownerId }`
4. System removes org from owner's memberships
5. If owner now has no orgs → apply EC1 flow (orphaned user)
6. Containers will idle-timeout and be cleaned up automatically

**Implementation locations:**
- `rpc-service.ts` - Add `archiveOrg(orgId, actorId)` method
- `auth.ts:OrgDO` - Add `archive(archivedBy)` method

### EC4: Workspace-Level Access Restriction

**Scenario:** Org admin wants to restrict member from specific workspace.

**Flow:**
1. Admin calls `setWorkspaceAccess(workspaceId, userId, 'none')`
2. System validates: actor is org owner/admin
3. System creates/updates permission record in WorkspaceDO.members table
4. System logs audit: `{ action: 'workspace_access_changed', target_id: userId, details: { access_level: 'none' } }`
5. Effects on restricted user:
   - Workspace **does not appear** in their workspace list
   - Cannot connect to container
   - Cannot read/write files
   - Cannot view threads
   - If they try to access directly: 404 (not 403, to avoid leaking existence)

**`read_only` access level:**
- Can view threads and files
- Cannot send messages
- Cannot modify files
- Shows in workspace list with read-only indicator

**Implementation locations:**
- `workspace.ts:WorkspaceDO` - Add `setMemberAccess`, `getMemberAccess` methods
- `rpc-service.ts` - Add `setWorkspaceAccess`, `getWorkspaceAccess`, `listUserWorkspaces` methods
- `rpc-service.ts:listUserWorkspaces` - Filter out `access_level = 'none'`

### EC5: Session with Deleted/Archived Workspace

**Scenario:** User's session references workspace that was archived.

**Flow:**
1. User makes request with session containing archived `workspace_id`
2. Auth middleware fetches workspace: `getWorkspace(session.workspace_id)`
3. Workspace is archived or doesn't exist
4. System clears `workspace_id` from session (sets to null)
5. API returns `{ error: 'workspace_unavailable', code: 'WORKSPACE_ARCHIVED' }`
6. Client should redirect to workspace selection

**Implementation locations:**
- Auth middleware in API routes
- `rpc-service.ts:getWorkspace` - Return null for archived workspaces

### EC6: Invitation to Orphaned User

**Scenario:** Orphaned user receives and accepts org invitation.

**Flow:**
1. User clicks invitation link, authenticates
2. System detects user exists (via email) and is orphaned
3. System calls `acceptInvitation(orgId, invitationId, userId)`
4. System adds user to invited org with invited role
5. System clears orphaned status: `is_orphaned = false`, `orphaned_at = null`
6. User does NOT get a new default org (they're joining existing one)
7. System creates session with the invited org

**Implementation locations:**
- Invitation acceptance API route
- `rpc-service.ts:acceptInvitation` - Add orphan status clear

### EC7: Default Workspace Creation

**Scenario:** New org is created.

**Flow:**
1. User creates new org via `createOrg(name, createdBy)`
2. System creates org with creator as `owner`
3. System automatically creates default workspace:
   - Name: `"Default Workspace"`
   - Avatar: Generated from workspace name
4. System logs audit: `{ action: 'org_created' }`, `{ action: 'workspace_created' }`
5. Session is updated with both `org_id` and `workspace_id`

**Implementation locations:**
- `rpc-service.ts:createOrg` - Add automatic workspace creation
- Signup flow - Set initial session workspace

### EC8: Viewer Role Access (FIXME - Not Enforced)

**Scenario:** User with `viewer` role tries to access chat or computer.

**Current behavior (this PR):** Viewer can access everything like a member.

**Future behavior (after app publishing):**
- Cannot access `/chat/*` routes
- Cannot access workspace computer/files
- Can only view published application URLs

**Implementation:**
- Add FIXME comments in auth middleware where role checks occur
- Comment: `// FIXME: Enforce viewer role restrictions when app publishing is implemented`

---

## Soft Delete Strategy

For analytics and recovery purposes, we use soft delete (archived flags) instead of hard delete.

### What Gets Soft Deleted

| Entity | Soft Delete Field | When Soft Deleted | What's Preserved | What's Hard Deleted |
|--------|------------------|-------------------|------------------|---------------------|
| **Organization** | `archived`, `archived_at`, `archived_by` | Owner archives org | Org info, workspaces, audit logs | Nothing |
| **Workspace** | `archived`, `archived_at`, `archived_by` | Admin archives workspace | Workspace info, threads, integrations, audit logs | Container (after idle timeout) |
| **Integration** | `deleted_at` | User deletes connection | Integration record with credentials | Nothing |
| **Thread** | N/A - Hard delete OK | User deletes thread | N/A | Thread metadata, JSONL file |
| **User** | N/A - Never deleted | Never | N/A | N/A |
| **Invitation** | N/A - Hard delete OK | Expired or accepted | N/A | Invitation record |

### Soft Delete Behavior

**Archived Organization:**
- Does not appear in user's org list
- All workspaces are inaccessible
- Members are removed from org membership (triggers orphan check)
- Org data preserved for 90 days (future: background cleanup job)

**Archived Workspace:**
- Does not appear in workspace list for any user
- Container idles and stops (10 min timeout)
- R2 data preserved
- Threads preserved but inaccessible
- Workspace data preserved for 90 days

**Deleted Integration:**
- Does not appear in integration list
- Credentials remain encrypted in DB
- Not passed to container on next start
- Record preserved for audit trail

---

## Audit Logging Plan

### Audit Log Actions

**Organization Level** (stored in OrgDO.audit_log):

| Action | Description | Details JSON |
|--------|-------------|--------------|
| `org_created` | Organization created | `{ name }` |
| `org_updated` | Org settings changed | `{ changes: { field: [old, new] } }` |
| `org_archived` | Organization archived | `{}` |
| `member_added` | User added to org | `{ role, method: 'invite' \| 'direct' }` |
| `member_removed` | User removed from org | `{ role, reason: 'kicked' \| 'left' }` |
| `member_role_changed` | User role updated | `{ old_role, new_role }` |
| `ownership_transferred` | Ownership transferred | `{ from_user_id }` |
| `workspace_created` | Workspace created | `{ workspace_id, name }` |
| `workspace_archived` | Workspace archived | `{ workspace_id, name }` |

**Workspace Level** (stored in WorkspaceDO.audit_log):

| Action | Description | Details JSON |
|--------|-------------|--------------|
| `workspace_updated` | Workspace settings changed | `{ changes: { field: [old, new] } }` |
| `access_granted` | User given workspace access | `{ access_level }` |
| `access_revoked` | User access removed | `{ previous_level }` |
| `access_changed` | User access level changed | `{ old_level, new_level }` |
| `integration_created` | Connection added | `{ integration_type, name }` |
| `integration_updated` | Connection modified | `{ changes }` |
| `integration_deleted` | Connection removed | `{ integration_type, name }` |

### Audit Log Implementation

```typescript
// In each DO, add helper method
private log(action: string, actorId: string, targetId?: string, details?: Record<string, unknown>): void {
  const id = crypto.randomUUID();
  const now = Date.now();
  this.sql.exec(
    'INSERT INTO audit_log (id, action, actor_id, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    action,
    actorId,
    targetId || null,
    details ? JSON.stringify(details) : null,
    now
  );
}

// Exposed via RPC for admin viewing
async getAuditLog(limit = 100, offset = 0): Promise<AuditLogEntry[]> {
  return this.sql.exec(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?',
    limit,
    offset
  ).toArray() as unknown as AuditLogEntry[];
}
```

---

## Migration Strategy

### Phase 1: Schema Additions (Non-Breaking)

1. Add new tables/columns without removing existing ones
2. Add WorkspaceDO class with SQL schema
3. Add new fields to OrgDO (billing_status, workspaces table, audit_log)
4. Add workspace_id to SessionDO (nullable)
5. Add avatar fields and is_orphaned to UserDO
6. Add WORKSPACE DO binding to wrangler.jsonc

### Phase 2: Data Migration Script

For each existing org:
1. Create default workspace with:
   - `id`: Same as org ID (simplifies migration)
   - `name`: "Default Workspace"
   - `avatar`: Generated from name
2. Copy integrations from OrgDO to WorkspaceDO
3. Update ChatIndexDO key mapping (already keyed by same ID)
4. Update R2 paths: `{orgId}/` → `{orgId}/{workspaceId}/` (same ID, so path unchanged)
5. Set org creator as `owner` role (was `admin`)
6. Update all sessions to include `workspace_id = org_id` (default workspace)

### Phase 3: Code Migration

1. Rename OrgContainer → WorkspaceContainer
2. Update container ID derivation
3. Update all APIs to require workspace_id where appropriate
4. Add workspace CRUD endpoints
5. Update integration APIs to use workspace context

### Phase 4: Cleanup

1. Remove integrations table from OrgDO (after verifying migration)
2. Update tests
3. Remove deprecated code paths

---

## Implementation Phases

### Phase 1: Core Schema & Types (Foundation)

**Files to modify/create:**
- `workers/main/src/workspace.ts` (new)
- `workers/main/src/auth.ts` (modify SessionDO, UserDO, OrgDO)
- `src/types.ts` (add new types)
- `wrangler.jsonc` (add WORKSPACE binding)

**Tasks:**
1. Create `WorkspaceDO` class with:
   - SQL schema with migrations
   - CRUD operations (create, get, update, archive)
   - Member access management (setAccess, getAccess)
   - Integration management (moved from OrgDO)
   - Audit logging

2. Update `OrgDO`:
   - Add `workspaces` registry table
   - Add `billing_status` field (default: 'free')
   - Add `archived`, `archived_at`, `archived_by` fields
   - Update role type to include 'owner' and 'viewer'
   - Add `audit_log` table
   - Add `transferOwnership` method
   - Keep integrations table temporarily (migration compatibility)

3. Update `UserDO`:
   - Add `avatar_color`, `avatar_content` fields with defaults
   - Add `is_orphaned`, `orphaned_at` fields
   - Update role type in orgs table

4. Update `SessionDO`:
   - Add `workspace_id` field (nullable)
   - Add `switchWorkspace` method

5. Update `src/types.ts` with all new types

6. Update `wrangler.jsonc`:
   - Add `WORKSPACE` DO binding
   - Update migrations tag

**Deliverable:** Test suite validating:
- WorkspaceDO CRUD operations
- WorkspaceDO member access management
- WorkspaceDO integration storage
- OrgDO role changes (owner, viewer)
- OrgDO ownership transfer
- UserDO avatar generation
- UserDO orphan state management
- SessionDO workspace tracking
- Audit log creation for all actions

---

### Phase 2: Container & Storage Refactor

**Files to modify:**
- `workers/main/src/org-container.ts` → `workspace-container.ts`
- `workers/main/src/durable-objects.ts` (ChatIndexDO keying)
- `sandbox/sync.mjs` (R2 path handling)
- `sandbox/ws-server.mjs` (env var handling)
- `sandbox/entrypoint.sh` (env var handling)

**Tasks:**
1. Rename file and class:
   - `OrgContainer` → `WorkspaceContainer`
   - `getContainerIdForOrg` → `getContainerIdForWorkspace`
   - `getOrgContainer` → `getWorkspaceContainer`

2. Update container ID derivation:
   - From: `org-${safeOrg}`
   - To: `ws-${safeWorkspaceId}`

3. Update R2 prefix:
   - From: `${orgId}/`
   - To: `${orgId}/${workspaceId}/`

4. Update `buildEnvVars`:
   - Accept `(workspaceId: string, orgId: string)`
   - Add `WORKSPACE_ID` env var
   - Fetch integrations from WorkspaceDO (not OrgDO)

5. Update ChatIndexDO keying in rpc-service.ts:
   - `getIndexStub(env, workspaceId)` instead of org

6. Update sandbox scripts to handle new env vars

**Deliverable:** Test suite validating:
- Container starts with correct workspace ID
- R2 prefix correctly scoped
- Integration env vars loaded from workspace
- Thread creation scoped to workspace

---

### Phase 3: RPC Service Layer

**Files to modify:**
- `workers/main/src/rpc-service.ts`

**Tasks:**
1. Add workspace CRUD methods:
   - `createWorkspace(orgId, name, createdBy)`
   - `getWorkspace(workspaceId)`
   - `updateWorkspace(workspaceId, updates, actorId)`
   - `archiveWorkspace(workspaceId, actorId)`
   - `listOrgWorkspaces(orgId)` - all workspaces for org
   - `listUserWorkspaces(userId, orgId)` - filtered by access

2. Add permission methods:
   - `getWorkspaceAccess(workspaceId, userId)`
   - `setWorkspaceAccess(workspaceId, userId, level, actorId)`
   - `listWorkspaceMembers(workspaceId)`

3. Add ownership transfer:
   - `transferOrgOwnership(orgId, newOwnerId, actorId)`

4. Add orphan handling:
   - `checkUserOrphaned(userId)` - returns boolean
   - `handleOrphanedUserLogin(userId)` - creates org/workspace

5. Update existing methods to be workspace-aware:
   - All thread methods: add workspaceId parameter
   - All file methods: use workspaceId for container routing
   - Integration methods: route to WorkspaceDO

6. Add audit log methods:
   - `getOrgAuditLog(orgId, limit, offset)`
   - `getWorkspaceAuditLog(workspaceId, limit, offset)`

**Deliverable:** Test suite validating:
- Workspace CRUD via RPC
- Permission management via RPC
- Ownership transfer flow
- Orphan detection and recovery
- Thread operations with workspace context
- File operations with workspace routing
- Audit log retrieval

---

### Phase 4: API Endpoints

**Files to modify/create:**
- `src/app/api/workspaces/route.ts` (new)
- `src/app/api/workspaces/[id]/route.ts` (new)
- `src/app/api/workspaces/[id]/access/route.ts` (new)
- `src/app/api/workspaces/[id]/integrations/route.ts` (new)
- `src/app/api/auth/switch-workspace/route.ts` (new)
- `src/app/api/auth/me/route.ts` (modify)
- `src/app/api/orgs/[id]/transfer-ownership/route.ts` (new)
- `src/app/api/threads/route.ts` (modify)
- `workers/main/src/index.ts` (WebSocket routing)

**Tasks:**
1. New workspace endpoints:
   - `GET /api/workspaces` - List workspaces for active org (filtered by access)
   - `POST /api/workspaces` - Create workspace (admin only)
   - `GET /api/workspaces/[id]` - Get workspace details
   - `PUT /api/workspaces/[id]` - Update workspace (admin only)
   - `DELETE /api/workspaces/[id]` - Archive workspace (admin only)
   - `GET /api/workspaces/[id]/access` - List member access
   - `PUT /api/workspaces/[id]/access/[userId]` - Set member access (admin only)
   - `GET /api/workspaces/[id]/integrations` - List workspace integrations
   - `POST /api/workspaces/[id]/integrations` - Create integration
   - (etc. - move integration routes from org to workspace)

2. New auth endpoints:
   - `POST /api/auth/switch-workspace` - Switch active workspace

3. Modify existing endpoints:
   - `GET /api/auth/me` - Include workspace info, update response shape
   - `POST /api/orgs/[id]/transfer-ownership` - Transfer ownership
   - Thread endpoints - Use workspace_id from session

4. Update WebSocket routing:
   - From: `/ws/{org}`
   - To: `/ws/{workspace}` (workspace ID)

**Deliverable:** Test suite validating:
- All new API endpoints return correct responses
- Auth middleware enforces workspace access
- Integration APIs work with workspace context
- WebSocket connects to correct container

---

### Phase 5: Migration & Backward Compatibility

**Files to create/modify:**
- `scripts/migrate-to-workspaces.ts` (new migration script)
- Auth middleware (backward compat handling)

**Tasks:**
1. Create data migration script:
   - For each org: create default workspace
   - Copy integrations to workspace
   - Update R2 prefixes (if needed)
   - Set org creators as 'owner'
   - Backfill session workspace_id

2. Add backward compatibility:
   - Sessions without workspace_id: auto-select default workspace
   - Old `/ws/{org}` route: map to default workspace (temporary)
   - API calls without workspace: use default workspace

3. Add validation:
   - Workspace existence checks
   - Archived workspace handling
   - Orphan user detection on login

**Deliverable:** Test suite validating:
- Migration script creates workspaces correctly
- Old sessions still work
- Orphan user flow works end-to-end

---

### Phase 6: Audit Logging & Edge Cases

**Files to modify:**
- All DO files (add audit logging to mutations)
- `rpc-service.ts` (audit log retrieval)
- API routes (audit endpoints)

**Tasks:**
1. Add audit logging to all mutations:
   - OrgDO: member changes, ownership transfer, archive
   - WorkspaceDO: access changes, integration changes, archive
   - Log actor, target, details for each action

2. Implement remaining edge cases:
   - Owner blocked from leaving
   - Orphan recovery on login
   - Archived workspace session handling
   - Viewer role FIXME comments

3. Add audit log API endpoints:
   - `GET /api/orgs/[id]/audit-log`
   - `GET /api/workspaces/[id]/audit-log`

**Deliverable:** Test suite validating:
- All mutations create audit log entries
- Audit log retrieval works
- Edge case flows work correctly

---

## API Changes

### New Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/workspaces` | member+ | List workspaces in active org (filtered by access) |
| POST | `/api/workspaces` | admin+ | Create new workspace |
| GET | `/api/workspaces/[id]` | access required | Get workspace details |
| PUT | `/api/workspaces/[id]` | admin+ | Update workspace |
| DELETE | `/api/workspaces/[id]` | admin+ | Archive workspace |
| GET | `/api/workspaces/[id]/access` | admin+ | List member access levels |
| PUT | `/api/workspaces/[id]/access/[userId]` | admin+ | Set member access level |
| GET | `/api/workspaces/[id]/integrations` | access required | List workspace integrations |
| POST | `/api/workspaces/[id]/integrations` | admin+ | Create integration |
| GET | `/api/workspaces/[id]/integrations/[iid]` | access required | Get integration |
| PUT | `/api/workspaces/[id]/integrations/[iid]` | admin+ | Update integration |
| DELETE | `/api/workspaces/[id]/integrations/[iid]` | admin+ | Delete integration |
| POST | `/api/auth/switch-workspace` | member+ | Switch active workspace |
| POST | `/api/orgs/[id]/transfer-ownership` | owner | Transfer org ownership |
| GET | `/api/orgs/[id]/audit-log` | admin+ | Get org audit log |
| GET | `/api/workspaces/[id]/audit-log` | admin+ | Get workspace audit log |

### Modified Endpoints

| Endpoint | Changes |
|----------|---------|
| `GET /api/auth/me` | Add `workspace`, `workspaces` fields; include role as `owner\|admin\|member\|viewer` |
| `GET /api/threads` | Now scoped to active workspace |
| `POST /api/threads` | Creates thread in active workspace |
| `DELETE /api/orgs/[id]/members/[userId]` | Triggers orphan check; blocks owner removal |
| `WebSocket /ws/{org}` | Changed to `/ws/{workspace}` |

### Response Shape Changes

```typescript
// GET /api/auth/me - Enhanced response
interface AuthMeResponse {
  user: {
    id: string;
    email: string;
    name: string | null;
    is_superuser: boolean;
    is_orphaned: boolean;
    avatar: Avatar;
  };
  org: {
    id: string;
    name: string;
    role: OrgRole;  // 'owner' | 'admin' | 'member' | 'viewer'
    billing_status: BillingStatus;
  };
  workspace: {
    id: string;
    name: string;
    avatar: Avatar;
    access_level: WorkspaceAccessLevel;
  } | null;  // null if no workspace selected
  orgs: Array<{
    id: string;
    name: string;
    role: OrgRole;
  }>;
  workspaces: Array<{
    id: string;
    name: string;
    avatar: Avatar;
    access_level: WorkspaceAccessLevel;  // Only 'full' or 'read_only' (none filtered out)
  }>;
}
```

---

## Testing Plan

### Unit Tests (Vitest + jsdom)

**Location:** `tests/`

| Test File | Coverage |
|-----------|----------|
| `workspace-do.test.ts` | WorkspaceDO CRUD, member access, integrations, audit log |
| `org-roles.test.ts` | Owner/admin/member/viewer role checks, ownership transfer |
| `orphan-user.test.ts` | Orphan detection, auto-org creation, re-invitation |
| `workspace-permissions.test.ts` | Access level enforcement, visibility filtering |
| `session-workspace.test.ts` | Workspace switching, null workspace handling |
| `avatar.test.ts` | Default avatar generation, emoji detection |
| `soft-delete.test.ts` | Archive behavior for orgs and workspaces |
| `audit-log.test.ts` | Audit entries created for all mutations |

**Key test scenarios:**
1. Create workspace → returns workspace with correct fields
2. Archive workspace → soft deletes, doesn't appear in list
3. Set access to 'none' → workspace hidden from user list
4. Set access to 'read_only' → workspace visible, user can read
5. Transfer ownership → roles swap correctly
6. Owner tries to leave → error returned
7. Remove last org → user becomes orphaned
8. Orphaned user logs in → new org/workspace created
9. All mutations → audit log entry created

### Integration Tests (Vitest + dev server)

**Location:** `tests/integration/`

| Test File | Coverage |
|-----------|----------|
| `workspace-api.test.ts` | Workspace CRUD via HTTP |
| `workspace-auth.test.ts` | Auth middleware workspace validation |
| `ownership-transfer.test.ts` | Full ownership transfer flow |
| `orphan-recovery.test.ts` | Orphan → login → new org flow |
| `integration-workspace.test.ts` | Integration CRUD in workspace context |

**Key test scenarios:**
1. Create workspace via API → appears in list
2. Switch workspace via API → session updated
3. Access workspace without permission → 404
4. Access archived workspace → appropriate error
5. Create integration in workspace → env vars available to container
6. Transfer ownership → API returns success, roles updated

### Workers Runtime Tests (Cloudflare pool)

**Location:** `workers/main/tests/`

| Test File | Coverage |
|-----------|----------|
| `workspace-do.test.ts` | WorkspaceDO in Workers runtime |
| `container-routing.test.ts` | Container ID derivation, workspace routing |
| `cross-do-consistency.test.ts` | OrgDO + UserDO + WorkspaceDO coordination |
| `audit-log.test.ts` | Audit log SQL operations |

### No E2E Tests in This PR

E2E tests (Playwright) will be added in the follow-up UI/UX PR since this PR is backend-only.

---

## Success Criteria

### Must Have (This PR)
- [ ] Users can create multiple orgs
- [ ] Orgs can have multiple workspaces
- [ ] Each workspace has its own container
- [ ] Each workspace has its own connections (integrations)
- [ ] Threads are scoped to workspaces
- [ ] Sessions track both org and workspace
- [ ] Owner/admin/member/viewer roles implemented (viewer not enforced - FIXME)
- [ ] Workspace-level permissions (full/read_only/none)
- [ ] Users cannot see workspaces with 'none' access
- [ ] Orphan user flow works end-to-end
- [ ] Ownership transfer API works
- [ ] Soft delete for orgs and workspaces
- [ ] Audit logging for membership, permissions, workspace changes
- [ ] User avatars (color + initials/emoji)
- [ ] Workspace avatars (color + initials/emoji)
- [ ] All existing functionality preserved
- [ ] Migration script for existing data
- [ ] Comprehensive test coverage for all new functionality

### Future (Not This PR)
- [ ] Billing enforcement based on tier
- [ ] Workspace compute tier selection
- [ ] Viewer role enforcement (when app publishing ships)
- [ ] Audit log retention/cleanup policy

---

## Appendix: Complete Type Definitions

```typescript
// src/types.ts additions

// Roles
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type WorkspaceAccessLevel = 'full' | 'read_only' | 'none';
export type BillingStatus = 'free' | 'paying';

// Avatar
export interface Avatar {
  color: string;    // Hex code, e.g., "#4F46E5"
  content: string;  // 2-char initials or single emoji
}

// Workspace
export interface Workspace {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  avatar: Avatar;
  created_by: string;
  created_at: number;
  archived: boolean;
  archived_at: number | null;
}

export interface WorkspaceWithAccess extends Workspace {
  access_level: WorkspaceAccessLevel;
}

export interface WorkspaceMember {
  user_id: string;
  access_level: WorkspaceAccessLevel;
  granted_by: string;
  granted_at: number;
}

// Updated Organization
export interface Organization {
  id: string;
  name: string;
  created_at: number;
  created_by: string;
  billing_status: BillingStatus;
  archived: boolean;
}

// Updated OrgMembership
export interface OrgMembership {
  org_id: string;
  org_name: string;
  role: OrgRole;
  joined_at: number;
}

// Updated User
export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
  avatar: Avatar;
  is_orphaned: boolean;
}

// Updated Session (internal)
export interface Session {
  id: string;
  user_id: string;
  org_id: string;
  workspace_id: string | null;
  created_at: number;
  expires_at: number;
}

// Audit log
export interface AuditLogEntry {
  id: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: number;
}

// Updated invitation role
export interface Invitation {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: OrgRole;  // Can now invite as any role
  invited_by: string;
  created_at: number;
  expires_at: number;
}

// Avatar helpers (implementation in lib/avatar.ts)
export function generateDefaultAvatar(source: string): Avatar;
export function isEmoji(str: string): boolean;
export function validateAvatarContent(content: string): boolean;
```

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-01-06 | 1.0 | Initial draft |
| 2026-01-06 | 2.0 | Updated based on feedback: connections at workspace level, explicit permissions, simplified billing status, viewer role, avatars, soft delete details, audit logging, removed E2E tests |
