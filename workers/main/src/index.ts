// Custom worker that wraps OpenNext and handles WebSocket + Durable Objects
// @ts-ignore - .open-next/worker.js is generated at build time
import openNextHandler from "../../../.open-next/worker.js";
import { ChatThreadDO, type ChatEnv } from "./durable-objects.js";
import { UserDO, OrgDO, type AuthEnv } from "./auth.js";
import { WorkspaceContainer, handleWebSocketUpgrade, type WorkspaceContainerEnv } from './workspace-container.js';
import { WorkspaceDO } from './workspace.js';
import { getSession as getSessionKV } from './session-kv.js';
import { createScreenshotToken } from './worker-auth.js';
import puppeteer, { type Page } from '@cloudflare/puppeteer';
import {
  proxyCloudflareApi,
  cfApiError,
  resolveEnvPrefix,
  CHIRIDION_DEPLOY_TOKEN_HEADER,
  type CfApiProxyEnv,
  type DeploySideEffectsInfo,
} from './cf-api-proxy.js';
import { handleMcpRequest, ChiridionMcp, type McpEnv } from './mcp-handler.js';
import { isSignedToken, validateSignedToken } from './signed-tokens.js';
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

interface AppScreenshotJob {
  script_name: string;
  org_id: string;
  workspace_id: string;
  deploy_ts: number;
  env_prefix: string;
  is_public: boolean;
  screenshot_token?: string;
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

// Token TTL (24 hours in seconds)
const TOKEN_TTL_SECONDS = 86400;
const PREVIEW_PREFIX = 'app-previews';
const LOCAL_PREVIEW_URL = 'https://hello-world-test.chiridion.app/';
const VIEWPORT = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1.5,
};
const SCREENSHOT_CLIP = {
  x: 0,
  y: 0,
  width: VIEWPORT.width,
  height: VIEWPORT.height,
};
const NAVIGATION_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 1500;
const POST_LOAD_DELAY_MS = 600;
const SCRIPT_ORG_PREFIX = 'script_org:';

/**
 * Generate a per-thread deploy token and store in KV.
 * This token includes both workspaceId and threadId for auto-preview after deploys.
 */
async function mintPerThreadDeployToken(
  kv: KVNamespace,
  workspaceId: string,
  threadId: string
): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  const token = `ctok_${base64}`;

  const tokenData = JSON.stringify({ workspaceId, threadId });
  await kv.put(`platform_script_token:${token}`, tokenData, { expirationTtl: TOKEN_TTL_SECONDS });

  return token;
}

function buildPreviewKeys(job: AppScreenshotJob): { currentKey: string; versionedKey: string } {
  const base = `${PREVIEW_PREFIX}/${job.org_id}/${job.workspace_id}/${job.script_name}`;
  return {
    currentKey: `${base}/current.jpg`,
    versionedKey: `${base}/${job.deploy_ts}.jpg`,
  };
}

function getLocalPreviewUrl(env: Env): string {
  const override = env.LOCAL_APP_PREVIEW_URL?.trim();
  return override ? override : LOCAL_PREVIEW_URL;
}

