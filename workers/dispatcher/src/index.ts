/**
 * camelAI Dispatch Worker
 *
 * Routes requests to user workers deployed in the Workers for Platforms
 * dispatch namespace. Supports subdomain-based routing with private worker
 * access control.
 *
 * Example: hello-world.apps.camelai.dev -> routes to worker "hello-world" (same-site for iframe)
 *          hello-world.camelai.app -> routes to worker "hello-world" (vanity URL)
 *
 * Private worker authentication:
 *
 * Same-site requests (*.camelai.dev):
 * - Main app session cookie is available (same domain)
 * - Validates session directly via RPC, no redirect needed
 * - Checks if user is a member of the workspace that deployed the worker
 *
 * Cross-site requests (*.camelai.app vanity URLs):
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
// @ts-expect-error - text import
import DEBUG_BRIDGE_SCRIPT from './debug-bridge.txt';
import {
  getWorkerAccessInfo,
  resolveMissingRegistryMode,
  shouldFailOpenForMissingRegistry,
  type WorkerAccessInfo,
} from './access-control';
import {
  errorResponse,
  error401Page,
  error403Page,
  error404Page,
  error500Page,
  error503Page,
} from './error-pages';
import { getSession as getSessionKV, type SessionData } from '../../main/src/session-kv';
import { getSessionCookieName } from '../../main/src/cookies';
import { parseSignedSession } from '../../main/src/signed-session';
import type { OrgDO } from '../../main/src/auth';

interface Env {
  DISPATCHER: {
    get(name: string): {
      fetch(request: Request): Promise<Response>;
    };
  };
  APP_KV: KVNamespace;
  SESSIONS: KVNamespace;
  ORG: DurableObjectNamespace<OrgDO>;
  TOKEN_SIGNING_SECRET: string;
  // Set to "true" to skip all auth checks (local development only)
  SKIP_AUTH?: string;
  // Policy for workers missing KV access metadata ("open" during migration, "closed" for strict enforcement)
  DISPATCHER_MISSING_REGISTRY_MODE?: string;
}

// Helper functions to replace RPC calls

/**
 * Check if a string looks like an environment prefix.
 */
function isEnvPrefix(s: string): boolean {
  return s.startsWith('dev-') || s === 'staging' || s === 'prod';
}

/**
 * Parse worker route from hostname.
 * Returns script name and org slug for new format, or just script name for legacy.
 *
 * New flat format: {script}--{org-slug}.camelai.app -> { scriptName, orgSlug, dispatchScriptName }
 * New flat format: {script}--{org-slug}.apps.camelai.dev -> { scriptName, orgSlug, dispatchScriptName }
 * Legacy format: {script}.camelai.app -> { scriptName, orgSlug: null, dispatchScriptName: scriptName }
 *
 * The new format uses a flat structure with double-hyphen separator to avoid
 * nested subdomain issues with DNS wildcards and SSL certificates.
 * Dispatch namespace uses: {script}--{org-slug}
 */
