/**
 * Chiridion Dispatch Worker
 *
 * Routes requests to user workers deployed in the Workers for Platforms
 * dispatch namespace. Supports subdomain-based routing with private worker
 * access control.
 *
 * Example: hello-world.apps.chiridion.ai -> routes to worker "hello-world" (same-site for iframe)
 *          hello-world.chiridion.app -> routes to worker "hello-world" (vanity URL)
 *
 * Private worker authentication:
 *
 * Same-site requests (*.chiridion.ai):
 * - Main app session cookie is available (same domain)
 * - Validates session directly via RPC, no redirect needed
 * - Checks if user is a member of the workspace that deployed the worker
 *
 * Cross-site requests (*.chiridion.app vanity URLs):
 * 1. User visits private worker
 * 2. Dispatcher checks dispatcher session cookie
 * 3. If no session, redirects to main app for auth
 * 4. Main app validates user and redirects back with token
 * 5. Dispatcher validates token and creates session cookie
 */

import {
  getDispatcherSession,
  createDispatcherSession,
  validateAndConsumeAuthToken,
  validateAndConsumeScreenshotToken,
  createScreenshotSession,
  getScreenshotSession,
  SCREENSHOT_SESSION_COOKIE,
  SCREENSHOT_SESSION_TTL_SECONDS,
  createAuthState,
  DISPATCHER_SESSION_COOKIE,
  type DispatcherSession,
} from '../../main/src/worker-auth';
import { getSession as getSessionKV, type SessionData } from '../../main/src/session-kv';
import type { OrgDO } from '../../main/src/auth';

interface Env {
  DISPATCHER: {
    get(name: string): {
      fetch(request: Request): Promise<Response>;
    };
  };
  API_TOKENS: KVNamespace;
  SESSIONS: KVNamespace;
  ORG: DurableObjectNamespace<OrgDO>;
  // Set to "true" to skip all auth checks (local development only)
  SKIP_AUTH?: string;
}

// Helper functions to replace RPC calls

/**
 * Get worker script access info from KV index
 */
async function getWorkerAccessInfo(
  kv: KVNamespace,
  scriptName: string
): Promise<{ is_public: boolean; org_id: string } | null> {
  const data = await kv.get(`script_org:${scriptName}`);
  if (!data) return null;
  return JSON.parse(data) as { org_id: string; is_public: boolean };
}

/**
 * Check if user is a member of an org
 */
async function isOrgMember(
  orgNamespace: DurableObjectNamespace<OrgDO>,
  userId: string,
  orgId: string
): Promise<boolean> {
  const stub = orgNamespace.get(orgNamespace.idFromName(orgId)) as DurableObjectStub<OrgDO>;
  return stub.isMember(userId);
}

// Cookie settings for dispatcher session
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const SCREENSHOT_SESSION_MAX_AGE = SCREENSHOT_SESSION_TTL_SECONDS;

// Main app session cookie name (same-site requests will have this)
const MAIN_APP_SESSION_COOKIE = 'chiridion_session_v2';
const LEGACY_MAIN_APP_SESSION_COOKIE = 'chiridion_session';

// Main app URL for auth redirects (determined from request hostname)
function getMainAppUrl(hostname: string): string {
  // Extract environment from hostname
  // e.g., worker.dev-miguel.chiridion.app -> dev-miguel.chiridion.ai (main app)
  // e.g., worker.chiridion.app -> chiridion.ai (main app)
  const parts = hostname.split('.');
  if (parts.length >= 3) {
    // Remove the first part (subdomain/worker name)
    // Convert .chiridion.app to .chiridion.ai for main app redirect
    const remaining = parts.slice(1).join('.');
    const mainAppHost = remaining.replace('.chiridion.app', '.chiridion.ai').replace(/^chiridion\.app$/, 'chiridion.ai');
    return `https://${mainAppHost}`;
  }
  // Fallback to chiridion.ai
  return 'https://chiridion.ai';
}

// Parse cookie value from Cookie header
function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.split('=');
    if (key === name) {
      return valueParts.join('=');
    }
  }
  return null;
}