function truncateError(err: unknown, maxLength = 500): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}...`;
}

async function navigateWithFallback(page: Page, targetUrl: string, logContext: Record<string, unknown>) {
  try {
    const response = await page.goto(targetUrl, {
      waitUntil: 'networkidle0',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    return { response, waitUntil: 'networkidle0' as const };
  } catch (err) {
    console.warn('[cf-api-proxy] local navigation fallback', {
      ...logContext,
      error: truncateError(err),
      from: 'networkidle0',
      to: 'domcontentloaded',
    });
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    return { response, waitUntil: 'domcontentloaded' as const };
  }
}

async function waitForReadySignal(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const root = document.documentElement;
        if (root?.dataset?.chiridionReady === 'true') return true;
        if (document.body?.dataset?.chiridionReady === 'true') return true;
        return Boolean(document.querySelector('[data-chiridion-ready="true"]'));
      },
      { timeout: READY_TIMEOUT_MS }
    );
  } catch {
    // Optional signal - ignore timeout.
  }
}

async function captureLocalPreview(env: Env, job: AppScreenshotJob): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(job.org_id));
  if (!env.BROWSER) {
    const errorMessage = 'Missing BROWSER binding for local screenshot capture.';
    await orgStub.updateWorkerScriptPreview(job.script_name, {
      status: 'failed',
      preview_key: null,
      preview_error: errorMessage,
      deploy_ts: job.deploy_ts,
    });
    console.warn('[cf-api-proxy] local screenshot skipped (missing BROWSER)', {
      scriptName: job.script_name,
      orgId: job.org_id,
    });
    return;
  }

  const targetUrl = getLocalPreviewUrl(env);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  let page: Page | null = null;

  try {
    browser = await puppeteer.launch(env.BROWSER);
    page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const { response, waitUntil } = await navigateWithFallback(page, targetUrl, {
      scriptName: job.script_name,
      orgId: job.org_id,
    });
    console.log('[cf-api-proxy] local navigation complete', {
      scriptName: job.script_name,
      orgId: job.org_id,
      status: response?.status() ?? null,
      waitUntil,
    });
    if (response && !response.ok()) {
      const statusText = typeof response.statusText === 'function' ? response.statusText() : '';
      throw new Error(
        `Navigation failed with status ${response.status()}${statusText ? ` ${statusText}` : ''} for ${targetUrl}`
      );
    }
    await page.addStyleTag({ content: 'body { overflow: hidden !important; }' });
    await waitForReadySignal(page);
    await page.waitForTimeout(POST_LOAD_DELAY_MS);
    await page.evaluate(() => window.scrollTo(0, 0));
    const image = (await page.screenshot({
      type: 'jpeg',
      quality: 80,
      clip: SCREENSHOT_CLIP,
    })) as Buffer;

    const { currentKey, versionedKey } = buildPreviewKeys(job);
    await env.R2_BUCKET.put(versionedKey, image, {
      httpMetadata: {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        script_name: job.script_name,
        org_id: job.org_id,
        workspace_id: job.workspace_id,
        deploy_ts: String(job.deploy_ts),
      },
    });
    await env.R2_BUCKET.put(currentKey, image, {
      httpMetadata: {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=300',
      },
      customMetadata: {
        script_name: job.script_name,
        org_id: job.org_id,
        workspace_id: job.workspace_id,
        deploy_ts: String(job.deploy_ts),
      },
    });

    const updateResult = await orgStub.updateWorkerScriptPreview(job.script_name, {
      status: 'ready',
      preview_key: currentKey,
      preview_error: null,
      deploy_ts: job.deploy_ts,
    });

    if (updateResult.stale) {
      console.log('[cf-api-proxy] local preview update skipped (stale)', {
        scriptName: job.script_name,
        orgId: job.org_id,
      });
      return;
    }

    console.log('[cf-api-proxy] local preview captured', {
      scriptName: job.script_name,
      orgId: job.org_id,
      targetUrl,
    });
  } catch (err) {
    const errorMessage = truncateError(err);
    console.error('[cf-api-proxy] local preview capture failed', {
      scriptName: job.script_name,
      orgId: job.org_id,
      error: errorMessage,
    });

    await orgStub.updateWorkerScriptPreview(job.script_name, {
      status: 'failed',
      preview_key: null,
      preview_error: errorMessage,
      deploy_ts: job.deploy_ts,
    });
  } finally {
    if (page) {
      await page.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

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
    await captureLocalPreview(env, jobBase);
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
      let userName: string | null = null;
      let userEmail: string;
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

      // Mint per-thread deploy token if threadId provided
      // This token stores {workspaceId, threadId} so the proxy can auto-set preview after deploys
      if (threadIdFromUrl) {
        const tokenKv = env.PLATFORM_SCRIPT_TOKENS ?? env.EMAIL_TO_USER;
        const threadToken = await mintPerThreadDeployToken(tokenKv, workspaceId, threadIdFromUrl);
        console.log('[ws] Minted per-thread deploy token', {
          threadId: threadIdFromUrl,
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
} satisfies ExportedHandler<Env>;

// Export Durable Object classes
export { ChatThreadDO };
export { UserDO, OrgDO };
export { WorkspaceDO };
