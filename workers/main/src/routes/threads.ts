/**
 * Thread preview API route
 */

import type { RouteContext } from '../types.js';
import { isSignedToken, validateSignedToken } from '../signed-tokens.js';
import { getThreadStub } from '../helpers/stubs.js';
import { json } from '../helpers/response.js';

export async function handleThreadPreview({ req, env, match }: RouteContext): Promise<Response> {
  const threadId = match[1];

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Missing authorization' }, 401);

  const token = authHeader.slice(7);
  if (!isSignedToken(token)) return json({ error: 'Invalid token format' }, 401);

  const payload = await validateSignedToken(env.TOKEN_SIGNING_SECRET, token);
  if (!payload || !payload.scopes.includes('deploy') || !payload.workspace_id) {
    return json({ error: 'Invalid token' }, 401);
  }

  const body = (await req.json()) as { workers?: string[] };
  if (!body.workers || !Array.isArray(body.workers)) {
    return json({ error: 'Missing workers array' }, 400);
  }

  const workers = body.workers.map((n) => n.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63));
  const res = await getThreadStub(env, threadId).fetch(
    new Request('http://internal/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workers }),
    })
  );

  if (!res.ok) return new Response(res.body, { status: res.status, headers: res.headers });
  return json({ workers, urls: workers.map((w) => `https://${w}.chiridion.app`) });
}