function parseWorkerRoute(hostname: string): { scriptName: string; orgSlug: string | null; dispatchScriptName: string } | null {
  const parts = hostname.split('.');

  // .camelai.app domain
  if (hostname.endsWith('.camelai.app')) {
    // Need at least 3 parts: {something}.camelai.app
    if (parts.length < 3) return null;

    const firstPart = parts[0]!;

    // Check if first part contains org-slug separator (new flat format)
    // Format: {script}--{org-slug}
    if (firstPart.includes('--')) {
      const separatorIndex = firstPart.indexOf('--');
      const scriptName = firstPart.slice(0, separatorIndex);
      const orgSlug = firstPart.slice(separatorIndex + 2);
      if (!orgSlug || !scriptName) return null;
      const dispatchScriptName = `${scriptName}--${orgSlug}`;
      return { scriptName, orgSlug, dispatchScriptName };
    }

    // Legacy format: {script}.camelai.app or {script}.{env}.camelai.app
    const scriptName = firstPart;
    return { scriptName, orgSlug: null, dispatchScriptName: scriptName };
  }

  // .apps.camelai.dev domain (same-site for iframes)
  if (hostname.endsWith('.camelai.dev') && hostname.includes('.apps.')) {
    // Need at least 4 parts: {something}.apps.camelai.dev
    if (parts.length < 4) return null;

    const firstPart = parts[0]!;

    // Check if first part contains org-slug separator (new flat format)
    // Format: {script}--{org-slug}
    if (firstPart.includes('--')) {
      const separatorIndex = firstPart.indexOf('--');
      const scriptName = firstPart.slice(0, separatorIndex);
      const orgSlug = firstPart.slice(separatorIndex + 2);
      if (!orgSlug || !scriptName) return null;
      const dispatchScriptName = `${scriptName}--${orgSlug}`;
      return { scriptName, orgSlug, dispatchScriptName };
    }

    // Legacy format: {script}.apps.camelai.dev or {script}.apps.{env}.camelai.dev
    const scriptName = firstPart;
    return { scriptName, orgSlug: null, dispatchScriptName: scriptName };
  }

  return null;
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

/**
 * Get org slug from OrgDO
 */
async function getOrgSlug(
  orgNamespace: DurableObjectNamespace<OrgDO>,
  orgId: string
): Promise<string | null> {
  try {
    const stub = orgNamespace.get(orgNamespace.idFromName(orgId)) as DurableObjectStub<OrgDO>;
    return await stub.getSlug();
  } catch {
    return null;
  }
}

/**
 * Build the new-format URL for a worker.
 * Uses flat format: {script}--{org-slug}.domain to avoid nested subdomain issues.
 */
function buildNewFormatUrl(url: URL, scriptName: string, orgSlug: string): string {
  const hostname = url.hostname;
  const parts = hostname.split('.');

  // For .camelai.app domains
  if (hostname.endsWith('.camelai.app')) {
    // Legacy: script.camelai.app -> script--org-slug.camelai.app
    if (parts.length === 3) {
      const newHostname = `${scriptName}--${orgSlug}.camelai.app`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
    // Legacy with env: script.staging.camelai.app -> script--org-slug.staging.camelai.app
    if (parts.length === 4 && (parts[1]?.startsWith('dev-') || parts[1] === 'staging')) {
      const envPrefix = parts[1];
      const newHostname = `${scriptName}--${orgSlug}.${envPrefix}.camelai.app`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
  }

  // For .apps.camelai.dev domains
  if (hostname.endsWith('.camelai.dev') && hostname.includes('.apps.')) {
    // Legacy: script.apps.camelai.dev -> script--org-slug.apps.camelai.dev
    if (parts.length === 4 && parts[1] === 'apps') {
      const newHostname = `${scriptName}--${orgSlug}.apps.camelai.dev`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
    // Legacy with env: script.apps.staging.camelai.dev -> script--org-slug.apps.staging.camelai.dev
    if (parts.length === 5 && parts[1] === 'apps') {
      const envPrefix = parts[2];
      const newHostname = `${scriptName}--${orgSlug}.apps.${envPrefix}.camelai.dev`;
      return `${url.protocol}//${newHostname}${url.pathname}${url.search}`;
    }
  }

  // Fallback - shouldn't happen but return original
  return url.toString();
}

// Cookie settings for dispatcher session
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const SCREENSHOT_SESSION_MAX_AGE = SCREENSHOT_SESSION_TTL_SECONDS;

// Legacy main app session cookie names (fallback for in-flight sessions)
const LEGACY_MAIN_APP_SESSION_COOKIES = ['chiridion_session_v2', 'chiridion_session'];

// Main app URL for auth redirects (determined from request hostname)
function getMainAppUrl(hostname: string): string {
  // Extract environment from hostname
  // New format: worker.org-slug.camelai.app -> camelai.dev (main app)
  // New format: worker.org-slug.dev-miguel.camelai.app -> dev-miguel.camelai.dev (main app)
  // Legacy: worker.camelai.app -> camelai.dev (main app)
  // Legacy: worker.dev-miguel.camelai.app -> dev-miguel.camelai.dev (main app)
  // Local: worker.local.camelai.app -> local.camelai.dev (main app)
  const parts = hostname.split('.');

  const isKnownEnvPrefix = (s: string | undefined): boolean =>
    s !== undefined && (s.startsWith('dev-') || s === 'staging' || s === 'prod' || s === 'local');

  // For .camelai.app domains
  if (hostname.endsWith('.camelai.app')) {
    // Find the environment prefix if any (e.g., dev-miguel, staging, local)
    // It's the part before .camelai.app that looks like an env prefix
    for (let i = parts.length - 3; i >= 1; i--) {
      if (isKnownEnvPrefix(parts[i])) {
        const envPrefix = parts[i];
        return `https://${envPrefix}.camelai.dev`;
      }
    }
    return 'https://camelai.dev';
  }

  // For .camelai.dev domains (same-site)
  if (hostname.endsWith('.camelai.dev')) {
    // Remove worker and org-slug subdomains
    for (let i = parts.length - 3; i >= 1; i--) {
      if (isKnownEnvPrefix(parts[i])) {
        const envPrefix = parts[i];
        return `https://${envPrefix}.camelai.dev`;
      }
    }
    return 'https://camelai.dev';
  }

  // Fallback to camelai.dev
  return 'https://camelai.dev';
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
  // Get domain for cookie (e.g., .camelai.app to cover all subdomains)
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

// Check if request is from same-site (any *.camelai.dev subdomain)
// These requests will have the main app session cookie available since they share the same domain
function isSameSiteRequest(hostname: string): boolean {
  return hostname.endsWith('.camelai.dev');
}

// Auth callback route
const AUTH_CALLBACK_PATH = '/__chiridion_auth/callback';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Parse worker route from hostname
    const route = parseWorkerRoute(hostname);
    if (route) {
      const { scriptName, orgSlug, dispatchScriptName } = route;

      // Handle auth callback route
      if (url.pathname === AUTH_CALLBACK_PATH) {
        return handleAuthCallback(request, env, scriptName, orgSlug, dispatchScriptName);
      }

      // Check worker access
      return handleWorkerRequest(request, env, scriptName, orgSlug, dispatchScriptName);
    }

    // Default response for apex domain
    return new Response(
      JSON.stringify(
        {
          message: 'camelAI Dispatch Worker',
          routes: {
            vanity: '<worker-name>--<org-slug>.camelai.app',
            iframe: '<worker-name>--<org-slug>.apps.camelai.dev',
          },
          example: 'my-app--acme-85b.camelai.app',
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
async function handleAuthCallback(
  request: Request,
  env: Env,
  scriptName: string,
  _orgSlug: string | null,
  _dispatchScriptName: string
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const state = url.searchParams.get('state');

  if (!token || !state) {
    return new Response('Missing token or state parameter', { status: 400 });
  }

  // Validate and consume the one-time token
  const tokenData = await validateAndConsumeAuthToken(env.APP_KV, token);
  if (!tokenData) {
    return new Response('Invalid or expired token', { status: 400 });
  }

  // Verify state matches (CSRF protection)
  if (tokenData.state !== state) {
    return new Response('State mismatch', { status: 400 });
  }

  // Verify script name matches (user-facing name, not dispatch name)
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
async function handleWorkerRequest(
  request: Request,
  env: Env,
  scriptName: string,
  orgSlug: string | null,
  dispatchScriptName: string
): Promise<Response> {
  const url = new URL(request.url);
  const legacyDispatchScriptName = orgSlug ? scriptName : undefined;

  // Skip all auth checks in local development mode
  if (env.SKIP_AUTH === 'true') {
    console.log(`[dispatcher] SKIP_AUTH enabled, dispatching directly to: ${dispatchScriptName}`);
    return dispatchToWorker(request, env, dispatchScriptName, scriptName, legacyDispatchScriptName);
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
    // Screenshot session stores user-facing scriptName
    if (session && session.script_name === scriptName) {
      if (screenshotHeader || hasScreenshotBearer) {
        const forwardHeaders = new Headers(request.headers);
        forwardHeaders.delete('x-chiridion-screenshot-token');
        if (hasScreenshotBearer) {
          forwardHeaders.delete('Authorization');
        }
        return dispatchToWorker(new Request(request, { headers: forwardHeaders }), env, dispatchScriptName, scriptName, legacyDispatchScriptName);
      }
      return dispatchToWorker(request, env, dispatchScriptName, scriptName, legacyDispatchScriptName);
    }
  }

  if (screenshotToken?.startsWith('stkn_')) {
    const tokenData = await validateAndConsumeScreenshotToken(env.APP_KV, screenshotToken);
    // Token stores user-facing scriptName
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

    const response = await dispatchToWorker(
      new Request(request, { headers: forwardHeaders }),
      env,
      dispatchScriptName,
      scriptName,
      legacyDispatchScriptName
    );
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
  // Try new namespaced format first, then legacy
  let accessInfo: WorkerAccessInfo | null = null;
  try {
    accessInfo = await getWorkerAccessInfo(env.APP_KV, dispatchScriptName, scriptName, orgSlug);
  } catch (e) {
    // Fail closed on errors - don't bypass auth
    console.error(`[dispatcher] Error getting worker access info: ${e}`);
    return errorResponse(error503Page(getMainAppUrl(url.hostname)));
  }

  const missingRegistryMode = resolveMissingRegistryMode(env.DISPATCHER_MISSING_REGISTRY_MODE);

  if (!accessInfo) {
    if (shouldFailOpenForMissingRegistry(missingRegistryMode, orgSlug)) {
      console.warn(`[dispatcher] Worker "${dispatchScriptName}" not in registry, dispatching anyway (fail open)`); // TEMP migration mode
      return dispatchToWorker(request, env, dispatchScriptName, scriptName, legacyDispatchScriptName);
    }
    console.warn(`[dispatcher] Worker "${dispatchScriptName}" not in registry, denying access (fail closed)`);
    return errorResponse(error404Page(getMainAppUrl(url.hostname), scriptName));
  }

  // Legacy URL redirect: If using old URL format AND the worker was deployed with the
  // new system (has org_slug in KV), redirect to the new URL format.
  //
  // Cases:
  // 1. orgSlug !== null: Already using new URL format, no redirect needed
  // 2. is_legacy: false: Found in new KV format (means dispatchScriptName already has org-slug prefix)
  // 3. is_legacy: true AND has org_slug: Worker was redeployed with new system, redirect to new URL
  // 4. is_legacy: true AND no org_slug: Old worker, serve from legacy dispatch (no redirect)
  if (orgSlug === null && accessInfo && accessInfo.org_slug && accessInfo.is_legacy) {
    const newUrl = buildNewFormatUrl(url, scriptName, accessInfo.org_slug);
    console.log(`[dispatcher] Legacy URL redirect: ${url.hostname} -> ${new URL(newUrl).hostname}`);
    return Response.redirect(newUrl, 301);
  }

  // If public, dispatch directly
  if (accessInfo.is_public) {
    return dispatchToWorker(request, env, dispatchScriptName, scriptName, legacyDispatchScriptName);
  }

  // Private worker - check session
  const dispatcherSessionId = getCookieValue(cookieHeader, DISPATCHER_SESSION_COOKIE);

  if (dispatcherSessionId) {
    // Validate dispatcher session
    const session = await getDispatcherSession(env.SESSIONS, dispatcherSessionId);
    if (session && session.org_id === accessInfo.org_id) {
      // Valid session with matching org - dispatch
      return dispatchToWorker(request, env, dispatchScriptName, scriptName, legacyDispatchScriptName);
    }
  }

  // For same-site requests (*.camelai.dev), check main app session cookie directly
  // No redirect dance needed - the cookie is already available or the user isn't logged in
  if (isSameSiteRequest(url.hostname)) {
    // Use the environment-aware cookie name (matches what the main app sets)
    const currentCookieName = getSessionCookieName(url.hostname);
    let mainSessionId = getCookieValue(cookieHeader, currentCookieName);

    // Fallback to legacy cookie names for in-flight sessions
    if (!mainSessionId) {
      for (const legacyName of LEGACY_MAIN_APP_SESSION_COOKIES) {
        mainSessionId = getCookieValue(cookieHeader, legacyName);
        if (mainSessionId) break;
      }
    }

    console.log(`[dispatcher] Same-site auth for ${scriptName}: cookie=${currentCookieName}, found=${mainSessionId ? 'yes' : 'no'}`);

    if (!mainSessionId) {
      // No session cookie - user is not logged in
      console.log(`[dispatcher] No session cookie found for ${scriptName}`);
      return errorResponse(error401Page(getMainAppUrl(url.hostname)));
    }

    try {
      // Try HMAC-signed session first (current format), then fall back to KV (legacy)
      let session: SessionData | null = null;
      const signedSession = await parseSignedSession(env.TOKEN_SIGNING_SECRET, mainSessionId);
      if (signedSession) {
        session = {
          user_id: signedSession.user_id,
          org_id: signedSession.org_id,
          workspace_id: signedSession.workspace_id,
          created_at: signedSession.created_at,
          last_accessed: signedSession.created_at,
          user_name: signedSession.user_name,
          user_email: signedSession.user_email,
        };
      } else {
        // Legacy KV-based session fallback
        session = await getSessionKV(env.SESSIONS, mainSessionId);
      }

      if (!session) {
        console.log(`[dispatcher] Session invalid for ${scriptName}, token prefix: ${mainSessionId.slice(0, 8)}...`);
        return errorResponse(error401Page(getMainAppUrl(url.hostname)));
      }

      // Check if user is a member of the org that owns this worker
      console.log(`[dispatcher] Session found for user ${session.user_id}, checking org membership for org ${accessInfo.org_id}`);
      const memberCheck = await isOrgMember(env.ORG, session.user_id, accessInfo.org_id);
      if (!memberCheck) {
        // User is logged in but not a member of this workspace
        console.log(`[dispatcher] User ${session.user_id} is not a member of org ${accessInfo.org_id}`);
        return errorResponse(error403Page(getMainAppUrl(url.hostname)));
      }

      console.log(`[dispatcher] Same-site auth: user ${session.user_id} accessing ${scriptName} via main session`);
      return dispatchToWorker(request, env, dispatchScriptName, scriptName, legacyDispatchScriptName);
    } catch (e) {
      console.error(`[dispatcher] Error validating main session: ${e}`);
      return errorResponse(error503Page(getMainAppUrl(url.hostname)));
    }
  }

  // Cross-site request (*.camelai.app) - redirect to auth
  return redirectToAuth(env, url, scriptName, accessInfo.org_id);
}

/**
 * Inject debug bridge script into HTML responses
 */
async function injectDebugBridge(response: Response, _hostname: string): Promise<Response> {
  const contentType = response.headers.get('content-type') || '';

  // Only inject into HTML responses
  if (!contentType.includes('text/html')) {
    return response;
  }

  // Only inject into successful responses
  if (!response.ok) {
    return response;
  }

  try {
    const html = await response.text();
    const scriptTag = `<script>${DEBUG_BRIDGE_SCRIPT}</script>`;

    // Inject the script - prefer before </head>, fallback to before <body>
    let injectedHtml: string;
    if (html.includes('</head>')) {
      injectedHtml = html.replace('</head>', `${scriptTag}</head>`);
    } else if (html.includes('<body')) {
      injectedHtml = html.replace('<body', `${scriptTag}<body`);
    } else {
      // Last resort: prepend to the document
      injectedHtml = scriptTag + html;
    }

    // Clone headers and remove content-length since we modified the body
    const headers = new Headers(response.headers);
    headers.delete('content-length');

    return new Response(injectedHtml, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (e) {
    // If injection fails, return original response
    console.error(`[dispatcher] Failed to inject debug bridge: ${e}`);
    return response;
  }
}

/**
 * Dispatch request to the user worker
 * @param dispatchScriptName - The script name in the dispatch namespace ({org-slug}--{script})
 * @param userFacingScriptName - The user-facing script name for error messages
 * @param fallbackDispatchScriptName - Optional legacy script name fallback ({script})
 */
async function dispatchToWorker(
  request: Request,
  env: Env,
  dispatchScriptName: string,
  userFacingScriptName: string,
  fallbackDispatchScriptName?: string
): Promise<Response> {
  const url = new URL(request.url);

  try {
    console.log(`[dispatcher] Routing to worker: ${dispatchScriptName}`);
    const userWorker = env.DISPATCHER.get(dispatchScriptName);
    let response: Response;

    try {
      response = await userWorker.fetch(request);
    } catch (e) {
      const error = e as Error;
      if (error.message?.startsWith('Worker not found') && fallbackDispatchScriptName && fallbackDispatchScriptName !== dispatchScriptName) {
        console.log(`[dispatcher] Primary worker not found, retrying legacy worker: ${fallbackDispatchScriptName}`);
        const legacyWorker = env.DISPATCHER.get(fallbackDispatchScriptName);
        response = await legacyWorker.fetch(request);
      } else {
        throw e;
      }
    }

    // Only inject debug bridge on iframe domain (*.apps.camelai.dev)
    // This is where the preview iframe loads from
    if (isSameSiteRequest(url.hostname)) {
      return injectDebugBridge(response, url.hostname);
    }

    return response;
  } catch (e) {
    const error = e as Error;
    const pageHomeUrl = getMainAppUrl(new URL(request.url).hostname);
    if (error.message?.startsWith('Worker not found')) {
      return errorResponse(error404Page(pageHomeUrl, userFacingScriptName));
    }
    return errorResponse(error500Page(pageHomeUrl));
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
  const state = await createAuthState(env.APP_KV, {
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
