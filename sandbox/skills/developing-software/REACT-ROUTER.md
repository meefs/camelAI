# React Router Applications

Read this reference when adding routes, forms, APIs, or UI behavior to a web scaffold.

## Framework Mode

Use React Router 7 framework mode and define routes in `app/routes.ts`. Load server data with route `loader` functions and perform writes with `action` functions. Access Worker bindings through `context.cloudflare.env`.

Prefer:

- `<Form>` for navigational submissions.
- `useFetcher` or `<fetcher.Form>` for inline mutations that should not navigate.
- `fetcher.formData` for optimistic UI.
- `shouldRevalidate` only when suppressing loader revalidation is intentional.

Do not move ordinary server data fetching into client `useEffect` calls.

```tsx
export async function loader({ context }: Route.LoaderArgs) {
  return { items: await context.cloudflare.env.ITEMS.list() };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  await context.cloudflare.env.ITEMS.create(String(form.get("title")));
  return { ok: true };
}
```

## Routes and APIs

Add route modules and register them explicitly:

```ts
export default [
  index("routes/home.tsx"),
  route("api/items", "routes/api.items.ts"),
] satisfies RouteConfig;
```

Return `Response` objects for HTTP APIs and typed data for UI loaders/actions. Keep validation and authorization server-side.

## UI

Use seeded components from `~/components/ui/*`. Before hand-writing a standard component or page shell, call `add_shadcn_component`; it installs transitive registry dependencies and updates `package.json`.

Keep forms labeled, keyboard accessible, and explicit about pending, empty, success, and error states. Use `cn()` from `~/lib/utils` for class composition and Lucide icons already available in the scaffold.

## Build Safety

Keep the scaffold's build script, strict TypeScript settings, Worker entry, and `scripts/build-manifest.mjs`. Declare every imported package and build CLI in `package.json`. Fix type errors rather than weakening `tsconfig`.
