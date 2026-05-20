/**
 * Thread preview API route
 */

import type { RouteContext } from '../types.js';
import { isSignedToken, validateSignedToken } from '../signed-tokens.js';
import { getOrgStub, getThreadStub } from '../helpers/stubs.js';
import { json } from '../helpers/response.js';
import type { PreviewTarget } from '../chat-thread-do.js';

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

  const body = (await req.json()) as { scriptName?: string };
  const rawScriptName = typeof body.scriptName === 'string' ? body.scriptName : '';
  if (!rawScriptName) {
    return json({ error: 'Missing scriptName' }, 400);
  }

  const scriptName = rawScriptName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63);
  if (!scriptName) {
    return json({ error: 'Invalid scriptName' }, 400);
  }

  let isPublic = false;
  try {
    const orgStub = getOrgStub(env, payload.org_id);
    const script = await orgStub.getWorkerScript(scriptName);
    if (script) {
      isPublic = script.is_public;
    } else {
      const stored = await env.APP_KV.get(`script_org:${scriptName}`);
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

  const target: PreviewTarget = {
    kind: 'app',
    scriptName,
    isPublic,
  };

  const res = await getThreadStub(env, threadId).fetch(
    new Request('http://internal/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    })
  );

  if (!res.ok) return new Response(res.body, { status: res.status, headers: res.headers });
  return json({ target, url: `https://${scriptName}.camelai.app` });
}
