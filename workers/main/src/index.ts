// Custom worker that wraps OpenNext and handles WebSocket + Durable Objects
// @ts-ignore - .open-next/worker.js is generated at build time
import openNextHandler from "../../../.open-next/worker.js";
import { ChatThreadDO, type ChatEnv } from "./durable-objects.js";
import { UserDO, OrgDO, type AuthEnv } from "./auth.js";
import { WorkspaceContainer, handleWebSocketUpgrade, type WorkspaceContainerEnv } from './workspace-container.js';
import { WorkspaceDO } from './workspace.js';
import { getSession as getSessionKV } from './session-kv.js';
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
export { DoRpcService } from './rpc-service.js';
export { ChiridionMcp } from './mcp-handler.js';

// Export WorkspaceContainer as ThreadSandbox to match wrangler.jsonc class_name
export { WorkspaceContainer as ThreadSandbox };

const SESSION_COOKIE_NAME = 'chiridion_session';
const CHIRIDION_SESSION_HEADER = 'X-Chiridion-Session-Id';

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || '';
  }
  return null;
}

interface Env extends ChatEnv, AuthEnv, WorkspaceContainerEnv, CfApiProxyEnv, McpEnv {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  SESSIONS: KVNamespace;
  NEXTJS_ENV?: string;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  APP_SCREENSHOT_QUEUE?: Queue<AppScreenshotJob>;
  BROWSER?: Fetcher;
  LOCAL_APP_PREVIEW_URL?: string;
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

    // Handle WebSocket upgrade for thread preview state at /ws/thread/{threadId}
    const threadWsMatch = url.pathname.match(/^\/ws\/thread\/([^\/]+)$/);
    if (threadWsMatch && request.headers.get('Upgrade') === 'websocket') {
      const threadId = threadWsMatch[1];

      // Authenticate the request
      const headerSessionId = request.headers.get(CHIRIDION_SESSION_HEADER);
      const cookieSessionId = getCookieValue(request.headers.get('Cookie'), SESSION_COOKIE_NAME);
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
      // Use RPC service since threads are now stored in OrgDO
      const rpc = env.DO_RPC as typeof env.DO_RPC & { [Symbol.dispose]?: () => void };
      let thread;
      try {
        thread = await (rpc as any).getThread(threadId, workspaceId);
      } finally {
        rpc[Symbol.dispose]?.();
      }
      if (!thread) {
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
      const cookieSessionId = getCookieValue(request.headers.get('Cookie'), SESSION_COOKIE_NAME);
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
        const rpc = env.DO_RPC as typeof env.DO_RPC & { [Symbol.dispose]?: () => void };
        try {
          accessLevel = await (rpc as any).getWorkspaceAccess(workspaceId, session.user_id);
        } finally {
          rpc[Symbol.dispose]?.();
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
        const rpc = env.DO_RPC as typeof env.DO_RPC & { [Symbol.dispose]?: () => void };
        try {
          const userProfile = await rpc.getUserById(session.user_id);
          if (!userProfile) {
            console.error('[ws] User profile not found', { userId: session.user_id });
            return new Response('User not found', { status: 404 });
          }
          userName = userProfile.name;
          userEmail = userProfile.email;

          // Validate threadId belongs to this workspace before including in deploy token
          if (threadIdFromUrl) {
            const thread = await rpc.getThread(threadIdFromUrl, workspaceId);
            if (thread) {
              validatedThreadId = threadIdFromUrl;
            } else {
              console.warn('[ws] Thread not found or not in workspace, skipping thread token', {
                threadId: threadIdFromUrl,
                workspaceId,
                orgId,
              });
            }
          }
        } finally {
          rpc[Symbol.dispose]?.();
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

    // Pass all other requests to OpenNext/Next.js if dev env var is not set
	if (env.NEXTJS_ENV == 'development') {
	  return new Response('Not Found', { status: 404 });
	}
    return openNextHandler.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<AppScreenshotJob>, env: Env): Promise<void> {
    return handleScreenshotQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;

// Export Durable Object classes
export { ChatThreadDO };
export { UserDO, OrgDO };
export { WorkspaceDO };
