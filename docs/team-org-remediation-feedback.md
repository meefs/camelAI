# Team & Org Remediation — Review Feedback

## Bugs

### 1. `transferOrgOwnership` argument order is swapped in production (CRITICAL)

The production `transferOrgOwnership` in `src/lib/auth-do.ts:472` calls:
```typescript
await stub.transferOwnership(newOwnerId, actorId);
```

But the DO method signature at `workers/main/src/auth.ts:1598` is:
```typescript
async transferOwnership(actorId: string, newOwnerId: string)
```

The arguments are reversed. This means every ownership transfer attempt in production will fail with "Only the owner can transfer ownership" because `newOwnerId` is being checked as the actor.

The test helper at `workers/main/tests/test-helpers.ts:291` has the correct order (`actorId, newOwnerId`) — but the test helper was NOT updated to delegate to production for this function, so the bug is hidden. **This is exactly the shadow implementation problem the plan described.** The `transferOrgOwnership` in test-helpers is still a shadow copy.

**Fix:** In `src/lib/auth-do.ts:472`, swap the arguments to `stub.transferOwnership(actorId, newOwnerId)`. Then update `test-helpers.ts` to delegate `transferOrgOwnership` to the production function like the other functions were updated.

### 2. `archiveOrg` archives the org before archiving workspaces

In `src/lib/auth-do.ts:331-357`, the function calls `orgStub.archiveOrg(actorId)` first (line 333), then fetches and archives workspaces. After `archiveOrg()`, the org is marked as archived. If `getWorkspaces(true)` or `getMembers()` has any guard that skips archived orgs, the subsequent steps could silently fail. More importantly, if workspace archival fails partway through, the org is already archived with unarchived workspaces in a half-broken state.

**Fix:** Move `orgStub.archiveOrg(actorId)` to the end of the function, after workspaces are archived and members are cleaned up. Archive the org as the last step.

### 3. Connection duplication doesn't check for duplicate integration names

The `duplicateIntegration` action in `src/routes/_app.connections.tsx` copies the integration with the same `name` to the target workspace. But `WorkspaceDO.createIntegration()` will throw if an integration with that name and type already exists on the target workspace (it has a `integrationNameExists` check). The user has no way to rename during duplication.

**Fix:** Either catch the duplicate name error and return a user-friendly message, or append a suffix like " (copy)" to the name when duplicating.

## Issues

### 4. Double `requireAuthContext` call on workspaces action

In `src/routes/_app.settings.organization.workspaces.tsx:18`:
```typescript
const authContext = await requireOrgAdmin(request, context, (await requireAuthContext(request, context)).currentOrg.id);
```

This calls `requireAuthContext` once to get the org ID, then `requireOrgAdmin` calls it again internally. Two full auth context fetches per request.

**Fix:** Call `requireAuthContext` once, extract the org ID, then pass it to `requireOrgAdmin`. Or refactor `requireOrgAdmin` to accept an already-resolved auth context.

### 5. `transferOrgOwnership` in test-helpers is still a shadow copy

The commit successfully delegated `acceptInvitation`, `removeOrgMember`, `createWorkspace`, `archiveWorkspace`, `archiveOrg`, `checkUserOrphaned`, and `listOrgWorkspaces` to production. But `transferOrgOwnership` (test-helpers.ts:284-299) is still reimplemented locally. This is exactly how the shadow implementation problem works — if production transfer logic changes, the test won't catch it.

**Fix:** Delegate to `prodTransferOrgOwnership` like the other functions.

### 6. `as never[]` type casts on the team page

In `src/routes/_app.settings.organization.team.tsx:137-139`:
```typescript
members={members as never[]}
invitations={invitations as never[]}
workspaces={workspaces as never[]}
```

These `as never[]` casts suppress all type checking on the data passed to `TeamTable`. If the loader return type diverges from what the component expects, TypeScript won't catch it. This is likely left over from when the data wasn't available and should be cleaned up now that real data is being passed.

**Fix:** Type the props properly. The loader now returns `getOrgMembersWithWorkspaceAccess` results and `listOrgWorkspaces` results — the types should align with what `TeamTable` expects. Remove the `as never[]` casts.

### 7. Connection duplication access check is too permissive

The `duplicateIntegration` action checks `isOrgMember` for the target workspace, but any org member can duplicate connections. The plan specified this should be admin-only ("An org admin should be able to duplicate a connection"). A regular member could duplicate connections to workspaces they have access to.

**Fix:** Replace the `isOrgMember` check with `isOrgAdmin`.

## Missing from plan

### 8. Integration tests were written as workers tests, not HTTP integration tests

The plan specified: "These should be **integration tests** (real HTTP requests against the real dev server with real DOs) ... because that's the only layer that exercises the production code path end-to-end."

The new tests at `workers/main/tests/team-org-features.test.ts` are workers-level DO tests. They call test-helper functions (which now delegate to production), so they do test production logic — which is a meaningful improvement. However, they don't test the route handlers, form parsing, permission checks in loaders/actions, or the full request lifecycle. For example:
- The team page loader's `requireOrgAdmin` gating isn't tested
- The workspaces page's `requireOrgAdmin` gating isn't tested
- The `removeOrgMember` action's "non-admins can only remove themselves" logic isn't tested

**Fix:** Add HTTP-level integration tests (in `tests/integration/`) that exercise the route actions directly, especially for permission gating scenarios. The workers-level tests are good to keep for core logic, but they don't replace integration tests.

### 9. No test for connection duplication

The plan listed connection duplication tests:
- Create a connection on workspace A. Duplicate it to workspace B within the same org.
- Attempt to duplicate to a workspace in a different org. Should be rejected.

Neither test was written.

### 10. No test for billing status from OrgDO

The plan listed: "Create an org. Verify the org memberships list returns the actual `billing_status` from OrgDO (not hardcoded `'free'`)."

This test was not written. The loader change looks correct but has no test coverage.