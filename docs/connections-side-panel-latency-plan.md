# Connections Side Panel Latency Fix Plan

## Problem

The `/connections` side panel is using route search params as the source of truth for active selection. Clicking a row calls `setSearchParams({ selected: item.id })`, and `selectedId` is read back from `useSearchParams()` to decide the active row and panel content.

In React Router framework/data mode, a search-param navigation revalidates active route loaders unless the route or navigation opts out. That makes a cheap local UI interaction wait behind server work. On this page, the active loader stack is expensive enough that the panel opens slowly on the first click and can appear stale when switching between connections.

This is not primarily a `ConnectionPanel` rendering problem. The panel renders from already-loaded props; the slow path is the route navigation/revalidation triggered by changing `?selected=`.

## Evidence

- `src/components/pages/connections/connections-client.tsx`
  - `selectedId` comes from `searchParams.get("selected")` at line 213.
  - `selectedItem` is derived from `selectedId` at line 254.
  - row selection calls `setSearchParams({ selected: item.id })` at line 441.
  - rename also selects via `setSearchParams({ selected: item.id })` at line 540.
  - the desktop panel renders from `selectedItem` at lines 729-759.
  - the component also calls `revalidator.revalidate()` on mount/current org change at lines 344-348, which can compete with the first row click.
- `src/routes/_app.connections.tsx`
  - no `shouldRevalidate` export exists.
  - the loader starts with full auth context at line 473.
  - it lists integration records and creator profiles at lines 486-501.
  - it calls `WorkspaceFilesystemClient.listProjects()` for mentionable projects at lines 57-68 and 502-507.
  - it awaits workspace creator profile data before returning at lines 521-529.
  - the route gates the client behind `<Await resolve={Promise.all([connections, projects])}>` at lines 575-597.
- `src/routes/_app.tsx`
  - the parent layout `shouldRevalidate` returns `defaultShouldRevalidate` for search-param navigations at lines 43-55.
  - the parent loader also performs auth, migration-gate, chat-group, legacy, and billing-related work at lines 57-242.

## Root Cause

Changing the selected connection is modeled as navigation, not local UI state. The navigation changes only `?selected=...`, but both the app shell and `/connections` route treat it as loader-affecting by default. The new selected id is then read from the router location, so the visible active row and panel content are delayed until routing catches up.

The first click is often especially slow because `ConnectionsClient` kicks off a redundant `revalidator.revalidate()` immediately after the initial loader data has already rendered. Subsequent clicks keep hitting the same problem whenever a `?selected=` navigation triggers route work or waits behind in-flight route work.

## Target Behavior

- Clicking a connection row swaps the active row and side-panel contents immediately.
- The URL still reflects the active selection as `/connections?selected=<id>`.
- Refreshing or directly opening `/connections?selected=<id>` still opens that panel.
- Closing the panel removes only the `selected` query param.
- OAuth success/error/reauth query-param cleanup does not trigger unnecessary page-loader work.
- Real data mutations still revalidate connection data after success:
  - create
  - update/configure
  - rename
  - delete
  - duplicate/clone

## Implementation Plan

### 1. Add a Connections route revalidation helper

Create `src/lib/connections-route-revalidation.ts`.

Recommended shape:

```ts
const CONNECTIONS_UI_SEARCH_PARAMS = [
  "selected",
  "success",
  "error",
  "reason",
  "connection",
  "reauth",
] as const;

export function isConnectionsUiOnlySearchChange(currentUrl: URL, nextUrl: URL): boolean {
  if (currentUrl.pathname !== "/connections" || nextUrl.pathname !== "/connections") {
    return false;
  }
  if (currentUrl.search === nextUrl.search) {
    return false;
  }

  const current = stripSearchParams(currentUrl.searchParams, CONNECTIONS_UI_SEARCH_PARAMS);
  const next = stripSearchParams(nextUrl.searchParams, CONNECTIONS_UI_SEARCH_PARAMS);
  return searchParamsEqual(current, next);
}

export function shouldRevalidateConnectionsRoute({
  currentUrl,
  nextUrl,
  formData,
  defaultShouldRevalidate = true,
}: {
  currentUrl?: URL;
  nextUrl?: URL;
  formData?: FormData | null;
  defaultShouldRevalidate?: boolean;
}): boolean {
  if (!currentUrl || !nextUrl) return defaultShouldRevalidate;
  if (currentUrl.pathname !== nextUrl.pathname) return true;
  if (formData) return defaultShouldRevalidate;
  if (isConnectionsUiOnlySearchChange(currentUrl, nextUrl)) return false;
  return defaultShouldRevalidate;
}
```

