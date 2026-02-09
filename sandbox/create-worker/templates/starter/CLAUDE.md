# Template Quick Reference

This file is for you (the agent) to quickly understand the project structure.

## Framework Overview

This is a **React Router 7** fullstack application (the successor to Remix) with **SSR enabled** running on Cloudflare Workers.

**Key architecture principles:**
- **Business logic belongs on the backend** - Use loaders and actions for data fetching and mutations, not client-side fetches
- **Use separate routes** - Each distinct page/feature should have its own route file in `app/routes/`
- **Loaders run on the server** - Fetch data in `loader()` functions, which run before rendering
- **Actions handle mutations** - Form submissions and data changes go through `action()` functions
- **Components are for UI** - Keep React components focused on rendering, not business logic
- **Default to framework mode patterns** - Prefer `<Form>`/`useFetcher` + revalidation and avoid SPA-style `useEffect` data loading unless explicitly required

```typescript
// Example route with loader (server) and component (client)
export async function loader({ context }: Route.LoaderArgs) {
  // Runs on server - access Cloudflare bindings, databases, etc.
  const data = await context.cloudflare.env.MY_DO.get(...).getData();
  return { data };
}

export async function action({ request, context }: Route.ActionArgs) {
  // Handles form submissions on server
  const formData = await request.formData();
  await context.cloudflare.env.MY_DO.get(...).saveData(formData);
  return { success: true };
}

export default function MyPage() {
  const { data } = useLoaderData<typeof loader>();  // Type-safe!
  return <div>{/* Render data */}</div>;
}
```

## Streaming with React Suspense (Recommended)

Use streaming when a loader has both critical and non-critical data, especially if the non-critical part may take a while. This keeps initial SSR fast and unblocks the UI earlier.

React Router supports Suspense streaming by returning promises from loaders/actions.

### 1. Return a promise from the loader

Return non-critical data as a promise (do not `await` it), and await only critical data needed for first paint.

```typescript
import type { Route } from "./+types/my-route";

export async function loader({}: Route.LoaderArgs) {
  // Not awaited on purpose: streamed later
  const nonCriticalData = new Promise<string>((res) =>
    setTimeout(() => res("non-critical"), 5000),
  );

  const criticalData = await new Promise<string>((res) =>
    setTimeout(() => res("critical"), 300),
  );

  // Must return an object with keys (not a single bare promise)
  return { nonCriticalData, criticalData };
}
```

### 2. Render fallback + resolved UI (React 19)

Use `React.Suspense` with `React.use()` in a child component to render fallback UI while non-critical data resolves.

```tsx
import * as React from "react";
import type { Route } from "./+types/my-route";

function NonCriticalUI({ p }: { p: Promise<string> }) {
  const value = React.use(p);
  return <h3>Non-critical value: {value}</h3>;
}

export default function MyComponent({ loaderData }: Route.ComponentProps) {
  const { criticalData, nonCriticalData } = loaderData;

  return (
    <div>
      <h1>Streaming example</h1>
      <h2>Critical data value: {criticalData}</h2>

      <React.Suspense fallback={<div>Loading...</div>}>
        <NonCriticalUI p={nonCriticalData} />
      </React.Suspense>
    </div>
  );
}
```

## Key Files

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Cloudflare config - bindings, migrations, secrets |
| `workers/app.ts` | Worker entry point - exports Durable Objects |
| `workers/example-do.ts` | Example Durable Object with SQLite |
| `workers/chat.ts` | Pre-configured AI chat agent (commented out) |
| `app/routes/` | React Router routes with loaders/actions |
| `app/schemas/` | Zod schemas shared between routes and DOs |

## Commands

```bash
bun dev                    # Local development
bun run deploy             # Deploy to Cloudflare
bun run test               # Run Vitest tests
bun run shadcn add <name>  # Add UI components
```

## Preinstalled Data Libraries

These are already included in the starter template and ready to import:

- `recharts` - Chart components for dashboards/visualizations
- `@tanstack/react-table` - Headless data table engine (sorting/filtering/pagination)
- `date-fns` - Date parsing/formatting/utilities
- `papaparse` - CSV parsing/export utilities
- `lodash-es` - General data manipulation helpers
- `react-is` - React element/type runtime checks (often used by UI tooling)

## Enabling Features

### Durable Objects (for persistence)

1. Uncomment bindings and migrations in `wrangler.jsonc`
2. The `ExampleDO` is ready to use - just enable it

### R2 Object Storage (for files/blobs)

R2 buckets are available for storing files, images, and any unstructured data. You can use any bucket name — buckets are created automatically, no setup required.

1. Add `r2_buckets` to `wrangler.jsonc`:
```jsonc
"r2_buckets": [
  { "binding": "MY_BUCKET", "bucket_name": "myapp-uploads" }
]
```
2. Run `bun wrangler types` to update Env
3. Use in loaders/actions: `context.cloudflare.env.MY_BUCKET.put(key, data)`

Multiple buckets with any names are supported — just add more entries to the array. Use project-specific bucket names (e.g. `myapp-uploads` not just `uploads`) to avoid collisions with other projects.

### AI Chat Agent

The template has a complete AI chat setup - just uncomment:

1. **wrangler.jsonc**: Uncomment `Chat` binding and add to migrations
2. **workers/app.ts**: Uncomment `routeAgentRequest` and `Chat` export
3. **app/routes.ts**: Add `route("chat", "routes/chat.tsx")`

**No API key setup needed** - `OPENROUTER_API_KEY` is automatically available:
- In deployed workers via `env.OPENROUTER_API_KEY`
- In your bash environment via `$OPENROUTER_API_KEY` (for ad hoc scripts/testing)

## Common Patterns

### Access Cloudflare Bindings

```typescript
export async function loader({ context }: Route.LoaderArgs) {
  const stub = context.cloudflare.env.MY_DO.get(
    context.cloudflare.env.MY_DO.idFromName("instance-id")
  );
  return await stub.myMethod();
}
```

### Add a New Durable Object

1. Create class in `workers/my-do.ts`
2. Export from `workers/app.ts`
3. Add binding to `wrangler.jsonc`
4. Add migration with incremented tag
5. Run `bun wrangler types` to update Env

## Common Pitfalls

- **useAgent uses `name`, not `id`**: `useAgent({ agent: "Chat", name: sessionId })`
- **Generate session IDs in loaders**, not in component body (causes re-render issues)
- **Use MarkdownRenderer for AI output** - AI responses are markdown-formatted
- **Use `bun run shadcn add`** - not `npx shadcn`
