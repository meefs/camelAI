# Workspace Switcher Stability Plan

**Date:** 2026-07-08
**Primary files:**
- [src/components/sidebar/workspace-switcher.tsx](../src/components/sidebar/workspace-switcher.tsx) - switcher dropdown, lazy org-name fetch, row layout
- [src/hooks/use-auth-actions.ts](../src/hooks/use-auth-actions.ts) - `useSwitchWorkspace` / `useSwitchOrg`, post-switch revalidation
- [src/routes/_app.connections.tsx](../src/routes/_app.connections.tsx) - the route where the switch visibly never applies
- Reference only (verified correct, do not change): [src/routes/api/auth.switch-workspace.ts](../src/routes/api/auth.switch-workspace.ts), [src/routes/api/orgs.ts](../src/routes/api/orgs.ts), [src/lib/connections-route-revalidation.ts](../src/lib/connections-route-revalidation.ts)

## Objective

Two bugs in the workspace switcher (sidebar, top left):

1. **Row height jump while org names load.** Org names are fetched lazily from `/api/orgs` when the dropdown first opens. Until they arrive, a workspace row renders without its org line and is shorter; when names arrive the row grows. Keep the lazy fetch (it exists for auth-latency reasons, see the comment in [src/routes/api/orgs.ts](../src/routes/api/orgs.ts)) but reserve the org line's height and show a loading skeleton.
2. **Switching a workspace doesn't take effect until a manual page refresh.** Reliable repro: on `/connections`, pick another workspace in the switcher — the menu closes but neither the sidebar nor the page updates. After a refresh the app is on the new workspace, so the server-side switch succeeded; the client render is what's stuck.

## Bug 2 Root Cause: an inline `Promise.all` passed to `<Await>` wedges the revalidation commit

The switch flow is:

1. `useSwitchWorkspace().switchWorkspace(id)` POSTs `/api/auth/switch-workspace`. The server validates access and responds with a re-signed session cookie carrying the new `workspace_id` ([auth.switch-workspace.ts:128-135](../src/routes/api/auth.switch-workspace.ts)). The session lives in the signed cookie itself (no KV read), so every later request sees the new workspace. This is why refresh always works — the server side is fine.
2. The hook then calls `revalidator.revalidate()` ([use-auth-actions.ts:156](../src/hooks/use-auth-actions.ts)). All matched loaders re-run with the new cookie and return fresh data. The `shouldRevalidate` gates on `_app` and `/connections` return the default (`true`) for revalidator calls — verified, they are not the cause.
3. React Router applies the new loader data inside `React.startTransition`. If a component suspends during that transition render, React keeps the old UI, waits for the thrown promise, then **retries the render from the updated provider — re-running route components**.
4. [`_app.connections.tsx:614`](../src/routes/_app.connections.tsx) renders `<Await resolve={Promise.all([connections, projects])}>`. `<Await>` suspends by throwing any promise it has not seen before (it brands promises with a `_tracked` property — verified in react-router 7.16 source). Because the `Promise.all` is constructed **inline in render**, every retry of the suspended transition creates a brand-new untracked promise, so `<Await>` throws again, forever. The transition never commits. Everything in that commit — including the `_app` loader's `authState`, which drives the sidebar switcher — never appears. The dropdown still closes because local component state updates are urgent (non-transition). This matches the repro exactly.

Why nothing else breaks the same way:

- On **first navigation** to `/connections` the Suspense boundary is newly mounted, so the fallback commits, and the post-resolve retry re-renders only the boundary content with the *same* `<Await>` element (same, now-resolved promise prop). That's why the page loads fine and only revalidation wedges.
- Every other `<Await>` in `src/` receives a **stable loader-data field** (`_app.apps.tsx:249`, `_app.history.tsx:176`, `_app.chat._index.tsx:1001`, both usages in `_app.tsx`). Retries see the already-tracked promise and commit once it resolves. `/connections` is the only inline-promise instance (grep for `resolve={` confirms). That is why switching "sometimes works": it depends on which route is open.
- `useMemo(() => Promise.all(...), [connections, projects])` would **not** fix it: hook state only commits with the render, so while attempts keep suspending, the memo recomputes each retry. The combined promise must be created in the loader.

### Fix A (required): build one stable deferred payload in the connections loader

In [src/routes/_app.connections.tsx](../src/routes/_app.connections.tsx) `loader`:

```ts
// Promises passed to <Await> must be created here in the loader, never inline
// in render: a suspended revalidation transition recreates render-scoped
// promises on every retry and never commits.
const pageDataPromise = Promise.all([connectionsPromise, projectsPromise]).then(
  ([connections, projects]) => ({ connections, projects }),
);
```

- Return `pageData: pageDataPromise` and drop the separate `connections` / `projects` fields (this route module is their only consumer).
- Keep the existing per-promise `.catch(() => [])` handlers on `connectionsPromise` and `projectsPromise` so a failure still degrades to an empty list and the combined promise never rejects.
- In `ConnectionsPage`, render `<Await resolve={pageData}>` and destructure `{ connections, projects }` in the render callback. Keep the `Suspense` fallback, `HydrateFallback`, and `key={workspaceId}` on `ConnectionsClient` unchanged — once the commit lands, the key change remounts the client with fresh data (it also syncs via the `initialConnections` effect at [connections-client.tsx:300](../src/components/pages/connections/connections-client.tsx)).

