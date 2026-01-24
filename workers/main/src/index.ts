// Custom worker that wraps React Router SSR and handles WebSocket + Durable Objects
import { createRequestHandler } from 'react-router';
import { ChatThreadDO, type ChatEnv } from "./durable-objects.js";

// Extend React Router's AppLoadContext with Cloudflare bindings
declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}
import { UserDO, OrgDO, type DOEnv, type OAuthProvider as AuthOAuthProvider } from "./auth.js";
import { WorkspaceContainer, handleWebSocketUpgrade, type WorkspaceContainerEnv } from './workspace-container.js';
import { WorkspaceDO, type Workspace } from './workspace.js';
import { getSession as getSessionKV, createSession } from './session-kv.js';
import { createScreenshotToken } from './worker-auth.js';
import {
  proxyCloudflareApi,
  cfApiError,
  resolveEnvPrefix,
  CHIRIDION_DEPLOY_TOKEN_HEADER,
  type CfApiProxyEnv,
  type DeploySideEffectsInfo,
} from './cf-api-proxy.js';
import { handleMcpRequest, ChiridionMcp, type McpEnv } from './mcp-handler.js';
import { isSignedToken, validateSignedToken, createSignedToken } from './signed-tokens.js';
import { handleScreenshotQueue, captureScreenshot, type AppScreenshotJob } from './screenshot-queue.js';
import { createOAuthState, validateAndConsumeOAuthState } from './oauth-state.js';
import {
  isValidOAuthProvider,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  OAUTH_PROVIDERS,
  type OAuthProvider,
} from '../../../src/lib/oauth-config.js';
export { ChiridionMcp } from './mcp-handler.js';

// Export WorkspaceContainer as ThreadSandbox to match wrangler.jsonc class_name
export { WorkspaceContainer as ThreadSandbox };

const SESSION_COOKIE_NAME = 'chiridion_session_v2';
const LEGACY_SESSION_COOKIE_NAME = 'chiridion_session';
const CHIRIDION_SESSION_HEADER = 'X-Chiridion-Session-Id';

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || '';
  }
  return null;
}

function getSessionIdFromCookieHeader(cookieHeader: string | null): string | null {
  const sessionId = getCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  if (sessionId) return sessionId;
  return getCookieValue(cookieHeader, LEGACY_SESSION_COOKIE_NAME);
}

