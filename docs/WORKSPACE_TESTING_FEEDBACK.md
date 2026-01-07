# Workspace Implementation - Testing Feedback

**Date:** 2026-01-07
**Reviewer:** Claude
**Reference:** `docs/WORKSPACE_ORG_SCHEMA_PLAN.md` (Testing Plan, lines 1149-1210)

## Summary

The current test coverage is incomplete compared to the testing plan. While the core functionality works (107 tests pass), several test files and scenarios outlined in the plan are missing.

**Current state:** 5 test files, 26 workspace-related tests
**Planned state:** 17 test files with comprehensive scenario coverage

---

## Missing Unit Tests (`tests/`)

### 1. `tests/org-roles.test.ts` - NEW FILE NEEDED

Test owner/admin/member/viewer role checks and ownership transfer.

**Scenarios to cover:**
```typescript
describe('org roles', () => {
  // Role hierarchy
  it('owner can manage members');
  it('owner can manage workspaces');
  it('owner can transfer ownership');
  it('admin can manage members');
  it('admin can manage workspaces');
  it('admin cannot transfer ownership');
  it('member cannot manage members');
  it('member cannot manage workspaces');
  it('viewer has no management permissions');

  // Ownership transfer
  it('transfers ownership to existing member');
  it('old owner becomes admin after transfer');
  it('rejects transfer to non-member');
  it('rejects transfer by non-owner');

  // Owner protection
  it('prevents owner from leaving org');
  it('prevents removing owner from org');
  it('prevents demoting owner without transfer');
});
```

### 2. `tests/session-workspace.test.ts` - NEW FILE NEEDED

Test workspace switching and null workspace handling.

**Scenarios to cover:**
```typescript
describe('session workspace', () => {
  it('switches workspace within same org');
  it('clears workspace when switching orgs');
  it('handles null workspace_id gracefully');
  it('auto-selects default workspace when none set');
  it('persists last_workspace_id per org');
  it('restores last workspace on org switch');
  it('handles archived workspace in session');
});
```

### 3. `tests/soft-delete.test.ts` - NEW FILE NEEDED

Test archive behavior for orgs and workspaces.

**Scenarios to cover:**
```typescript
describe('soft delete', () => {
  // Workspace archival
  it('archives workspace without hard delete');
  it('archived workspace not in user list');
  it('archived workspace not in org list');
  it('archived workspace returns null from getWorkspace');
  it('preserves archived workspace data');

  // Org archival
  it('archives org and all its workspaces');
  it('removes members from archived org');
  it('triggers orphan check for removed members');
  it('archived org not in user org list');

  // Integration soft delete
  it('soft deletes integration with deleted_at');
  it('deleted integration not in list');
  it('deleted integration not passed to container');
});
```

### 4. `tests/audit-log.test.ts` - NEW FILE NEEDED

Test that all mutations create audit log entries.

**Scenarios to cover:**
```typescript
describe('audit logging', () => {
  // Org-level audit events
  it('logs org_created on createOrg');
  it('logs org_updated on updateOrgName');
  it('logs org_archived on archiveOrg');
  it('logs member_added on addMember');
  it('logs member_removed on removeMember');
  it('logs member_role_changed on updateMemberRole');
  it('logs ownership_transferred on transferOwnership');
  it('logs workspace_created on createWorkspace');

  // Workspace-level audit events
  it('logs workspace_updated on updateWorkspace');
  it('logs workspace_archived on archiveWorkspace');
  it('logs access_granted on setWorkspaceAccess (new)');
  it('logs access_changed on setWorkspaceAccess (update)');
  it('logs access_revoked on setWorkspaceAccess (none)');
  it('logs integration_created on createIntegration');
  it('logs integration_updated on updateIntegration');
  it('logs integration_deleted on deleteIntegration');

  // Audit log retrieval
  it('retrieves org audit log with pagination');
  it('retrieves workspace audit log with pagination');
  it('includes actor_id, target_id, details in entries');
});
```

---

## Missing Workers Runtime Tests (`workers/main/tests/`)

### 5. `workers/main/tests/container-routing.test.ts` - NEW FILE NEEDED

Test container ID derivation and workspace routing.

**Scenarios to cover:**
```typescript
describe('container routing', () => {
  it('derives container ID from workspace ID');
  it('sanitizes special characters in workspace ID');
  it('truncates long workspace IDs to 63 chars');
  it('prefixes container ID with ws-');
  it('routes WebSocket to correct container');
  it('passes workspaceId and orgId to container env');
  it('sets R2 prefix to {orgId}/{workspaceId}/');
});
```

### 6. `workers/main/tests/cross-do-consistency.test.ts` - NEW FILE NEEDED

Test OrgDO + UserDO + WorkspaceDO coordination.

**Scenarios to cover:**
```typescript
describe('cross-DO consistency', () => {
  // Membership sync
  it('addMember updates both OrgDO and UserDO');
  it('removeMember updates both OrgDO and UserDO');
  it('role change updates both OrgDO and UserDO');

  // Workspace registry
  it('createWorkspace adds to OrgDO.workspaces');
  it('archiveWorkspace updates OrgDO.workspaces');

  // Orphan handling
  it('removeMember sets is_orphaned when no orgs remain');
  it('acceptInvitation clears is_orphaned');
  it('handleOrphanedUserLogin creates org and workspace');

  // Ownership transfer
  it('transferOwnership updates roles in both DOs');

  // Org archival cascade
  it('archiveOrg archives all workspaces');
  it('archiveOrg removes all memberships');
  it('archiveOrg orphans users with no other orgs');
});
```

