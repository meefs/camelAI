/**
 * WebSocket route for real-time log streaming
 *
 * Supports two auth methods:
 * 1. Session cookie (browser)
 * 2. Tail token (wrangler tail via CF API proxy)
 */

import type { RouteContext } from '../types.js';
import { requireSession } from '../helpers/auth.js';
import { validateSignedToken } from '../signed-tokens.js';
import { text } from '../helpers/response.js';
import { getOrgStub } from '../helpers/stubs.js';

export async function handleLogsWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const scriptName = url.searchParams.get('scriptName');
  if (!scriptName) {
    return text('Missing scriptName', 400);
  }

  const tailToken = url.searchParams.get('token');

  let orgSlug: string;
  let dispatchScriptName: string;

  if (tailToken) {
    // Token-based auth (from wrangler tail via CF API proxy)
    const payload = await validateSignedToken(env.TOKEN_SIGNING_SECRET, tailToken);
    if (!payload) {
      return text('Invalid tail token', 401);
    }

    if (!payload.scopes.includes('tail')) {
      return text('Token lacks tail scope', 403);
    }

    if (payload.script_name !== scriptName) {
      return text('Token script mismatch', 403);
    }

    orgSlug = payload.org_slug;
    dispatchScriptName = payload.dispatch_script_name;
  } else {
    // Session-based auth (browser)
    const auth = await requireSession(req, env);
    if ('error' in auth) return auth.error;

    const { session } = auth;
    const { org_id: orgId, user_id: userId } = session;

    if (!orgId) return text('No organization selected', 400);

    // Verify user is a member of the org and the script exists
    const orgStub = getOrgStub(env, orgId);
    const isMember = await orgStub.isMember(userId);
    if (!isMember) return text('Forbidden', 403);

    const script = await orgStub.getWorkerScript(scriptName);
    if (!script) return text('Script not found', 404);

    // Get org slug for dispatch script name
    const slug = await orgStub.getSlug();
    if (!slug) return text('Organization not configured', 500);

    orgSlug = slug;
    dispatchScriptName = `${scriptName}--${orgSlug}`;
  }

  // Forward WebSocket to WorkerLogsDO
  const logsStub = env.WORKER_LOGS.get(env.WORKER_LOGS.idFromName(dispatchScriptName));
  return logsStub.fetch(req);
}
