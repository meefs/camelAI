# {{PROJECT_NAME}}

A fullstack Next.js 15 application deployed to Cloudflare Workers.

## Getting Started

```bash
npm install
npm run dev       # Local development
wrangler deploy   # Deploy to Cloudflare
```

## Project Structure

```
├── src/
│   └── app/                  # Next.js App Router
│       ├── layout.tsx        # Root layout
│       ├── page.tsx          # Home page
│       ├── globals.css       # Global styles (Tailwind)
│       └── api/              # API routes
│           └── hello/route.ts
├── workers/
│   └── src/
│       └── index.ts          # Custom worker entry point
├── wrangler.jsonc            # Cloudflare configuration
└── package.json
```

## Architecture

This project uses a **custom worker entry point** (`workers/src/index.ts`) that wraps OpenNext. This allows you to:

- Add Durable Objects for persistent storage
- Handle WebSocket connections
- Add custom API routes that bypass Next.js
- Use Cloudflare-specific features (KV, R2, AI, etc.)

```
┌─────────────────────────────────────────────────┐
│              workers/src/index.ts               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │  WebSocket  │  │  Custom API │  │   DOs   │ │
│  └──────┬──────┘  └──────┬──────┘  └────┬────┘ │
│         │                │              │       │
│         └────────┬───────┴──────────────┘       │
│                  ▼                              │
│         ┌───────────────┐                       │
│         │   OpenNext    │ ◄── Next.js pages     │
│         └───────────────┘                       │
└─────────────────────────────────────────────────┘
```

## Next.js Best Practices

### Use Server Components by Default

All components in the App Router are **Server Components** by default. They run on the server and send HTML to the client—no JavaScript bundle.

```tsx
// app/users/page.tsx - This is a Server Component
export default async function UsersPage() {
  const users = await db.query("SELECT * FROM users"); // Direct DB access!

  return (
    <ul>
      {users.map(user => <li key={user.id}>{user.name}</li>)}
    </ul>
  );
}
```

Only add `"use client"` when you need:
- Event handlers (`onClick`, `onChange`)
- Hooks (`useState`, `useEffect`)
- Browser-only APIs

### Use Server Actions for Mutations

**Server Actions** replace API routes for form submissions and mutations. They're simpler and type-safe.

```tsx
// app/actions.ts
"use server";

export async function createUser(formData: FormData) {
  const name = formData.get("name") as string;
  await db.exec("INSERT INTO users (name) VALUES (?)", name);
  revalidatePath("/users");
}
```

```tsx
// app/users/new/page.tsx
import { createUser } from "../actions";

export default function NewUserPage() {
  return (
    <form action={createUser}>
      <input name="name" required />
      <button type="submit">Create</button>
    </form>
  );
}
```

**Benefits over API routes:**
- No `fetch()` calls or state management
- Automatic form handling with `useFormStatus`
- Works with or without JavaScript
- Type-safe end-to-end

### Data Fetching in Server Components

Fetch data directly in Server Components—no `useEffect` or loading states needed:

```tsx
// app/posts/[id]/page.tsx
export default async function PostPage({ params }: { params: { id: string } }) {
  const post = await getPost(params.id); // Runs on server

  return <article>{post.content}</article>;
}
```

For parallel data fetching:

```tsx
export default async function DashboardPage() {
  // These run in parallel, not sequentially
  const [users, posts, stats] = await Promise.all([
    getUsers(),
    getPosts(),
    getStats(),
  ]);

  return <Dashboard users={users} posts={posts} stats={stats} />;
}
```

### Use `loading.tsx` for Streaming

Add a `loading.tsx` file to show instant loading UI while data fetches:

```tsx
// app/posts/loading.tsx
export default function Loading() {
  return <div className="animate-pulse">Loading posts...</div>;
}
```

Next.js automatically wraps your page in a Suspense boundary.

### Colocate Related Files

Keep components, actions, and types close to where they're used:

```
app/
├── users/
│   ├── page.tsx          # /users page
│   ├── actions.ts        # Server actions for users
│   ├── user-card.tsx     # User-specific component
│   └── [id]/
│       └── page.tsx      # /users/[id] page
```

