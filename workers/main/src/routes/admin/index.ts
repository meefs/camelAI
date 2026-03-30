/**
 * Admin REST API — Hono-based
 *
 * All endpoints require Bearer token auth via ADMIN_API_KEY secret.
 * If no Bearer token is present, returns null to fall through to
 * React Router (for session-auth admin routes like /api/admin/threads/:id/jsonl).
 *
 * The OpenAPI 3.1 spec is auto-generated from the openApi() middleware
 * on each route via createOpenApiDocument(). No separate spec file needed.
 *
 * Routes:
 *   GET   /api/admin/openapi.json          — OpenAPI 3.1 spec (auto-generated)
 *   GET   /api/admin/stats                 — Aggregate counts
 *   GET   /api/admin/users                 — All users
 *   GET   /api/admin/users/:id/orgs        — User's orgs
 *   GET   /api/admin/spam/org-ids          — Spam org IDs from effective spend limits
 *   GET   /api/admin/orgs                  — All orgs (enriched)
 *   GET   /api/admin/dashboard/top-orgs    — Top orgs by spend or member count
 *   GET   /api/admin/dashboard/summary     — Dashboard summary metrics
 *   GET   /api/admin/dashboard/retention   — Dashboard retention metrics
 *   GET   /api/admin/dashboard/spam-summary — Spam-tab entity + usage snapshot
 *   GET   /api/admin/threads               — All threads
 *   GET   /api/admin/threads/:id/messages  — Parsed thread messages
 *   POST  /api/admin/orgs/:id/members      — Add member to org
 *   PUT   /api/admin/signup-blocked-ips/:ip — Block signup attempts from an IP
 *   DELETE /api/admin/signup-blocked-ips/:ip — Remove an IP from the signup blocklist
 *   PATCH /api/admin/threads/:id           — Update thread
 *   GET   /api/admin/kv                    — List KV keys
 *   GET   /api/admin/kv/:key              — Get KV value
 *   GET   /api/admin/r2                    — List R2 objects
 *   GET   /api/admin/r2/:key+             — R2 object metadata
 */

import { Hono } from 'hono';
import { createOpenApiDocument } from 'hono-zod-openapi';
import type { Env, RouteContext } from '../../types.js';
import { routes } from './routes.js';

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>().basePath('/api/admin');

// All admin routes (each has openApi() middleware for spec generation)
app.route('/', routes);

// Auto-generate and serve OpenAPI spec from route middleware declarations
createOpenApiDocument(app, {
  info: {
    title: 'camelAI Admin API',
    version: '1.0.0',
    description:
      'Internal admin API for managing users, orgs, threads, and storage. All endpoints require Bearer token auth via ADMIN_API_KEY.',
  },
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'ADMIN_API_KEY set via `wrangler secret put ADMIN_API_KEY`',
      },
    },
  },
}, { routeName: '/openapi.json' });

// Error handler
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : 'Unknown error';
  return c.json({ error: message }, 500);
});

// Authed requests to unknown paths → 404
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// ---------------------------------------------------------------------------
// Export: wrapper that preserves the null-return contract
// ---------------------------------------------------------------------------

export async function handleAdminApi({ req, env }: RouteContext): Promise<Response | null> {
  // No Bearer token → fall through to React Router (session-auth admin routes)
  const auth = req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;

  const key = env.ADMIN_API_KEY;
  if (!key) {
    return Response.json({ error: 'Admin API not configured' }, {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (auth !== `Bearer ${key}`) {
    return Response.json({ error: 'Unauthorized' }, {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Auth passed → delegate to Hono
  return app.fetch(req, env);
}
