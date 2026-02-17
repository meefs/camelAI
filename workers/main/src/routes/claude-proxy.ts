/**
 * Claude API Proxy Route
 *
 * Proxies Anthropic API requests from the sandbox container.
 * Uses CF AI Gateway with Bedrock as primary and Anthropic as fallback.
 * Authenticates via sandbox-host injected headers and tracks spend per org.
 */

import { waitUntil } from 'cloudflare:workers';
import type { RouteContext } from '../types.js';
import type { OrgDO } from '../auth.js';
import { validateSandboxProxy } from '../sandbox-auth.js';
import {
  transformRequestForBedrock,
  buildAnthropicGatewayRequest,
  createBedrockStreamAdapter,
  createAnthropicUsageExtractor,
  type AnthropicRequestBody,
  type UsageInfo,
} from '../adapters/bedrock.js';
import { calculateCostCents, checkSpendLimitsFromKV } from '../lib/cost-calculation.js';

/**
 * Headers to forward from client to Anthropic API
 */
const FORWARDED_HEADERS = ['anthropic-beta', 'anthropic-version'] as const;

/**
 * Extract Anthropic-specific headers from incoming request
 */
function extractAnthropicHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

/**
 * Record spend via OrgDO RPC.
 * Goes through DO to ensure ordered KV writes.
 * Returns a promise - caller should use waitUntil.
 */
async function recordSpend(
  env: RouteContext['env'],
  orgId: string,
  model: string,
  provider: 'bedrock' | 'anthropic',
  usage: UsageInfo
): Promise<void> {
  const costCents = calculateCostCents(model, usage);

  console.log('[claude-proxy] recording spend', {
    org_id: orgId,
    model,
    provider,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_cents: costCents,
  });

  const orgStub = env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
  await orgStub.recordSpend(orgId, costCents);
}


type ProxyResult = { ok: true; response: Response } | { ok: false; status: number };

/**
 * Try calling Bedrock via CF AI Gateway
 */
async function tryBedrock(
  body: AnthropicRequestBody,
  env: RouteContext['env'],
  clientHeaders: Record<string, string>,
  onUsage?: (usage: UsageInfo) => void
): Promise<ProxyResult> {
  if (!env.CF_ACCOUNT_ID || !env.CF_GATEWAY_NAME || !env.CF_GATEWAY_TOKEN) {
    return { ok: false, status: 500 };
  }

  try {
    const { url, options, isStreaming } = transformRequestForBedrock(body, {
      cfAccountId: env.CF_ACCOUNT_ID,
      cfGatewayName: env.CF_GATEWAY_NAME,
      cfGatewayToken: env.CF_GATEWAY_TOKEN,
      region: env.BEDROCK_REGION || 'us-west-2',
      clientHeaders,
    });

    const response = await fetch(url, options);

    if (!response.ok) {
      console.log('[claude-proxy] Bedrock error', { status: response.status, statusText: response.statusText });
      return { ok: false, status: response.status };
    }

    if (isStreaming) {
      const adapted = response.body!.pipeThrough(createBedrockStreamAdapter(onUsage));
      return {
        ok: true,
        response: new Response(adapted, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Provider': 'bedrock' },
        }),
      };
    }

    // Non-streaming: usage available immediately
    const data = (await response.json()) as { usage?: UsageInfo };
    if (data.usage && onUsage) onUsage(data.usage);
    return {
      ok: true,
      response: new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'X-Provider': 'bedrock' },
      }),
    };
  } catch (e) {
    console.error('[claude-proxy] Bedrock exception', { error: String(e) });
    return { ok: false, status: 0 };
  }
}

/**
 * Call Anthropic via CF AI Gateway (fallback)
 */
async function callAnthropicFallback(
  bodyText: string,
  isStreaming: boolean,
  env: RouteContext['env'],
  clientHeaders: Record<string, string>,
  onUsage?: (usage: UsageInfo) => void
): Promise<Response> {
  if (!env.CF_ACCOUNT_ID || !env.CF_GATEWAY_NAME || !env.CF_GATEWAY_TOKEN) {
    return new Response(JSON.stringify({ error: 'Gateway not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { url, options } = buildAnthropicGatewayRequest(bodyText, {
    cfAccountId: env.CF_ACCOUNT_ID,
    cfGatewayName: env.CF_GATEWAY_NAME,
    cfGatewayToken: env.CF_GATEWAY_TOKEN,
    clientHeaders,
  });

  const response = await fetch(url, options);

  if (isStreaming && response.ok) {
    const adapted = response.body!.pipeThrough(createAnthropicUsageExtractor(onUsage));
    return new Response(adapted, {
      status: response.status,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Provider': 'anthropic' },
    });
  }

  if (response.ok) {
    const data = (await response.json()) as { usage?: UsageInfo };
    if (data.usage && onUsage) onUsage(data.usage);
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json', 'X-Provider': 'anthropic' },
    });
  }

  // Error response - pass through
  return new Response(response.body, {
    status: response.status,
    headers: { 'X-Provider': 'anthropic' },
  });
}