### Fix B (required, small): await the revalidation in the switch hooks

In [src/hooks/use-auth-actions.ts](../src/hooks/use-auth-actions.ts), change `revalidator.revalidate();` to `await revalidator.revalidate();` in both `useSwitchWorkspace` (line 156) and `useSwitchOrg` (line 211), which has the identical pattern.

`revalidate()` returns a promise in React Router 7 that resolves when the revalidation's loaders finish and router state is applied. Effect: `isSwitching` / the row spinner span the data reload instead of clearing the moment the POST returns, so the menu closes only after the new workspace data is in — the switch reads as one atomic action instead of "closed, then nothing happened". Callers already `await switchWorkspace(...)` before navigating or submitting (workspace-switcher, [apps-client.tsx:153](../src/components/pages/apps/apps-client.tsx), [history-client.tsx:365](../src/components/pages/history/history-client.tsx)), so they sequence correctly with no signature change. Leave the abort/supersede logic untouched.

## Bug 1 Fix: height-stable org line with a loading skeleton

In [src/components/sidebar/workspace-switcher.tsx](../src/components/sidebar/workspace-switcher.tsx):

1. **Reserve the org line's height.** The wrapper at line 172 (`<div className="flex items-center gap-1">`) collapses to 0 when `orgName` is null. Add `h-4` (`flex h-4 items-center gap-1`): Tailwind's `text-xs` line height is 1rem, so rows with a loaded name keep exactly the same height and rows without one no longer shrink.
2. **Show a skeleton while names load.** Inside the wrapper:
   - `orgName` present → the existing span (rows for the current org resolve immediately from the `authState.orgs` seed, so skeletons mostly appear on other orgs' workspaces).
   - Name unknown and the org list not yet loaded (`!orgsFetcher.data`) → `<Skeleton className="h-3 w-20" />` from `@/components/ui/skeleton`.
   - Name unknown after the list loaded → render nothing; the `h-4` wrapper preserves the height.
3. **Replace the `orgsRequested` latch with a derived condition** so a failed fetch retries on the next open instead of leaving skeletons forever:

```tsx
onOpenChange={(open) => {
  if (open && !orgsFetcher.data && orgsFetcher.state === "idle") {
    orgsFetcher.load("/api/orgs")
  }
}}
```

Delete the `orgsRequested` state. Do not change `/api/orgs` or move org names back into the auth critical path.

## Out of Scope

- Server-side switch behavior (`auth.switch-workspace.ts` is correct; the cookie is the source of truth).
- `shouldRevalidate` logic in `_app.tsx` / `connections-route-revalidation.ts` (verified: returns default `true` for revalidator-triggered revalidation).
- `/api/orgs` latency work, chat-groups websocket revalidation, and the `navigate("/chat")`-after-switch behavior for `/chat/:id` routes (pre-existing, unchanged by Fix B beyond better sequencing).

## Test Plan

1. **New loader test** (e.g. `tests/connections-loader-pagedata.test.ts`, reusing the module-mock scaffolding from [tests/connections-action.test.ts](../tests/connections-action.test.ts)): calling `loader()` returns a single `pageData` promise that resolves to `{ connections, projects }`; when `listWorkspaceIntegrationRecords` rejects, `pageData` still **resolves** with `connections: []` rather than rejecting.
2. **Switcher org-line test**: extract the row body (name + org line with the skeleton/empty logic) into a small exported presentational component in `workspace-switcher.tsx` and unit-test its three states (name present / loading / loaded-but-missing), asserting the org-line wrapper is always rendered. This avoids driving a Radix dropdown in jsdom.
3. Existing suites and types:

```bash
bun run test:run -- tests/connections-route-revalidation.test.ts tests/connections-action.test.ts
bun run typecheck
```

4. **Manual repro checks** (`bun run dev`, an account with 2+ orgs and several workspaces):
   - On `/connections`, switch workspaces: sidebar switcher and page content update to the new workspace without a refresh; the trigger spinner runs until the new data renders.
   - Open the switcher fresh: rows keep a constant height while org names load (skeleton visible, no growth when names arrive).
   - Switch to a workspace in a *different* org (exercises the `switchSessionOrg` path).
   - Switch from `/apps`, `/history`, and from an open `/chat/:id` (should land on `/chat`).

## Acceptance Criteria

- Switching workspaces from `/connections` updates the sidebar and page content without a manual refresh; no route in the app requires a refresh after switching.
- The switch control shows a pending state until the new workspace's data is rendered, and dropdown items stay disabled while a switch is in flight.
- Workspace rows in the dropdown have identical heights before, during, and after org names load; a skeleton occupies the org line while loading, and a failed org-name fetch retries the next time the menu opens.
- `<Await>` in the connections route receives a promise created in the loader, with a comment explaining why it must stay that way.