function buildSessionCookie(name: string, sessionId: string, secure: boolean): string {
  const cookieOptions = [
    `${name}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000', // 30 days
  ];

  if (secure) {
    cookieOptions.push('Secure');
  }

  return cookieOptions.join('; ');
}

function buildDeleteCookie(name: string, secure: boolean): string {
  const cookieOptions = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];

  if (secure) {
    cookieOptions.push('Secure');
  }

  return cookieOptions.join('; ');
}

interface Env extends ChatEnv, DOEnv, WorkspaceContainerEnv, CfApiProxyEnv, McpEnv {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  SESSIONS: KVNamespace;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  APP_SCREENSHOT_QUEUE?: Queue<AppScreenshotJob>;
  BROWSER?: Fetcher;
  LOCAL_APP_PREVIEW_URL?: string;
  PROXY?: Fetcher;
  // OAuth
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

const CHIRIDION_THREAD_TOKEN_HEADER = 'X-Chiridion-Thread-Deploy-Token';
const SCRIPT_ORG_PREFIX = 'script_org:';

/**
 * Register script ownership after successful deploy.
 */
async function registerScriptOwnership(
  env: Env,
  scriptName: string,
  orgId: string,
  workspaceId: string,
  threadId?: string
) {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  let createdBy = 'system:deploy';
  if (threadId) {
    try {
      const thread = await orgStub.getThread(threadId);
      if (thread?.created_by && thread.workspace_id === workspaceId) {
        createdBy = thread.created_by;
      }
    } catch (err) {
      console.warn('[cf-api-proxy] failed to resolve deploy creator', {
        threadId,
        orgId,
        workspaceId,
        error: String(err),
      });
    }
  }
  // registerWorkerScript preserves existing is_public on redeploy, or defaults to true for new scripts
  const script = await orgStub.registerWorkerScript(scriptName, workspaceId, createdBy);
  // Update the denormalized KV index with the actual is_public value
  await env.API_TOKENS.put(
    `${SCRIPT_ORG_PREFIX}${scriptName}`,
    JSON.stringify({ org_id: orgId, is_public: script.is_public })
  );
  return script;
}

async function handleDeploySideEffects(
  env: Env,
  info: DeploySideEffectsInfo
): Promise<void> {
  const { scriptName, orgId, workspaceId, hostname, threadId } = info;
  const script = await registerScriptOwnership(env, scriptName, orgId, workspaceId, threadId);
  console.log('[cf-api-proxy] registered script ownership', {
    scriptName,
    orgId,
    workspaceId,
  });

  const envPrefix = resolveEnvPrefix(env.WORKER_BASE_URL, hostname);
  console.log('[cf-api-proxy] resolved env prefix for screenshot', {
    scriptName,
    envPrefix,
    workerBaseUrl: env.WORKER_BASE_URL,
    hostname,
  });
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const previewResult = await orgStub.updateWorkerScriptPreview(scriptName, {
    status: 'pending',
    preview_key: null,
    preview_error: null,
    deploy_ts: script.updated_at,
  });

  if (previewResult.stale) {
    console.log('[cf-api-proxy] skipping stale screenshot request', {
      scriptName,
      orgId,
      deployTs: script.updated_at,
      updatedAt: previewResult.script?.updated_at ?? null,
    });
    return;
  }

  const jobBase: AppScreenshotJob = {
    script_name: scriptName,
    org_id: orgId,
    workspace_id: workspaceId,
    deploy_ts: script.updated_at,
    env_prefix: envPrefix,
    is_public: script.is_public,
  };

  if (envPrefix === 'local') {
    await captureScreenshot(env, jobBase);
    return;
  }

  if (!env.APP_SCREENSHOT_QUEUE) {
    return;
  }

  const screenshotToken = script.is_public
    ? undefined
    : await createScreenshotToken(env.API_TOKENS, {
        script_name: scriptName,
        org_id: orgId,
      });

  const job: AppScreenshotJob = {
    ...jobBase,
    ...(screenshotToken ? { screenshot_token: screenshotToken } : {}),
  };

  try {
    await env.APP_SCREENSHOT_QUEUE.send(job, {
      contentType: 'json',
      messageId: `${scriptName}:${script.updated_at}`,
    });
    console.log('[cf-api-proxy] queued app screenshot', {
      scriptName,
      orgId,
      workspaceId,
      deployTs: script.updated_at,
    });
  } catch (err) {
    console.error('[cf-api-proxy] failed to enqueue app screenshot', {
      scriptName,
      orgId,
      workspaceId,
      error: String(err),
    });
    await orgStub.updateWorkerScriptPreview(scriptName, {
      status: 'failed',
      preview_key: null,
      preview_error: String(err),
      deploy_ts: script.updated_at,
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cloudflare API proxy for Wrangler: set `CLOUDFLARE_API_BASE_URL` to `${origin}/client/v4`.
    if (url.pathname.startsWith('/client/v4/')) {
      try {
        return await proxyCloudflareApi(request, env, ctx, {
          onDeploySideEffects: (info) => handleDeploySideEffects(env, info),
        });
      } catch (e) {
        return cfApiError(10004, `Cloudflare API proxy failed: ${String(e)}`, 502);
      }
    }

    // MCP protocol handler at /mcp
    if (url.pathname.startsWith('/mcp')) {
      return handleMcpRequest(request, env, ctx);
    }

    // LLM Proxy passthrough at /v1/messages (and subpaths like /v1/messages/count_tokens)
    // This allows sandbox containers to use PROXY_BASE_URL pointing to the main worker
    if (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/' || url.pathname.startsWith('/v1/messages/')) {
      if (!env.PROXY) {
        return new Response(JSON.stringify({ error: 'Proxy service not configured' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      console.log('[proxy-pass]', { path: url.pathname, search: url.search });
      // Forward the request to the proxy worker
      const proxyUrl = new URL(`${url.pathname}${url.search}`, 'https://proxy.internal');
      return env.PROXY.fetch(new Request(proxyUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }));
    }

    // Proxy health check passthrough
    if (url.pathname === '/proxy/health') {
      if (!env.PROXY) {
        return new Response(JSON.stringify({ ok: false, error: 'Proxy service not configured' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const proxyUrl = new URL('/health', 'https://proxy.internal');
      return env.PROXY.fetch(new Request(proxyUrl, {
        method: 'GET',
        headers: request.headers,
      }));
    }

    // Handle WebSocket upgrade for thread preview state at /ws/thread/{threadId}
    const threadWsMatch = url.pathname.match(/^\/ws\/thread\/([^\/]+)$/);
    if (threadWsMatch && request.headers.get('Upgrade') === 'websocket') {
      const threadId = threadWsMatch[1];

      // Authenticate the request
      const headerSessionId = request.headers.get(CHIRIDION_SESSION_HEADER);
      const cookieSessionId = getSessionIdFromCookieHeader(request.headers.get('Cookie'));
      const sessionId = headerSessionId || cookieSessionId;

      if (!sessionId) {
        return new Response('Unauthorized', { status: 401 });
      }

      const session = await getSessionKV(env.SESSIONS, sessionId);
      if (!session) {
        return new Response('Unauthorized', { status: 401 });
      }

      const workspaceId = session.workspace_id;
      if (!workspaceId) {
        return new Response('No workspace selected', { status: 400 });
      }

      // Verify thread belongs to user's workspace (prevents cross-tenant leak)
      // Get workspace info to find org_id, then check thread in OrgDO
      const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as unknown as WorkspaceDO;
      const workspaceInfo = await workspaceStub.getInfo();
      if (!workspaceInfo || workspaceInfo.archived) {
        return new Response('Workspace not found', { status: 404 });
      }

      const orgStub = env.ORG.get(env.ORG.idFromName(workspaceInfo.org_id)) as unknown as OrgDO;
      const thread = await orgStub.getThread(threadId);
      if (!thread || thread.workspace_id !== workspaceId) {
        return new Response('Thread not found', { status: 404 });
      }

      // Route to thread DO for preview state updates
      const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
      return threadStub.fetch(request);
    }

    // Handle WebSocket upgrade requests at /ws/{workspace}
    // The workspace is used to route to the correct container (one per workspace)
    // Thread/session management happens in the WebSocket protocol
    const wsMatch = url.pathname.match(/^\/ws\/([^\/]+)$/);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const workspaceFromPath = wsMatch[1];

      console.log('[ws] WebSocket upgrade request received', {
        path: url.pathname,
        workspaceFromPath,
        upgrade: request.headers.get('Upgrade'),
        connection: request.headers.get('Connection'),
        secWebSocketKey: request.headers.get('Sec-WebSocket-Key') ? 'present' : 'missing',
        secWebSocketVersion: request.headers.get('Sec-WebSocket-Version'),
      });

      // Authenticate the request
      const headerSessionId = request.headers.get(CHIRIDION_SESSION_HEADER);
      const cookieSessionId = getSessionIdFromCookieHeader(request.headers.get('Cookie'));
      const sessionId = headerSessionId || cookieSessionId;

      if (!sessionId) {
        console.log('[ws] No session ID found, returning 401');
        return new Response('Unauthorized', { status: 401 });
      }

      const session = await getSessionKV(env.SESSIONS, sessionId);
      if (!session) {
        console.log('[ws] Invalid session, returning 401', { sessionId });
        return new Response('Unauthorized', { status: 401 });
      }

      const orgId = session.org_id;
      const workspaceId = session.workspace_id;
      if (!orgId) {
        console.log('[ws] No org in session, returning 400', { sessionId });
        return new Response('No organization selected', { status: 400 });
      }
      if (!workspaceId) {
        console.log('[ws] No workspace in session, returning 400', { sessionId });
        return new Response('No workspace selected', { status: 400 });
      }
      // FIXME: Enforce viewer role restrictions when publishing is implemented.
      // Viewers should only access published apps, not chat or computer.

      let accessLevel: 'full' | 'read_only' | 'none' = 'none';
      try {
        // Get workspace info and check access directly
        const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as unknown as WorkspaceDO;
        const wsInfo = await workspaceStub.getInfo();
        if (wsInfo && !wsInfo.archived) {
          // Check if user is a member of the org
          const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id)) as unknown as OrgDO;
          const orgInfo = await orgStub.getInfo();
          if (orgInfo && !orgInfo.archived && await orgStub.isMember(session.user_id)) {
            // Get workspace-specific access level
            const memberAccess = await workspaceStub.getMemberAccess(session.user_id);
            accessLevel = memberAccess?.access_level ?? 'full';
          }
        }
      } catch (err) {
        console.warn('[ws] Failed to resolve workspace access', {
          sessionId,
          orgId,
          workspaceId,
          userId: session.user_id,
          error: String(err),
        });
        return new Response('Forbidden', { status: 403 });
      }

      if (accessLevel !== 'full') {
        console.log('[ws] Workspace access denied', {
          sessionId,
          orgId,
          workspaceId,
          userId: session.user_id,
          accessLevel,
        });
        return new Response('Forbidden', { status: 403 });
      }

      // Extract threadId from query param for per-thread deploy token
      const threadIdFromUrl = url.searchParams.get('threadId');

      // Look up user info for message attribution (required for multi-user threads)
      // Also validate threadId ownership if provided (prevents cross-tenant state writes)
      let userName: string | null = null;
      let userEmail: string;
      let validatedThreadId: string | null = null;
      try {
        // Get user profile directly from UserDO
        const userStub = env.USER.get(env.USER.idFromName(session.user_id)) as unknown as UserDO;
        const userProfile = await userStub.getProfile();
        if (!userProfile) {
          console.error('[ws] User profile not found', { userId: session.user_id });
          return new Response('User not found', { status: 404 });
        }
        userName = userProfile.name;
        userEmail = userProfile.email;

        // Validate threadId belongs to this workspace before including in deploy token
        if (threadIdFromUrl) {
          // Get workspace info to find org_id
          const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as unknown as WorkspaceDO;
          const wsInfo = await workspaceStub.getInfo();
          if (wsInfo && !wsInfo.archived) {
            const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id)) as unknown as OrgDO;
            const thread = await orgStub.getThread(threadIdFromUrl);
            if (thread && thread.workspace_id === workspaceId) {
              validatedThreadId = threadIdFromUrl;
            } else {
              console.warn('[ws] Thread not found or not in workspace, skipping thread token', {
                threadId: threadIdFromUrl,
                workspaceId,
                orgId,
              });
            }
          }
        }
      } catch (err) {
        console.error('[ws] Failed to fetch user info', {
          userId: session.user_id,
          error: String(err),
        });
        return new Response('Failed to fetch user info', { status: 500 });
      }

      console.log('[ws] Authenticated, forwarding to container', {
        sessionId,
        orgId,
        workspaceId,
        userId: session.user_id,
        userName,
        threadId: threadIdFromUrl,
      });

      // Create modified request with user info and optional deploy token headers
      // Always set headers from authenticated session - never trust client-supplied values
      const headers = new Headers(request.headers);
      headers.delete('X-Chiridion-User-Name');
      headers.delete('X-Chiridion-User-Email');
      if (userName) {
        headers.set('X-Chiridion-User-Name', userName);
      }
      headers.set('X-Chiridion-User-Email', userEmail);

      // Create signed deploy token with validated threadId for auto-preview after deploys
      if (validatedThreadId) {
        const threadToken = await createSignedToken(env.TOKEN_SIGNING_SECRET, {
          org_id: orgId,
          user_id: session.user_id,
          scopes: ['deploy'],
          exp: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
          workspace_id: workspaceId,
          thread_id: validatedThreadId,
          name: `deploy-thread-${validatedThreadId}`,
        });
        console.log('[ws] Created signed deploy token with threadId', {
          threadId: validatedThreadId,
          tokenPrefix: threadToken.slice(0, 12),
        });
        headers.set(CHIRIDION_THREAD_TOKEN_HEADER, threadToken);
      }

      const modifiedRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
      });

      // Handle WebSocket upgrade with container management
      return handleWebSocketUpgrade(modifiedRequest, env, workspaceId, orgId);
    }

    // Handle preview API with deploy token auth (called from container wrangler wrapper)
    const previewMatch = url.pathname.match(/^\/api\/threads\/([^\/]+)\/preview$/);
    if (previewMatch && request.method === 'POST') {
      const previewThreadId = previewMatch[1];

      // Validate deploy token
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Missing authorization' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const token = authHeader.slice(7);

      // Validate signed deploy token
      if (!isSignedToken(token)) {
        return new Response(JSON.stringify({ error: 'Invalid token format' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const tokenPayload = await validateSignedToken(env.TOKEN_SIGNING_SECRET, token);
      if (!tokenPayload || !tokenPayload.scopes.includes('deploy') || !tokenPayload.workspace_id) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Parse body and set preview
      try {
        const body = await request.json() as { workers?: string[] };
        if (!body.workers || !Array.isArray(body.workers)) {
          return new Response(JSON.stringify({ error: 'Missing workers array' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Sanitize worker names (no prefix)
        const sanitizedWorkers = body.workers.map(name => {
          return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63);
        });

        const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(previewThreadId));
        const response = await threadStub.fetch(new Request('http://internal/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workers: sanitizedWorkers }),
        }));

        if (!response.ok) {
          return new Response(response.body, {
            status: response.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Return full URLs for the deployed workers
        const urls = sanitizedWorkers.map(w => `https://${w}.chiridion.app`);
        return new Response(JSON.stringify({ workers: sanitizedWorkers, urls }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // OAuth initiation: /api/auth/{provider}
    const oauthInitMatch = url.pathname.match(/^\/api\/auth\/(google|github)$/);
    if (oauthInitMatch && request.method === 'GET') {
      const provider = oauthInitMatch[1] as OAuthProvider;

      if (!isValidOAuthProvider(provider)) {
        return new Response('Invalid OAuth provider', { status: 400 });
      }

      const config = OAUTH_PROVIDERS[provider];
      const clientId = env[config.clientIdEnvVar as keyof Env] as string | undefined;

      if (!clientId) {
        console.error(`[oauth] Missing ${config.clientIdEnvVar} env var`);
        return new Response(`${config.displayName} OAuth is not configured`, { status: 500 });
      }

      // Get redirect URL from query param (where to send user after auth)
      const redirectTo = url.searchParams.get('redirect') || '/';

      // Build callback URL
      const callbackUrl = `${url.origin}/api/auth/${provider}/callback`;

      // Create state for CSRF protection
      const state = await createOAuthState(env.SESSIONS, provider, redirectTo);

      // Build authorization URL and redirect
      const authUrl = buildAuthorizationUrl(provider, clientId, callbackUrl, state);

      return new Response(null, {
        status: 302,
        headers: { Location: authUrl },
      });
    }

    // OAuth callback: /api/auth/{provider}/callback
    const oauthCallbackMatch = url.pathname.match(/^\/api\/auth\/(google|github)\/callback$/);
    if (oauthCallbackMatch && request.method === 'GET') {
      const provider = oauthCallbackMatch[1] as OAuthProvider;

      if (!isValidOAuthProvider(provider)) {
        return new Response('Invalid OAuth provider', { status: 400 });
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        console.error(`[oauth] Provider returned error: ${error}`);
        return Response.redirect(`${url.origin}/login?error=oauth_denied`, 302);
      }

      if (!code || !state) {
        return Response.redirect(`${url.origin}/login?error=oauth_invalid`, 302);
      }

      // Validate and consume state
      const stateData = await validateAndConsumeOAuthState(env.SESSIONS, state);
      if (!stateData || stateData.provider !== provider) {
        return Response.redirect(`${url.origin}/login?error=oauth_state_invalid`, 302);
      }

      const config = OAUTH_PROVIDERS[provider];
      const clientId = env[config.clientIdEnvVar as keyof Env] as string | undefined;
      const clientSecret = env[config.clientSecretEnvVar as keyof Env] as string | undefined;

      if (!clientId || !clientSecret) {
        console.error(`[oauth] Missing OAuth credentials for ${provider}`);
        return Response.redirect(`${url.origin}/login?error=oauth_config`, 302);
      }

      const callbackUrl = `${url.origin}/api/auth/${provider}/callback`;

      try {
        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(provider, code, clientId, clientSecret, callbackUrl);

        // Fetch user info
        const userInfo = await fetchUserInfo(provider, tokens.access_token);

        // Find or create user using direct DO calls
        const normalizedEmail = userInfo.email.toLowerCase();
        const emailKvKey = `email:${normalizedEmail}`;
        const oauthKvKey = `oauth:${provider}:${userInfo.providerId}`;
        let userId: string;

        // Try to find existing user by email
        const existingUserId = await env.EMAIL_TO_USER.get(emailKvKey);

        if (existingUserId) {
          userId = existingUserId;
          // Update OAuth provider info if needed (link if not already linked)
          const existingOAuthUserId = await env.EMAIL_TO_USER.get(oauthKvKey);
          if (!existingOAuthUserId || existingOAuthUserId === userId) {
            await env.EMAIL_TO_USER.put(oauthKvKey, userId);
            const userStub = env.USER.get(env.USER.idFromName(userId)) as unknown as UserDO;
            await userStub.linkOAuthProvider(provider, userInfo.providerId);
          }
        } else {
          // Create new user - claim email and OAuth provider in KV first
          userId = crypto.randomUUID();

          // Check if OAuth provider already linked to another user
          const existingOAuthUser = await env.EMAIL_TO_USER.get(oauthKvKey);
          if (existingOAuthUser) {
            return Response.redirect(`${url.origin}/login?error=oauth_already_linked`, 302);
          }

          // Claim the email and OAuth provider
          await Promise.all([
            env.EMAIL_TO_USER.put(emailKvKey, userId),
            env.EMAIL_TO_USER.put(oauthKvKey, userId),
          ]);

          // Verify we still own them (handle race condition)
          const [verifyEmail, verifyOAuth] = await Promise.all([
            env.EMAIL_TO_USER.get(emailKvKey),
            env.EMAIL_TO_USER.get(oauthKvKey),
          ]);

          if (verifyEmail !== userId || verifyOAuth !== userId) {
            // Clean up and abort - another request won the race
            await Promise.all([
              env.EMAIL_TO_USER.delete(emailKvKey),
              env.EMAIL_TO_USER.delete(oauthKvKey),
            ]);
            return Response.redirect(`${url.origin}/login?error=oauth_race_condition`, 302);
          }

          // Create user in DO
          const userStub = env.USER.get(env.USER.idFromName(userId)) as unknown as UserDO;
          await userStub.createUserFromOAuth(
            userId,
            normalizedEmail,
            userInfo.name || userInfo.email.split('@')[0],
            provider,
            userInfo.providerId
          );
        }

        // Create session - get user's orgs
        const sessionId = crypto.randomUUID();
        let sessionOrgId: string;
        let sessionWorkspaceId: string | null = null;

        const userStub = env.USER.get(env.USER.idFromName(userId)) as unknown as UserDO;
        const userOrgs = await userStub.getOrgs();

        if (userOrgs.length === 0) {
          // Create default org for new user (also creates default workspace)
          const orgId = crypto.randomUUID();
          const orgStub = env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgDO;
          const { defaultWorkspaceId } = await orgStub.createOrg(
            orgId,
            `${userInfo.name || userInfo.email}'s Workspace`,
            userId
          );
          sessionOrgId = orgId;
          sessionWorkspaceId = defaultWorkspaceId;

          // Add user to org with workspace
          await userStub.addOrg(orgId, 'owner', defaultWorkspaceId);
        } else {
          sessionOrgId = userOrgs[0].org_id;
          sessionWorkspaceId = userOrgs[0].last_workspace_id ?? null;

          // If no last workspace, get the first available one
          if (!sessionWorkspaceId) {
            const orgStub = env.ORG.get(env.ORG.idFromName(sessionOrgId)) as unknown as OrgDO;
            const workspaces = await orgStub.getWorkspaces();
            const existingWorkspace = workspaces.find(w => !w.archived);

            if (existingWorkspace) {
              sessionWorkspaceId = existingWorkspace.id;
            } else {
              // Create default workspace for existing org that has none
              const workspaceId = crypto.randomUUID();
              const workspaceStub = env.WORKSPACE.get(
                env.WORKSPACE.idFromName(workspaceId)
              ) as unknown as WorkspaceDO;
              await workspaceStub.createWorkspace(
                workspaceId,
                sessionOrgId,
                'Default Workspace',
                userId,
                null
              );
              sessionWorkspaceId = workspaceId;

              // Update user's last workspace for this org
              await userStub.setOrgLastWorkspace(sessionOrgId, workspaceId);
            }
          }
        }

        // Store session in KV using the session-kv module for consistent key format
        await createSession(env.SESSIONS, sessionId, {
          user_id: userId,
          org_id: sessionOrgId,
          workspace_id: sessionWorkspaceId,
          created_at: Date.now(),
          last_accessed: Date.now(),
        });

        // Set session cookie and redirect
        const redirectTo = stateData.redirect_url || '/';
        const secure = url.protocol === 'https:';
        const headers = new Headers();
        headers.set('Location', redirectTo);
        headers.append('Set-Cookie', buildSessionCookie(SESSION_COOKIE_NAME, sessionId, secure));
        headers.append('Set-Cookie', buildDeleteCookie(LEGACY_SESSION_COOKIE_NAME, secure));

        return new Response(null, {
          status: 302,
          headers,
        });
      } catch (err) {
        console.error('[oauth] OAuth flow failed:', err);
        return Response.redirect(`${url.origin}/login?error=oauth_failed`, 302);
      }
    }

    // Pass all other requests to React Router SSR
    // @ts-ignore - virtual module provided by @react-router/dev
    const handler = createRequestHandler(() => import('virtual:react-router/server-build'), import.meta.env.MODE);
    return handler(request, {
      cloudflare: { env, ctx },
    });
  },

  async queue(batch: MessageBatch<AppScreenshotJob>, env: Env): Promise<void> {
    return handleScreenshotQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;

// Export Durable Object classes
export { ChatThreadDO };
export { UserDO, OrgDO };
export { WorkspaceDO };