Keep the helper conservative:

- Skip only when all changed search params are known UI-only params.
- Require an actual search change before skipping. Same-URL explicit revalidations must still return the router default.
- Return `true` on pathname changes.
- Return the router default for form submissions/fetcher submissions so real mutations keep refreshing data.
- Do not make all search params non-loader-affecting forever; future params may be loader inputs.

### 2. Wire `shouldRevalidate` into `/connections`

In `src/routes/_app.connections.tsx`:

```ts
import { shouldRevalidateConnectionsRoute } from "@/lib/connections-route-revalidation";

export function shouldRevalidate(
  args: Parameters<typeof shouldRevalidateConnectionsRoute>[0],
) {
  return shouldRevalidateConnectionsRoute(args);
}
```

This protects the `/connections` route loader from rerunning when only `selected`, OAuth cleanup params, or `connection/reauth` change.

### 3. Prevent parent app-shell revalidation for Connections UI params

The parent `_app.tsx` loader can also block a search-param navigation. Update `src/routes/_app.tsx` so its `shouldRevalidate` also skips `/connections` UI-only search changes.

Recommended shape:

```ts
import { isConnectionsUiOnlySearchChange } from "@/lib/connections-route-revalidation";

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formData,
  defaultShouldRevalidate,
}: {
  currentUrl?: URL;
  nextUrl?: URL;
  formData?: FormData;
  defaultShouldRevalidate: boolean;
}) {
  if (formData?.get("intent") === "createThreadAndStart") {
    return false;
  }

  if (!formData && currentUrl && nextUrl && isConnectionsUiOnlySearchChange(currentUrl, nextUrl)) {
    return false;
  }

  return defaultShouldRevalidate;
}
```

This makes browser back/forward and direct router navigations consistent, not just row clicks that pass navigation options.

### 4. Centralize Connections URL updates and opt out per navigation

In `ConnectionsClient`, replace direct `setSearchParams(...)` calls for UI-only query changes with small helpers.

Recommended helpers:

```ts
const updateUiSearchParams = useCallback(
  (mutate: (next: URLSearchParams) => void, options?: { replace?: boolean }) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        mutate(next);
        return next;
      },
      {
        replace: options?.replace,
        preventScrollReset: true,
        defaultShouldRevalidate: false,
      },
    );
  },
  [setSearchParams],
);

const setSelectedParam = useCallback(
  (id: string) => updateUiSearchParams((next) => next.set("selected", id)),
  [updateUiSearchParams],
);

const clearSelectedParam = useCallback(
  (options?: { replace?: boolean }) =>
    updateUiSearchParams((next) => next.delete("selected"), options),
  [updateUiSearchParams],
);
```

Use this helper for:

- row selection
- rename-start selection
- close button
- Escape key close
- stale selected-id cleanup
- OAuth success/error param cleanup
- `connection`/`reauth` cleanup after opening credential update UI

Important: do not keep using `setSearchParams({ selected: id })` or `setSearchParams({})` because those replace the full search string. Preserve unrelated query params and delete only the one being handled.

### 5. Make panel selection locally optimistic

Even with revalidation skipped, local optimistic selection makes the panel robust while the router is busy with unrelated work.

In `ConnectionsClient`:

- Rename the URL value to `urlSelectedId`.
- Add local state initialized from the URL.
- Derive `selectedItem` from local state.
- Sync local state when the URL changes from browser history, refresh hydration, or external navigation.

Recommended shape:

```ts
const urlSelectedId = searchParams.get("selected");
const [activeSelectedId, setActiveSelectedId] = useState(urlSelectedId);

useEffect(() => {
  setActiveSelectedId(urlSelectedId);
}, [urlSelectedId]);

const selectedItem = allItems.find((item) => item.id === activeSelectedId) ?? null;
```

Selection handlers should update state first, then update the URL:

```ts
const handleSelect = useCallback(
  (item: PanelItem) => {
    setActiveSelectedId(item.id);
    setSelectedParam(item.id);
  },
  [setSelectedParam],
);

const handleClosePanel = useCallback(() => {
  setActiveSelectedId(null);
  clearSelectedParam();
  setRenaming(null);
}, [clearSelectedParam]);
```

Adjust any checks that currently compare `selectedId` to use `activeSelectedId` when deciding visible UI state, for example delete-panel cleanup.

