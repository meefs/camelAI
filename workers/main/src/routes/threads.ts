/**
 * Thread preview API route
 */

import type { RouteContext } from '../types.js';
import { getOrgStub, getThreadStub } from '../helpers/stubs.js';
import { json } from '../helpers/response.js';
import type { PreviewTarget } from '../chat-thread-do.js';
import { validateSandboxProxy } from '../sandbox-auth.js';

export async function handleThreadPreview({ req, env, match }: RouteContext): Promise<Response> {
  const threadId = match[1];

  const auth = validateSandboxProxy(req, env);
  if (!auth.valid) {
    return json({ error: 'Trusted deploy proxy identity required' }, 401);
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
    const orgStub = getOrgStub(env, auth.orgId);
    const script = await orgStub.getWorkerScript(scriptName);
    if (script) {
      if (script.workspace_id !== auth.workspaceId) {
        return json({ error: 'App does not belong to authenticated workspace' }, 403);
      }
      isPublic = script.is_public;
    } else {
      // Default for newly registered scripts.
      isPublic = true;
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
