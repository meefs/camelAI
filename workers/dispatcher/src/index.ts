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
 * Private workers require authentication via cross-domain auth flow:
 * 1. User visits private worker
 * 2. Dispatcher checks session cookie
 * 3. If no session, redirects to main app for auth
 * 4. Main app validates user and redirects back with token
 * 5. Dispatcher validates token and creates session cookie
 */

import type { DoRpcService } from '../../main/src/rpc-service';
import {
  getDispatcherSession,
  createDispatcherSession,
  validateAndConsumeAuthToken,
  createAuthState,
  DISPATCHER_SESSION_COOKIE,
  type DispatcherSession,
} from '../../main/src/worker-auth';

interface Env {
  DISPATCHER: {
    get(name: string): {
      fetch(request: Request): Promise<Response>;
    };
  };
  API_TOKENS: KVNamespace;
  SESSIONS: KVNamespace;
  MAIN_RPC: DoRpcService;
}

// Cookie settings for dispatcher session
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

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

  // Get worker access info via RPC
  let accessInfo: { is_public: boolean; org_id: string } | null = null;
  try {
    accessInfo = await env.MAIN_RPC.getWorkerAccessInfo(scriptName);
  } catch (e) {
    // Fail closed on RPC errors - don't bypass auth
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
  const cookieHeader = request.headers.get('Cookie');
  const sessionId = getCookieValue(cookieHeader, DISPATCHER_SESSION_COOKIE);

  if (sessionId) {
    // Validate session
    const session = await getDispatcherSession(env.SESSIONS, sessionId);
    if (session && session.org_id === accessInfo.org_id) {
      // Valid session with matching org - dispatch
      return dispatchToWorker(request, env, scriptName);
    }
  }

  // No valid session - redirect to auth
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