The stale-selection cleanup should clear both local state and URL when the active id no longer exists in `allItems`:

```ts
useEffect(() => {
  if (activeSelectedId && !selectedItem) {
    setActiveSelectedId(null);
    clearSelectedParam({ replace: true });
  }
}, [activeSelectedId, selectedItem, clearSelectedParam]);
```

Use `replace: true` for cleanup effects so invalid URLs do not add history entries.

### 6. Remove the mount-time revalidation

Remove or guard this effect in `ConnectionsClient`:

```ts
useEffect(() => {
  if (revalidator.state === "idle") {
    revalidator.revalidate();
  }
}, [currentOrg?.id]);
```

Preferred: remove it. The route has just received loader data, and normal route navigation/action success paths already revalidate. If there is a real org-change edge case, replace it with a previous-org ref that explicitly skips the first render:

```ts
const previousOrgId = useRef(currentOrg?.id ?? null);
useEffect(() => {
  const nextOrgId = currentOrg?.id ?? null;
  if (previousOrgId.current !== nextOrgId && revalidator.state === "idle") {
    revalidator.revalidate();
  }
  previousOrgId.current = nextOrgId;
}, [currentOrg?.id, revalidator]);
```

Do not keep an unconditional mount revalidation.

### 7. Keep mutation refresh behavior intact

Do not remove the existing explicit `revalidator.revalidate()` calls after successful create/edit/rename/delete/clone flows. Those are the right times to reload server data.

The revalidation helper should return the router default for form/fetcher submissions. If an action updates connection data and the default is true, it should still be allowed to run.

## Tests

Add focused unit tests first; they will catch the regression without needing a browser.

### New route revalidation tests

Create `tests/connections-route-revalidation.test.ts`.

Cover:

- `selected` added, changed, and removed on `/connections` returns `false` when `defaultShouldRevalidate` is `true`.
- OAuth UI params (`success`, `error`, `reason`) changing or being removed returns `false`.
- `connection`/`reauth` cleanup returns `false`.
- same-path/same-search explicit revalidation returns `defaultShouldRevalidate`.
- changing an unknown search param returns `defaultShouldRevalidate`.
- changing pathname returns `true`.
- form submissions return `defaultShouldRevalidate`.

Model the test style on `tests/chat-route-revalidation.test.ts`.

### Parent app revalidation tests

Update an existing app-loader test or add a small dedicated test to cover `_app.tsx.shouldRevalidate`:

- `/connections?selected=a` to `/connections?selected=b` returns `false`.
- `/chat?selected=a` to `/chat?selected=b` still returns the default.
- the existing `createThreadAndStart` behavior still returns `false`.

### Connections client behavior tests

Add or extend a client test:

- render `ConnectionsClient` with two connections.
- click the first row and assert the panel title shows the first connection.
- click the second row and assert the panel title changes to the second connection without closing.
- assert the selected row highlight moves.
- assert closing clears the selected panel.

If practical with `createMemoryRouter`, include a route loader spy and assert row clicks do not call the loader again. If that becomes brittle, keep this covered by the route revalidation helper tests and verify manually in browser devtools.

## Manual Verification

Run:

```bash
bun run test:run tests/connections-route-revalidation.test.ts tests/app-loader-sales-prompt.test.ts tests/connections-client-mentions.test.tsx
bun run typecheck
```

Then run the app and verify in the browser:

- Load `/connections`.
- Open the network panel.
- Click one connection, then another.
- The side panel should update immediately and stay open.
- No `/connections` route-data request should fire for `?selected=` changes.
- Close the panel; only `selected` should disappear from the URL.
- Refresh `/connections?selected=<id>`; the panel should open from the URL.
- Rename/delete/configure a connection; those actions should still refresh loader data after success.

## Non-Goals

- Do not move connection details into a new route.
- Do not fetch connection details on row click; the list already contains the panel data.
- Do not use `window.history.pushState` directly. Use React Router search-param navigation plus `shouldRevalidate` so back/forward and router state remain coherent.
- Do not remove project mention loading from the page loader as part of the main fix. If initial page load remains too slow after this, split projects from the initial `Promise.all` as a separate performance follow-up.

## Acceptance Criteria

- The first row click opens the panel without visible loader delay.
- Switching from one connection to another updates the panel title/details immediately.
- Selection deep links still work.
- Back/forward between selected connections works without stale panel content.
- Connection mutations still refresh data.
- Tests cover the revalidation guard and client selection swap.