// Create Set-Cookie header for session
function createSessionCookie(sessionId: string, hostname: string): string {
  // Get domain for cookie (e.g., .chiridion.app to cover all subdomains)
  const parts = hostname.split('.');
  const domain = parts.length >= 2 ? `.${parts.slice(-2).join('.')}` : hostname;

  return [
    `${DISPATCHER_SESSION_COOKIE}=${sessionId}`,
    `Path=/`,
    `Domain=${domain}`,
    `Max-Age=${SESSION_MAX_AGE}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

// Create Set-Cookie header for screenshot sessions (host-only)
function createScreenshotSessionCookie(sessionId: string): string {
  return [
    `${SCREENSHOT_SESSION_COOKIE}=${sessionId}`,
    `Path=/`,
    `Max-Age=${SCREENSHOT_SESSION_MAX_AGE}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

// Check if request is from same-site (any *.chiridion.ai subdomain)
// These requests will have the main app session cookie available since they share the same domain
function isSameSiteRequest(hostname: string): boolean {
  return hostname.endsWith('.chiridion.ai');
}

// Auth callback route
const AUTH_CALLBACK_PATH = '/__chiridion_auth/callback';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Check for subdomain-based routing (e.g., hello-world.chiridion.app)
    // Skip for apex domain and www
    const hostParts = hostname.split('.');
    if (hostParts.length >= 3 || (hostParts.length === 2 && !hostname.includes('workers.dev'))) {
      const subdomain = hostParts[0];

      if (subdomain && subdomain !== 'www' && subdomain !== 'chiridion') {
        // Handle auth callback route
        if (url.pathname === AUTH_CALLBACK_PATH) {
          return handleAuthCallback(request, env, subdomain);
        }

        // Check worker access
        return handleWorkerRequest(request, env, subdomain);
      }
    }

    // Default response for apex domain
    return new Response(
      JSON.stringify(
        {
          message: 'Chiridion Dispatch Worker',
          routes: {
            vanity: '<worker-name>.chiridion.app',
            iframe: '<worker-name>.apps.chiridion.ai',
          },
          example: 'hello-world.chiridion.app',
        },
        null,
        2
      ),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};

/**
 * Handle auth callback - validates token and creates session
 */
async function handleAuthCallback(request: Request, env: Env, scriptName: string): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const state = url.searchParams.get('state');

  if (!token || !state) {
    return new Response('Missing token or state parameter', { status: 400 });
  }

  // Validate and consume the one-time token
  const tokenData = await validateAndConsumeAuthToken(env.API_TOKENS, token);
  if (!tokenData) {
    return new Response('Invalid or expired token', { status: 400 });
  }

  // Verify state matches (CSRF protection)
  if (tokenData.state !== state) {
    return new Response('State mismatch', { status: 400 });
  }

  // Verify script name matches
  if (tokenData.script_name !== scriptName) {
    return new Response('Script name mismatch', { status: 400 });
  }

  // Create dispatcher session
  const { sessionId } = await createDispatcherSession(
    env.SESSIONS,
    tokenData.user_id,
    tokenData.org_id
  );

  // Build redirect URL (remove the callback path and query params)
  const redirectUrl = new URL(url.origin);
  redirectUrl.pathname = '/';

  // Redirect with session cookie
  return new Response(null, {
    status: 302,
    headers: {
      'Location': redirectUrl.toString(),
      'Set-Cookie': createSessionCookie(sessionId, url.hostname),
    },
  });
}

/**
 * Handle worker request - checks access and dispatches or redirects
 */
async function handleWorkerRequest(request: Request, env: Env, scriptName: string): Promise<Response> {
  const url = new URL(request.url);

  // Skip all auth checks in local development mode
  if (env.SKIP_AUTH === 'true') {
    console.log(`[dispatcher] SKIP_AUTH enabled, dispatching directly to: ${scriptName}`);
    return dispatchToWorker(request, env, scriptName);
  }

  const cookieHeader = request.headers.get('Cookie');
  const screenshotHeader = request.headers.get('x-chiridion-screenshot-token')?.trim();
  const authHeader = request.headers.get('Authorization') ?? '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)\s*$/i);
  const bearerToken = bearerMatch?.[1]?.trim();
  const screenshotToken = screenshotHeader || bearerToken || null;
  const hasScreenshotBearer = Boolean(bearerToken && bearerToken.startsWith('stkn_'));

  const screenshotSessionId = getCookieValue(cookieHeader, SCREENSHOT_SESSION_COOKIE);
  if (screenshotSessionId) {
    const session = await getScreenshotSession(env.SESSIONS, screenshotSessionId);
    if (session && session.script_name === scriptName) {
      if (screenshotHeader || hasScreenshotBearer) {
        const forwardHeaders = new Headers(request.headers);
        forwardHeaders.delete('x-chiridion-screenshot-token');
        if (hasScreenshotBearer) {
          forwardHeaders.delete('Authorization');
        }
        return dispatchToWorker(new Request(request, { headers: forwardHeaders }), env, scriptName);
      }
      return dispatchToWorker(request, env, scriptName);
    }
  }

  if (screenshotToken?.startsWith('stkn_')) {
    const tokenData = await validateAndConsumeScreenshotToken(env.API_TOKENS, screenshotToken);
    if (!tokenData || tokenData.script_name !== scriptName) {
      return new Response('Invalid screenshot token', { status: 401 });
    }

    const { sessionId } = await createScreenshotSession(env.SESSIONS, {
      script_name: tokenData.script_name,
      org_id: tokenData.org_id,
    });

    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete('x-chiridion-screenshot-token');
    if (screenshotToken === bearerToken) {
      forwardHeaders.delete('Authorization');
    }

    const response = await dispatchToWorker(new Request(request, { headers: forwardHeaders }), env, scriptName);
    const headers = new Headers(response.headers);
    headers.append('Set-Cookie', createScreenshotSessionCookie(sessionId));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } else if (screenshotHeader) {
    return new Response('Invalid screenshot token', { status: 401 });
  }

  // Get worker access info from KV index
  let accessInfo: { is_public: boolean; org_id: string } | null = null;
  try {
    accessInfo = await getWorkerAccessInfo(env.API_TOKENS, scriptName);
  } catch (e) {
    // Fail closed on errors - don't bypass auth
    console.error(`[dispatcher] Error getting worker access info: ${e}`);
    return new Response('Service temporarily unavailable', { status: 503 });
  }

  // Fail open: if worker not in registry, dispatch anyway
  // This allows existing deployed workers to continue working even if not yet registered
  // Once all workers are registered, this can be changed to fail closed
  if (!accessInfo) {
    console.log(`[dispatcher] Worker "${scriptName}" not in registry, dispatching anyway (fail open)`);
    return dispatchToWorker(request, env, scriptName);
  }

  // If public, dispatch directly
  if (accessInfo.is_public) {
    return dispatchToWorker(request, env, scriptName);
  }

  // Private worker - check session
  const dispatcherSessionId = getCookieValue(cookieHeader, DISPATCHER_SESSION_COOKIE);

  if (dispatcherSessionId) {
    // Validate dispatcher session
    const session = await getDispatcherSession(env.SESSIONS, dispatcherSessionId);
    if (session && session.org_id === accessInfo.org_id) {
      // Valid session with matching org - dispatch
      return dispatchToWorker(request, env, scriptName);
    }
  }

  // For same-site requests (*.chiridion.ai), check main app session cookie directly
  // No redirect dance needed - the cookie is already available or the user isn't logged in
  if (isSameSiteRequest(url.hostname)) {
    const mainSessionId =
      getCookieValue(cookieHeader, MAIN_APP_SESSION_COOKIE) ||
      getCookieValue(cookieHeader, LEGACY_MAIN_APP_SESSION_COOKIE);
    if (!mainSessionId) {
      // No session cookie - user is not logged in
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      const session = await getSessionKV(env.SESSIONS, mainSessionId);
      if (!session) {
        // Invalid/expired session
        return new Response('Unauthorized', { status: 401 });
      }

      // Check if user is a member of the org that owns this worker
      const memberCheck = await isOrgMember(env.ORG, session.user_id, accessInfo.org_id);
      if (!memberCheck) {
        // User is logged in but not a member of this workspace
        return new Response('Forbidden', { status: 403 });
      }

      console.log(`[dispatcher] Same-site auth: user ${session.user_id} accessing ${scriptName} via main session`);
      return dispatchToWorker(request, env, scriptName);
    } catch (e) {
      console.error(`[dispatcher] Error validating main session: ${e}`);
      return new Response('Service temporarily unavailable', { status: 503 });
    }
  }

  // Cross-site request (*.chiridion.app) - redirect to auth
  return redirectToAuth(env, url, scriptName, accessInfo.org_id);
}

/**
 * Dispatch request to the user worker
 */
async function dispatchToWorker(request: Request, env: Env, scriptName: string): Promise<Response> {
  try {
    console.log(`[dispatcher] Routing to worker: ${scriptName}`);
    const userWorker = env.DISPATCHER.get(scriptName);
    return await userWorker.fetch(request);
  } catch (e) {
    const error = e as Error;
    if (error.message?.startsWith('Worker not found')) {
      return new Response(`Worker "${scriptName}" not found`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new Response(`Error dispatching to worker "${scriptName}": ${error.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/**
 * Redirect to main app for authentication
 */
async function redirectToAuth(
  env: Env,
  url: URL,
  scriptName: string,
  requiredOrgId: string
): Promise<Response> {
  // Create auth state with return URL
  const returnUrl = url.origin; // Just the origin, callback will add the path
  const state = await createAuthState(env.API_TOKENS, {
    return_url: returnUrl,
    script_name: scriptName,
    required_org_id: requiredOrgId,
  });

  // Build main app auth URL
  const mainAppUrl = getMainAppUrl(url.hostname);
  const authUrl = new URL('/auth/worker', mainAppUrl);
  authUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      'Location': authUrl.toString(),
    },
  });
}