/**
 * Handle count tokens requests
 * Route: POST /api/claude/v1/messages/count_tokens
 * Forwards directly to Anthropic API using ANTHROPIC_API_KEY secret
 */
export async function handleCountTokens({ req, env }: RouteContext): Promise<Response> {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Require sandbox-host proxy identity headers.
  const proxyAuth = validateSandboxProxy(req, env);
  if (!proxyAuth.valid) {
    return new Response(JSON.stringify({ error: 'Unauthorized: sandbox proxy auth required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Require ANTHROPIC_API_KEY secret for direct Anthropic API calls
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Extract headers to forward
  const clientHeaders = extractAnthropicHeaders(req);

  // Forward to Anthropic API
  const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      ...clientHeaders, // Forward client headers (may override anthropic-version)
    },
    body: req.body,
  });

  // Pass through response
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/json',
    },
  });
}

/**
 * Handle Claude API proxy requests
 * Route: POST /api/claude/v1/messages
 */
export async function handleClaudeProxy({ req, env, ctx }: RouteContext): Promise<Response> {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Require sandbox-host proxy identity headers.
  const proxyAuth = validateSandboxProxy(req, env);
  if (!proxyAuth.valid) {
    return new Response(JSON.stringify({ error: 'Unauthorized: sandbox proxy auth required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const orgId = proxyAuth.orgId;

  // Extract headers to forward to Anthropic
  const clientHeaders = extractAnthropicHeaders(req);

  // Parse request body
  const bodyText = await req.text();
  let body: AnthropicRequestBody;
  try {
    body = JSON.parse(bodyText) as AnthropicRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const isStreaming = body.stream === true;
  const model = body.model;

  // Check spend limits before making the request (fast KV lookup, no DO call)
  const limitCheck = await checkSpendLimitsFromKV(env.APP_KV, orgId);
  if (limitCheck.exceeded) {
    const resetsIn = limitCheck.resets_at ? Math.max(0, Math.ceil((limitCheck.resets_at - Date.now()) / 1000 / 60)) : 0;
    console.log('[claude-proxy] Spend limit exceeded', {
      org_id: orgId,
      window: limitCheck.window,
      current_cents: limitCheck.current_cents,
      limit_cents: limitCheck.limit_cents,
      resets_in_minutes: resetsIn,
    });
    return new Response(
      JSON.stringify({
        error: {
          type: 'rate_limit_error',
          message: `Spend limit exceeded for ${limitCheck.window} window. Current: $${(limitCheck.current_cents! / 100).toFixed(2)}, Limit: $${(limitCheck.limit_cents! / 100).toFixed(2)}. Resets in ${resetsIn} minutes.`,
        },
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-Spend-Limit-Window': limitCheck.window!,
          'X-Spend-Limit-Current': String(limitCheck.current_cents),
          'X-Spend-Limit-Max': String(limitCheck.limit_cents),
          'X-Spend-Limit-Resets-At': String(limitCheck.resets_at),
          'Retry-After': String(Math.max(1, resetsIn * 60)),
        },
      }
    );
  }

  // Fire-and-forget spend recording
  const trackSpend = (provider: 'bedrock' | 'anthropic') => (usage: UsageInfo) => {
    waitUntil(recordSpend(env, orgId, model, provider, usage).catch(console.error));
  };

  // Try Bedrock first
  const bedrockResult = await tryBedrock(body, env, clientHeaders, trackSpend('bedrock'));
  if (bedrockResult.ok) {
    return bedrockResult.response;
  }

  console.log('[claude-proxy] Bedrock failed, falling back to Anthropic', {
    status: bedrockResult.status,
    org_id: orgId,
  });

  // Fallback to Anthropic
  return callAnthropicFallback(bodyText, isStreaming, env, clientHeaders, trackSpend('anthropic'));
}