### 7. Enhance existing `workers/main/tests/workspace-do.test.ts`

Add missing coverage for:
```typescript
// Add these tests to existing file
it('creates integration and stores encrypted credentials');
it('updates integration and logs audit entry');
it('deletes integration (soft delete) and logs audit entry');
it('getIntegrations excludes soft-deleted entries');
it('lists workspace members with access levels');
```

---

## Missing Integration Tests (`tests/integration/`)

These tests require the dev server running and test actual HTTP endpoints.

### 8. `tests/integration/workspace-api.test.ts` - NEW FILE NEEDED

**Scenarios to cover:**
```typescript
describe('workspace API', () => {
  it('GET /api/workspaces lists user workspaces');
  it('POST /api/workspaces creates workspace (admin)');
  it('POST /api/workspaces rejects non-admin');
  it('GET /api/workspaces/[id] returns workspace details');
  it('PUT /api/workspaces/[id] updates workspace (admin)');
  it('DELETE /api/workspaces/[id] archives workspace (admin)');
  it('POST /api/auth/switch-workspace switches active workspace');
});
```

### 9. `tests/integration/workspace-auth.test.ts` - NEW FILE NEEDED

**Scenarios to cover:**
```typescript
describe('workspace auth', () => {
  it('requires workspace access for thread endpoints');
  it('returns 404 for workspace with none access');
  it('allows read for read_only access');
  it('denies write for read_only access');
  it('handles session with null workspace_id');
  it('handles session with archived workspace_id');
});
```

### 10. `tests/integration/ownership-transfer.test.ts` - NEW FILE NEEDED

**Scenarios to cover:**
```typescript
describe('ownership transfer', () => {
  it('POST /api/orgs/[id]/transfer-ownership succeeds for owner');
  it('rejects transfer by non-owner');
  it('rejects transfer to non-member');
  it('old owner becomes admin');
  it('new owner has owner role');
});
```

### 11. `tests/integration/orphan-recovery.test.ts` - NEW FILE NEEDED

**Scenarios to cover:**
```typescript
describe('orphan recovery', () => {
  it('user removed from only org becomes orphaned');
  it('orphaned user login creates new org');
  it('orphaned user login creates default workspace');
  it('orphaned user login clears orphan status');
  it('orphaned user accepting invite joins existing org');
  it('orphaned user accepting invite clears orphan status');
});
```

### 12. `tests/integration/integration-workspace.test.ts` - NEW FILE NEEDED

**Scenarios to cover:**
```typescript
describe('workspace integrations', () => {
  it('GET /api/workspaces/[id]/integrations lists integrations');
  it('POST /api/workspaces/[id]/integrations creates integration');
  it('PUT /api/workspaces/[id]/integrations/[iid] updates integration');
  it('DELETE /api/workspaces/[id]/integrations/[iid] deletes integration');
  it('integration env vars available in container');
});
```

---

## Enhancements to Existing Tests

### 13. `tests/orphan-user.test.ts` - ENHANCE

Current test only covers basic orphan recovery. Add:
```typescript
it('does not create org if orphan accepts invitation');
it('clears orphan status on invitation acceptance');
it('handles orphan with existing sessions');
```

### 14. `tests/workspace-permissions.test.ts` - ENHANCE

Current test only covers basic permission checks. Add:
```typescript
it('filters workspaces with none access from list');
it('allows owner to always access all workspaces');
it('default access is full for org members');
it('explicit none overrides default full');
```

### 15. `tests/avatar.test.ts` - ENHANCE

Add:
```typescript
it('generates consistent color for same input');
it('handles empty string input');
it('handles Unicode names correctly');
it('detects flag emoji as single emoji');
it('rejects multi-emoji strings');
```

---

## Implementation Notes

1. **Unit tests** should mock `@/lib/auth-do` and focus on logic testing
2. **Workers tests** run in Cloudflare runtime with real DOs - use `npm run test:workers`
3. **Integration tests** require dev server - use `npm run test:integration`
4. Follow existing patterns in each test directory
5. Use `vi.mock()` for unit tests, real RPC calls for workers tests

---

## Priority Order

1. **High Priority** (core functionality):
   - `audit-log.test.ts` (unit + workers)
   - `org-roles.test.ts`
   - `cross-do-consistency.test.ts`

2. **Medium Priority** (edge cases):
   - `soft-delete.test.ts`
   - `session-workspace.test.ts`
   - `container-routing.test.ts`

3. **Lower Priority** (API layer, already somewhat covered by unit tests):
   - Integration tests (workspace-api, workspace-auth, etc.)
   - Enhancements to existing tests

---

## Checklist

### New Test Files Needed
- [ ] `tests/org-roles.test.ts`
- [ ] `tests/session-workspace.test.ts`
- [ ] `tests/soft-delete.test.ts`
- [ ] `tests/audit-log.test.ts`
- [ ] `workers/main/tests/container-routing.test.ts`
- [ ] `workers/main/tests/cross-do-consistency.test.ts`
- [ ] `tests/integration/workspace-api.test.ts`
- [ ] `tests/integration/workspace-auth.test.ts`
- [ ] `tests/integration/ownership-transfer.test.ts`
- [ ] `tests/integration/orphan-recovery.test.ts`
- [ ] `tests/integration/integration-workspace.test.ts`

### Existing Test Enhancements
- [ ] Enhance `tests/orphan-user.test.ts`
- [ ] Enhance `tests/workspace-permissions.test.ts`
- [ ] Enhance `tests/avatar.test.ts`
- [ ] Enhance `workers/main/tests/workspace-do.test.ts`