### Metadata and SEO

Use the `metadata` export for SEO:

```tsx
// app/about/page.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About Us",
  description: "Learn more about our company",
};

export default function AboutPage() {
  return <h1>About Us</h1>;
}
```

For dynamic metadata:

```tsx
export async function generateMetadata({ params }): Promise<Metadata> {
  const post = await getPost(params.id);
  return { title: post.title };
}
```

## Durable Objects with SQLite

This template includes an **example** Durable Object with SQLite backend at `workers/src/durable-objects.example.ts`. Copy and customize it for your needs.

Each DO instance has its own private SQLite database (up to 10GB).

### The Example: NotesDO

See `workers/src/durable-objects.example.ts` for a complete reference with:
- Schema migrations (versioned, idempotent)
- CRUD operations (list, get, create, update, delete)
- Search functionality
- TypeScript types

### Using DOs with Server Actions

The recommended way to use Durable Objects in Next.js is through **Server Actions**:

```typescript
// app/notes/actions.ts
"use server";

import { getRequestContext } from "@cloudflare/next-on-pages";
import { revalidatePath } from "next/cache";

export async function getNotes() {
  const { env } = getRequestContext();
  const id = env.NOTES.idFromName("default"); // One DO per user/tenant
  const stub = env.NOTES.get(id);
  return stub.list();
}

export async function createNote(formData: FormData) {
  const title = formData.get("title") as string;
  const content = formData.get("content") as string;

  const { env } = getRequestContext();
  const id = env.NOTES.idFromName("default");
  const stub = env.NOTES.get(id);

  await stub.create(title, content);
  revalidatePath("/notes");
}

export async function deleteNote(noteId: string) {
  const { env } = getRequestContext();
  const id = env.NOTES.idFromName("default");
  const stub = env.NOTES.get(id);

  await stub.delete(noteId);
  revalidatePath("/notes");
}
```

### Using in a Page

```tsx
// app/notes/page.tsx
import { getNotes, createNote, deleteNote } from "./actions";

export default async function NotesPage() {
  const notes = await getNotes();

  return (
    <div>
      <h1>Notes</h1>

      {/* Create form - uses Server Action directly */}
      <form action={createNote}>
        <input name="title" placeholder="Title" required />
        <textarea name="content" placeholder="Content" />
        <button type="submit">Add Note</button>
      </form>

      {/* List notes */}
      <ul>
        {notes.map(note => (
          <li key={note.id}>
            <h3>{note.title}</h3>
            <p>{note.content}</p>
            <form action={deleteNote.bind(null, note.id)}>
              <button type="submit">Delete</button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### DO Naming Patterns

Use `idFromName()` to create deterministic DO instances:

```typescript
// One DO per user (isolated data)
const id = env.NOTES.idFromName(`user-${userId}`);

// One global DO (shared data)
const id = env.NOTES.idFromName("global");

// One DO per tenant/org
const id = env.NOTES.idFromName(`org-${orgId}`);
```

### Adding More DOs

1. Create your class in `workers/src/durable-objects.ts`
2. Export it from `workers/src/index.ts`
3. Add binding to `wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "NOTES", "class_name": "NotesDO" },
      { "name": "SESSIONS", "class_name": "SessionDO" }  // New DO
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["NotesDO"] },
    { "tag": "v2", "new_sqlite_classes": ["SessionDO"] }  // New migration
  ]
}
```

## Environment Variables

For local development, create `.dev.vars`:

```
MY_SECRET=your-secret-value
```

For production, use Wrangler:

```bash
wrangler secret put MY_SECRET
```

## Deployment

```bash
# Build and deploy
npm run deploy

# Or step by step:
npm run build:cf    # Build with OpenNext
wrangler deploy     # Deploy to Cloudflare
```

## Learn More

- [Next.js App Router](https://nextjs.org/docs/app)
- [Server Actions](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [OpenNext for Cloudflare](https://opennext.js.org/cloudflare)
