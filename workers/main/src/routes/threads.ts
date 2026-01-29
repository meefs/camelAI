/**
 * Thread preview API route
 */

import type { RouteContext } from '../types.js';
import { isSignedToken, validateSignedToken } from '../signed-tokens.js';
import { getOrgStub, getThreadStub } from '../helpers/stubs.js';
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
  let isPublic = false;
  if (workers[0]) {
    try {
      const orgStub = getOrgStub(env, payload.org_id);
      const script = await orgStub.getWorkerScript(workers[0]);
      if (script) {
        isPublic = script.is_public;
      } else {
        const stored = await env.API_TOKENS.get(`script_org:${workers[0]}`);
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as { is_public?: boolean };
            if (typeof parsed.is_public === 'boolean') {
              isPublic = parsed.is_public;
            } else {
              isPublic = true;
            }
          } catch {
            isPublic = true;
          }
        } else {
          // Default for newly registered scripts
          isPublic = true;
        }
      }
    } catch (err) {
      console.error('[handleThreadPreview] Failed to load app visibility', err);
    }
  }
  const res = await getThreadStub(env, threadId).fetch(
    new Request('http://internal/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workers, isPublic }),
    })
  );

  if (!res.ok) return new Response(res.body, { status: res.status, headers: res.headers });
  return json({ workers, urls: workers.map((w) => `https://${w}.chiridion.app`) });
}
