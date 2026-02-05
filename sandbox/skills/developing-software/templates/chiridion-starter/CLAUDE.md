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
yarn dev      # Local development
yarn deploy   # Deploy to Cloudflare
yarn test     # Run Vitest tests
shadcn add    # Add UI components (globally installed)
```

## Enabling Features

### Durable Objects (for persistence)

1. Uncomment bindings and migrations in `wrangler.jsonc`
2. The `ExampleDO` is ready to use - just enable it

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
5. Run `wrangler types` to update Env

## Common Pitfalls

- **useAgent uses `name`, not `id`**: `useAgent({ agent: "Chat", name: sessionId })`
- **Generate session IDs in loaders**, not in component body (causes re-render issues)
- **Use MarkdownRenderer for AI output** - AI responses are markdown-formatted
- **Don't install wrangler locally** - use the global binary
- **Don't use npx for shadcn** - use `shadcn add` directly
