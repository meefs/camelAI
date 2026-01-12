# {{PROJECT_NAME}}

A React app running on Cloudflare Workers with Vite, React Router, Tailwind CSS, and shadcn/ui.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐
│   React SPA     │────▶│   Cloudflare Worker  │
│  (Vite build)   │◀────│   (API + Assets)     │
└─────────────────┘     └──────────────────────┘
```

The worker serves two purposes:
1. **API routes** - Handle `/api/*` requests directly in the worker
2. **Static assets** - Serve the Vite-built React SPA for all other routes

## Getting Started

```bash
# Install dependencies
npm install

# Start local development
npm run dev

# Build for production
npm run build

# Deploy to Cloudflare
npm run deploy
# or: wrangler deploy
```

## Project Structure

```
{{PROJECT_NAME}}/
├── src/                    # React app source
│   ├── main.tsx            # App entry point with React Router
│   ├── App.tsx             # Main app component
│   ├── index.css           # Tailwind styles
│   ├── components/         # React components
│   │   └── ui/             # shadcn/ui components
│   └── lib/
│       └── utils.ts        # cn() helper for Tailwind
├── workers/
│   └── src/
│       ├── index.ts        # Worker entry point (API + asset serving)
│       └── durable-objects.example.ts  # Example DO with SQLite
├── index.html              # HTML template
├── vite.config.ts          # Vite configuration
├── wrangler.jsonc          # Cloudflare Worker config
├── components.json         # shadcn/ui config
└── package.json
```

## Adding shadcn/ui Components

shadcn/ui is pre-configured. Add components with:

```bash
npx shadcn@latest add button
npx shadcn@latest add card
npx shadcn@latest add form input label
```

## Adding API Routes

Edit `workers/src/index.ts` to add API routes:

```typescript
async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/api/items" && request.method === "GET") {
    // Get items from Durable Object
    const id = env.MY_DO.idFromName("global");
    const stub = env.MY_DO.get(id);
    return stub.fetch(request);
  }

  // ... existing routes
}
```

## Adding Durable Objects

1. Copy `workers/src/durable-objects.example.ts` to a new file
2. Customize the class
3. Export from `workers/src/index.ts`
4. Add binding to `wrangler.jsonc`

See the example file for detailed instructions.

## Client-Side Routing

React Router handles client-side navigation. Add routes in `src/main.tsx`:

```tsx
<Routes>
  <Route path="/" element={<App />} />
  <Route path="/about" element={<About />} />
  <Route path="/dashboard" element={<Dashboard />} />
</Routes>
```

The worker serves `index.html` for all non-API routes, allowing React Router to handle navigation.

## Environment Variables

Create `.dev.vars` for local development:

```
MY_SECRET=your_secret_here
```

Access in workers via `env.MY_SECRET`.

For client-side env vars, use Vite's `VITE_` prefix in `.env`:

```
VITE_API_URL=https://api.example.com
```

Access via `import.meta.env.VITE_API_URL`.
