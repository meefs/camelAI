import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import AnthropicFoundry from '@anthropic-ai/foundry-sdk';
import type { DoRpcService } from '../../main/src/rpc-service';
import type { ApiTokenData } from '../../main/src/api-tokens';

type ProviderType = 'anthropic' | 'foundry' | 'bedrock';

type ProviderConfig = {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  resource?: string;
  apiKeyEnv?: string;
  defaultHeaders?: Record<string, string>;
  modelId?: string;
  awsRegion?: string;
};

interface Env {
  PROXY_PROVIDERS?: string;
  PROXY_DEFAULT_PROVIDER?: string;
  PROXY_FALLBACK_ORDER?: string;
  PROXY_LOG_LEVEL?: string;
  PROXY_MODEL_ALIASES?: string;
  PROXY_BEDROCK_MODEL_MAP?: string;
  MAIN_RPC?: DoRpcService;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_API_URL?: string;
  ANTHROPIC_VERSION?: string;
  ANTHROPIC_FOUNDRY_API_KEY?: string;
  ANTHROPIC_FOUNDRY_BASE_URL?: string;
  ANTHROPIC_FOUNDRY_RESOURCE?: string;
  AZURE_FOUNDRY_API_KEY?: string;
  AZURE_FOUNDRY_BASE_URL?: string;
  AZURE_FOUNDRY_RESOURCE?: string;
  BEDROCK_API_KEY?: string;
  AWS_BEARER_TOKEN_BEDROCK?: string;
  AWS_REGION?: string;
  BEDROCK_MODEL_ID?: string;
  ANTHROPIC_BEDROCK_BASE_URL?: string;
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type AuthContext = {
  tokenId: string;
  token: ApiTokenData;
};

type UsageContext = {
  orgId: string;
  userId: string;
  tokenId: string;
};

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const LOG_LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, none: 50 };
const DEFAULT_BEDROCK_MODEL_MAP: Record<string, string> = {
  haiku: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-haiku': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-sonnet-4-5-20250929': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-sonnet-4-5': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  sonnet: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-sonnet': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-haiku-4-5-20251001': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-haiku-4-5': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-opus-4-5-20251101': 'global.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-opus-4-5': 'global.anthropic.claude-opus-4-5-20251101-v1:0',
  opus: 'global.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-opus': 'global.anthropic.claude-opus-4-5-20251101-v1:0',
};
const DEFAULT_MODEL_ALIASES: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
  'claude-opus-4-5-20251101': 'claude-opus-4-5',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname !== '/v1/messages') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const clientKey = extractClientKey(request);
    const authResult = await authorizeClient(clientKey, env);
    if (!authResult.ok || !authResult.auth) {
      return errorResponse(401, 'authentication_error', authResult.error ?? 'Invalid API key');
    }

    const bodyText = await request.text();

    let body: Record<string, unknown>;
    try {
      body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    } catch (error) {
      return errorResponse(400, 'invalid_request_error', 'Invalid JSON body');
    }

    const stream = Boolean(body.stream);
    const providers = resolveProviders(env);

    if (providers.length === 0) {
      return errorResponse(500, 'api_error', 'No providers configured');
    }

    const usageContext = buildUsageContext(body, request, authResult.auth);
    let lastResponse: Response | null = null;

    for (const provider of providers) {
      try {
        const result = stream
          ? await handleStream(provider, body, env, usageContext, ctx)
          : await handleNonStream(provider, body, env, usageContext, ctx);

        if (result.ok) {
          return result.response;
        }

        lastResponse = result.response;
        logWarn(env, 'proxy provider failed', {
          provider: provider.name,
          status: result.status,
          request_id: getRequestId(result.response.headers),
        });
        if (!shouldFallback(result.status)) {
          return result.response;
        }
      } catch (error) {
        logError(env, 'proxy provider exception', {
          provider: provider.name,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        lastResponse = errorResponse(502, 'api_error', 'Upstream error');
      }
    }

    return (
      lastResponse ??
      errorResponse(502, 'api_error', 'All providers failed')
    );
  },
};

function extractClientKey(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth) {
    const [scheme, token] = auth.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token.trim();
    if (scheme?.toLowerCase() === 'api-key' && token) return token.trim();
  }
  const headerKey = request.headers.get('x-api-key') || request.headers.get('x-chiridion-key');
  return headerKey?.trim() || null;
}

async function authorizeClient(
  clientKey: string | null,
  env: Env
): Promise<{ ok: boolean; error?: string; auth?: AuthContext }> {
  if (!clientKey) return { ok: false, error: 'Missing API key' };
  if (!env.MAIN_RPC) return { ok: false, error: 'Auth service unavailable' };

  try {
    const token = await env.MAIN_RPC.validateApiToken(clientKey);
    if (!token) return { ok: false, error: 'Invalid API key' };
    if (!hasProxyScope(token.scopes)) {
      return { ok: false, error: 'API key lacks proxy scope' };
    }
    return { ok: true, auth: { tokenId: clientKey, token } };
  } catch (error) {
    logError(env, 'proxy auth failure', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return { ok: false, error: 'Auth service unavailable' };
  }
}

function hasProxyScope(scopes: string[] | undefined): boolean {
  if (!scopes || scopes.length === 0) return false;
  const normalized = scopes.map((scope) => scope.toLowerCase());
  return normalized.some(
    (scope) =>
      scope === 'proxy' ||
      scope.startsWith('proxy:') ||
      scope === '*' ||
      scope === 'all' ||
      scope === 'admin'
  );
}

function resolveProviders(env: Env): ProviderConfig[] {
  const configured = loadProviders(env);
  if (configured.length === 0) return [];
  const nameMap = new Map(configured.map((provider) => [provider.name, provider]));
  const requested: string[] = [];

  if (env.PROXY_DEFAULT_PROVIDER) requested.push(env.PROXY_DEFAULT_PROVIDER);

  const fallbackOrder = env.PROXY_FALLBACK_ORDER?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  if (requested.length === 0 && fallbackOrder.length > 0) requested.push(...fallbackOrder);
  if (requested.length === 0) return configured;

  const ordered: ProviderConfig[] = [];
  for (const name of requested) {
    const provider = nameMap.get(name);
    if (provider) ordered.push(provider);
  }
  return ordered.length > 0 ? ordered : configured;
}

function loadProviders(env: Env): ProviderConfig[] {
  if (env.PROXY_PROVIDERS) {
    try {
      const parsed = JSON.parse(env.PROXY_PROVIDERS) as ProviderConfig[];
      if (Array.isArray(parsed)) return parsed;
    } catch (error) {
      logError(env, 'Invalid PROXY_PROVIDERS JSON');
    }
  }

  const providers: ProviderConfig[] = [];
  if (env.ANTHROPIC_API_KEY) {
    providers.push({
      name: 'anthropic',
      type: 'anthropic',
      baseUrl: env.ANTHROPIC_API_URL || 'https://api.anthropic.com',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      defaultHeaders: {
        'anthropic-version': env.ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION,
      },
    });
  }

  if (env.ANTHROPIC_FOUNDRY_API_KEY || env.AZURE_FOUNDRY_API_KEY) {
    providers.push({
      name: 'foundry',
      type: 'foundry',
      baseUrl: env.ANTHROPIC_FOUNDRY_BASE_URL || env.AZURE_FOUNDRY_BASE_URL,
      resource: env.ANTHROPIC_FOUNDRY_RESOURCE || env.AZURE_FOUNDRY_RESOURCE,
      apiKeyEnv: env.ANTHROPIC_FOUNDRY_API_KEY ? 'ANTHROPIC_FOUNDRY_API_KEY' : 'AZURE_FOUNDRY_API_KEY',
      defaultHeaders: {
        'anthropic-version': env.ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION,
      },
    });
  }

  const bedrockApiKey = env.BEDROCK_API_KEY || env.AWS_BEARER_TOKEN_BEDROCK;
  if (bedrockApiKey) {
    providers.push({
      name: 'bedrock-api-key',
      type: 'bedrock',
      modelId: env.BEDROCK_MODEL_ID,
      awsRegion: env.AWS_REGION,
      baseUrl: env.ANTHROPIC_BEDROCK_BASE_URL,
    });
  }

  return providers;
}

function buildUsageContext(
  body: Record<string, unknown>,
  request: Request,
  auth: AuthContext
): UsageContext | null {
  const userId = resolveUsageUserId(body, request, auth);
  if (!userId) return null;
  return {
    orgId: auth.token.org_id,
    userId,
    tokenId: auth.tokenId,
  };
}

function resolveUsageUserId(body: Record<string, unknown>, request: Request, auth: AuthContext): string | null {
  const metadata = body.metadata as { user_id?: unknown } | undefined;
  const metadataUserId = typeof metadata?.user_id === 'string' ? metadata.user_id : null;
  return metadataUserId || request.headers.get('x-user-id') || auth.token.user_id || null;
}

function resolveBedrockApiKey(env: Env): string | null {
  return env.BEDROCK_API_KEY || env.AWS_BEARER_TOKEN_BEDROCK || null;
}

function normalizeModelInBody(body: Record<string, unknown>, env: Env): Record<string, unknown> {
  const model = body.model;
  if (typeof model !== 'string') return body;
  const normalized = normalizeAnthropicModel(model, env);
  if (normalized === model) return body;
  return { ...body, model: normalized };
}

function normalizeAnthropicModel(requested: string, env: Env): string {
  const trimmed = requested.trim();
  if (!trimmed) return requested;
  const aliasMap = { ...DEFAULT_MODEL_ALIASES, ...parseStringMap(env.PROXY_MODEL_ALIASES) };
  if (aliasMap[trimmed]) return aliasMap[trimmed];
  const lowered = trimmed.toLowerCase();
  if (aliasMap[lowered]) return aliasMap[lowered];
  if (trimmed.startsWith('claude-')) return trimmed;

  if (lowered.includes('haiku')) return 'claude-haiku-4-5';
  if (lowered.includes('sonnet')) return 'claude-sonnet-4-5';
  if (lowered.includes('opus')) return 'claude-opus-4-5';

  return trimmed;
}

type BedrockModelResolution = {
  modelId: string | null;
  responseModel: string | null;
};

function resolveBedrockModel(requested: string | undefined, env: Env): BedrockModelResolution {
  if (!requested) return { modelId: null, responseModel: null };
  const trimmed = requested.trim();

  const { map, reverseMap } = getBedrockModelMaps(env);

  if (trimmed.startsWith('global.anthropic.')) {
    return {
      modelId: trimmed,
      responseModel: reverseMap.get(trimmed) ?? trimmed,
    };
  }
  if (trimmed.startsWith('anthropic.')) {
    const modelId = `global.${trimmed}`;
    return {
      modelId,
      responseModel: reverseMap.get(modelId) ?? trimmed,
    };
  }

  const normalized = normalizeAnthropicModel(trimmed, env);
  const mapped =
    map.get(trimmed) ||
    map.get(trimmed.toLowerCase()) ||
    map.get(normalized) ||
    map.get(normalized.toLowerCase());
  if (mapped) {
    return { modelId: mapped, responseModel: normalized };
  }

  return { modelId: trimmed, responseModel: trimmed };
}

function getBedrockModelMaps(env: Env): { map: Map<string, string>; reverseMap: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(DEFAULT_BEDROCK_MODEL_MAP));
  const custom = parseStringMap(env.PROXY_BEDROCK_MODEL_MAP);
  for (const [key, value] of Object.entries(custom)) {
    map.set(key, value);
  }

  const reverseMap = new Map<string, string>();
  for (const [key, value] of map.entries()) {
    const existing = reverseMap.get(value);
    if (!existing || (!looksCanonical(existing) && looksCanonical(key))) {
      reverseMap.set(value, key);
    }
  }

  return { map, reverseMap };
}

function looksCanonical(model: string): boolean {
  return /\\d{8}/.test(model);
}

function parseStringMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, string>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'string') out[key] = val;
    }
    return out;
  } catch (error) {
    return {};
  }
}

function shouldFallback(status: number): boolean {
  return status >= 500 || status === 429 || status === 401 || status === 403;
}

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type HandlerResult = {
  ok: boolean;
  status: number;
  message: string;
  response: Response;
};

async function handleNonStream(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  ctx: ExecutionContext
): Promise<HandlerResult> {
  switch (provider.type) {
    case 'anthropic':
      return handleAnthropicNonStream(provider, body, env, usageContext, ctx);
    case 'foundry':
      return handleFoundryNonStream(provider, body, env, usageContext, ctx);
    case 'bedrock':
      return handleBedrockNonStream(provider, body, env, usageContext, ctx);
    default:
      return buildProviderError(provider, 500, 'Unsupported provider type');
  }
}

async function handleStream(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  ctx: ExecutionContext
): Promise<HandlerResult> {
  switch (provider.type) {
    case 'anthropic':
      return handleAnthropicStream(provider, body, env, usageContext, ctx);
    case 'foundry':
      return handleFoundryStream(provider, body, env, usageContext, ctx);
    case 'bedrock':
      return handleBedrockStream(provider, body, env, usageContext, ctx);
    default:
      return buildProviderError(provider, 500, 'Unsupported provider type');
  }
}

async function handleAnthropicNonStream(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  ctx: ExecutionContext
): Promise<HandlerResult> {
  const apiKey = resolveEnvKey(env, provider.apiKeyEnv || 'ANTHROPIC_API_KEY');
  if (!apiKey) return buildProviderError(provider, 500, 'Missing Anthropic API key');

  const normalizedBody = normalizeModelInBody(body, env);
  const client = createAnthropicClient(provider, apiKey, env);
  try {
    const response = await client.messages.create({ ...(normalizedBody as any), stream: false }).asResponse();
    return handleSdkJsonResponse(response, normalizedBody, env, usageContext, provider.name, ctx);
  } catch (error) {
    const handled = handleSdkException(provider, env, error);
    if (handled) return handled;
    throw error;
  }
}

async function handleAnthropicStream(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  ctx: ExecutionContext
): Promise<HandlerResult> {
  const apiKey = resolveEnvKey(env, provider.apiKeyEnv || 'ANTHROPIC_API_KEY');
  if (!apiKey) return buildProviderError(provider, 500, 'Missing Anthropic API key');

  const normalizedBody = normalizeModelInBody(body, env);
  const client = createAnthropicClient(provider, apiKey, env);
  try {
    const response = await client.messages.create({ ...(normalizedBody as any), stream: true }).asResponse();
    return handleSdkStreamResponse(response, normalizedBody, env, usageContext, provider.name, ctx);
  } catch (error) {
    const handled = handleSdkException(provider, env, error);
    if (handled) return handled;
    throw error;
  }
}

async function handleFoundryNonStream(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  ctx: ExecutionContext
): Promise<HandlerResult> {
  const apiKey = resolveEnvKey(env, provider.apiKeyEnv || 'ANTHROPIC_FOUNDRY_API_KEY') ??
    resolveEnvKey(env, 'AZURE_FOUNDRY_API_KEY');
  if (!apiKey) return buildProviderError(provider, 500, 'Missing Foundry API key');

  const normalizedBody = normalizeModelInBody(body, env);
  const client = createFoundryClient(provider, apiKey, env);
  try {
    const response = await client.messages.create({ ...(normalizedBody as any), stream: false }).asResponse();
    return handleSdkJsonResponse(response, normalizedBody, env, usageContext, provider.name, ctx);
  } catch (error) {
    const handled = handleSdkException(provider, env, error);
    if (handled) return handled;
    throw error;
  }
}

async function handleFoundryStream(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  ctx: ExecutionContext
): Promise<HandlerResult> {
  const apiKey = resolveEnvKey(env, provider.apiKeyEnv || 'ANTHROPIC_FOUNDRY_API_KEY') ??
    resolveEnvKey(env, 'AZURE_FOUNDRY_API_KEY');
  if (!apiKey) return buildProviderError(provider, 500, 'Missing Foundry API key');

  const normalizedBody = normalizeModelInBody(body, env);
  const client = createFoundryClient(provider, apiKey, env);
  try {
    const response = await client.messages.create({ ...(normalizedBody as any), stream: true }).asResponse();
    return handleSdkStreamResponse(response, normalizedBody, env, usageContext, provider.name, ctx);
  } catch (error) {
    const handled = handleSdkException(provider, env, error);
    if (handled) return handled;
    throw error;
  }
}

async function handleBedrockNonStream(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  ctx: ExecutionContext
): Promise<HandlerResult> {
  const bedrockApiKey = resolveBedrockApiKey(env);
  if (!bedrockApiKey) {
    return buildProviderError(provider, 500, 'Missing Bedrock API key');
  }
  const client = createBedrockClient(provider, env, bedrockApiKey);
  const resolved = resolveBedrockModel((body.model as string | undefined) || provider.modelId, env);
  if (!resolved.modelId) return buildProviderError(provider, 400, 'Missing model for Bedrock request');

  try {
    const response = await client
      .messages.create({ ...(body as any), model: resolved.modelId, stream: false })
      .asResponse();

    const payload = await response.arrayBuffer();
    if (!response.ok) {
      logUpstreamError(env, provider.name, response.status, response.headers, payload);
      return buildProxyResponse(response.status, response.headers, payload);
    }

    const text = new TextDecoder().decode(payload);
    const parsed = (parseJson(text) ?? {}) as Record<string, unknown>;
    if (resolved.responseModel && typeof parsed.model === 'string') {
      parsed.model = resolved.responseModel;
    }
    const updatedText = JSON.stringify(parsed);
    const usage = extractUsageFromMessage(parsed) ?? estimateUsage(body, parsed);
    const usageModel = resolved.responseModel ?? (typeof body.model === 'string' ? body.model : null);
    ctx.waitUntil(recordUsage(env, usageContext, usage, provider.name, usageModel));

    const headers = cloneHeaders(response.headers, true);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');

    return {
      ok: true,
      status: response.status,
      message: 'ok',
      response: new Response(updatedText, { status: response.status, headers }),
    };
  } catch (error) {
    const handled = handleSdkException(provider, env, error);
    if (handled) return handled;
    throw error;
  }
}

async function handleBedrockStream(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  ctx: ExecutionContext
): Promise<HandlerResult> {
  const bedrockApiKey = resolveBedrockApiKey(env);
  if (!bedrockApiKey) {
    return buildProviderError(provider, 500, 'Missing Bedrock API key');
  }
  const client = createBedrockClient(provider, env, bedrockApiKey);
  const resolved = resolveBedrockModel((body.model as string | undefined) || provider.modelId, env);
  if (!resolved.modelId) return buildProviderError(provider, 400, 'Missing model for Bedrock request');

  try {
    const { data: stream, response } = await client
      .messages.create({ ...(body as any), model: resolved.modelId, stream: true })
      .withResponse();

    if (!response.ok) {
      const payload = await response.arrayBuffer();
      return buildProxyResponse(response.status, response.headers, payload);
    }

    const { readable, usagePromise } = streamAnthropicEvents(stream, body, resolved.responseModel);
    const usageModel = resolved.responseModel ?? (typeof body.model === 'string' ? body.model : null);
    ctx.waitUntil(usagePromise.then((usage) => recordUsage(env, usageContext, usage, provider.name, usageModel)));

    const headers = cloneHeaders(response.headers);
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    headers.delete('content-length');

    return {
      ok: true,
      status: response.status,
      message: 'ok',
      response: new Response(readable, { status: response.status, headers }),
    };
  } catch (error) {
    const handled = handleSdkException(provider, env, error);
    if (handled) return handled;
    throw error;
  }
}

function createAnthropicClient(provider: ProviderConfig, apiKey: string, env: Env): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: provider.baseUrl || env.ANTHROPIC_API_URL,
    defaultHeaders: provider.defaultHeaders ?? {
      'anthropic-version': env.ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION,
    },
  });
}

function createFoundryClient(provider: ProviderConfig, apiKey: string, env: Env): AnthropicFoundry {
  return new AnthropicFoundry({
    apiKey,
    baseURL: provider.baseUrl || env.ANTHROPIC_FOUNDRY_BASE_URL || env.AZURE_FOUNDRY_BASE_URL,
    resource: provider.resource || env.ANTHROPIC_FOUNDRY_RESOURCE || env.AZURE_FOUNDRY_RESOURCE,
    defaultHeaders: provider.defaultHeaders ?? {
      'anthropic-version': env.ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION,
    },
  });
}

function createBedrockClient(provider: ProviderConfig, env: Env, bedrockApiKey: string | null): AnthropicBedrock {
  const useApiKey = Boolean(bedrockApiKey);
  return new AnthropicBedrock({
    awsRegion: provider.awsRegion || env.AWS_REGION,
    baseURL: provider.baseUrl || env.ANTHROPIC_BEDROCK_BASE_URL,
    skipAuth: useApiKey,
    defaultHeaders: useApiKey ? { Authorization: `Bearer ${bedrockApiKey}` } : undefined,
  });
}

async function handleSdkJsonResponse(
  response: Response,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  providerName: string,
  ctx: ExecutionContext,
  stripRequestId = false
): Promise<HandlerResult> {
  const payload = await response.arrayBuffer();
  if (!response.ok) {
    logUpstreamError(env, providerName, response.status, response.headers, payload);
    return buildProxyResponse(response.status, response.headers, payload);
  }

  const text = new TextDecoder().decode(payload);
  let usage = parseUsageFromJson(text);
  if (!usage) {
    usage = estimateUsage(body, parseJson(text) ?? {});
  }
  const model = typeof body.model === 'string' ? body.model : null;
  ctx.waitUntil(recordUsage(env, usageContext, usage, providerName, model));

  const headers = cloneHeaders(response.headers, stripRequestId);
  return {
    ok: true,
    status: response.status,
    message: 'ok',
    response: new Response(payload, { status: response.status, headers }),
  };
}

async function handleSdkStreamResponse(
  response: Response,
  body: Record<string, unknown>,
  env: Env,
  usageContext: UsageContext | null,
  providerName: string,
  ctx: ExecutionContext
): Promise<HandlerResult> {
  if (!response.ok) {
    const payload = await response.arrayBuffer();
    logUpstreamError(env, providerName, response.status, response.headers, payload);
    return buildProxyResponse(response.status, response.headers, payload);
  }

  if (!response.body) {
    return buildProviderError({ name: providerName, type: 'anthropic' }, 502, 'Missing upstream stream body');
  }

  const [clientStream, usageStream] = response.body.tee();
  const usagePromise = parseAnthropicUsageFromStream(usageStream, body);
  const model = typeof body.model === 'string' ? body.model : null;
  ctx.waitUntil(usagePromise.then((usage) => recordUsage(env, usageContext, usage, providerName, model)));

  const headers = cloneHeaders(response.headers);
  headers.delete('content-length');

  return {
    ok: true,
    status: response.status,
    message: 'ok',
    response: new Response(clientStream, { status: response.status, headers }),
  };
}

function buildProviderError(provider: ProviderConfig, status: number, message: string): HandlerResult {
  return {
    ok: false,
    status,
    message,
    response: errorResponse(status, 'api_error', message),
  };
}

type ApiErrorLike = {
  status?: number;
  error?: unknown;
  headers?: Headers;
  message?: string;
};

function handleSdkException(provider: ProviderConfig, env: Env, error: unknown): HandlerResult | null {
  const apiError = error as ApiErrorLike;
  if (apiError && typeof apiError.status === 'number' && apiError.error) {
    const status = apiError.status;
    const headers = apiError.headers instanceof Headers ? apiError.headers : new Headers();
    const payload = normalizeErrorPayload(apiError.error);
    const errorInfo = extractErrorInfo(payload, '');
    logWarn(env, 'proxy upstream error', {
      provider: provider.name,
      status,
      request_id: getRequestId(headers),
      error_type: errorInfo.type,
      error_message: errorInfo.message,
      error_code: errorInfo.code,
    });
    return {
      ok: false,
      status,
      message: apiError.message ?? 'Upstream error',
      response: new Response(JSON.stringify(payload), {
        status,
        headers: mergeErrorHeaders(headers),
      }),
    };
  }
  return null;
}

function buildProxyResponse(status: number, headers: Headers, payload: ArrayBuffer): HandlerResult {
  const outHeaders = cloneHeaders(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    message: status >= 200 && status < 300 ? 'ok' : 'error',
    response: new Response(payload, { status, headers: outHeaders }),
  };
}

function cloneHeaders(headers: Headers, stripRequestId = false): Headers {
  const cloned = new Headers(headers);
  if (stripRequestId) {
    cloned.delete('request-id');
  }
  return cloned;
}

function mergeErrorHeaders(headers: Headers): Headers {
  const cloned = new Headers(headers);
  if (!cloned.has('content-type')) {
    cloned.set('content-type', 'application/json');
  }
  return cloned;
}

function normalizeErrorPayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (record.type === 'error') {
      const errorObj = record.error as Record<string, unknown> | undefined;
      if (errorObj && typeof errorObj.message !== 'string') {
        return {
          ...record,
          error: { ...errorObj, message: safeStringify(errorObj.message) },
        };
      }
      return record;
    }

    if (record.error && typeof record.error === 'object') {
      const errorObj = record.error as Record<string, unknown>;
      const message =
        typeof errorObj.message === 'string' ? errorObj.message : safeStringify(errorObj.message ?? errorObj);
      return { type: 'error', error: { ...errorObj, message } };
    }

    if (record.message && typeof record.message !== 'string') {
      return { type: 'error', error: { type: 'api_error', message: safeStringify(record.message) } };
    }

    return { type: 'error', error: { type: 'api_error', message: safeStringify(record) } };
  }

  return { type: 'error', error: { type: 'api_error', message: String(payload) } };
}

function resolveEnvKey(env: Env, key: string): string | undefined {
  return (env as Record<string, string | undefined>)[key];
}

function parseUsageFromJson(text: string): Usage | null {
  const parsed = parseJson(text) as { usage?: Usage } | null;
  if (!parsed?.usage) return null;
  return normalizeUsage(parsed.usage);
}

function extractUsageFromMessage(message: Record<string, unknown>): Usage | null {
  const usage = (message as { usage?: Usage }).usage;
  return usage ? normalizeUsage(usage) : null;
}

function logUpstreamError(
  env: Env,
  providerName: string,
  status: number,
  headers: Headers,
  payload: ArrayBuffer
): void {
  const text = new TextDecoder().decode(payload);
  const parsed = parseJson(text) as Record<string, unknown> | null;
  const errorInfo = extractErrorInfo(parsed, text);
  logWarn(env, 'proxy upstream error', {
    provider: providerName,
    status,
    request_id: getRequestId(headers),
    error_type: errorInfo.type,
    error_message: errorInfo.message,
    error_code: errorInfo.code,
  });
}

async function parseAnthropicUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  body: Record<string, unknown>
): Promise<Usage> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  let usage: Usage | null = null;
  let outputText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });

    const events = extractSseEvents(buffer);
    buffer = events.remaining;
    for (const event of events.events) {
      const parsed = parseJson(event.data);
      if (!parsed || typeof parsed !== 'object') continue;

      if (event.event === 'message_start') {
        const messageUsage = (parsed as { message?: { usage?: Usage } }).message?.usage;
        if (messageUsage) usage = normalizeUsage(messageUsage);
      }

      if ((parsed as { usage?: Usage }).usage) {
        usage = normalizeUsage((parsed as { usage?: Usage }).usage);
      }

      if (event.event === 'content_block_delta') {
        const delta = (parsed as { delta?: { text?: string } }).delta;
        if (delta?.text) outputText += delta.text;
      }
    }
  }

  if (buffer.trim()) {
    const trailing = extractSseEvents(buffer + '\n\n');
    for (const event of trailing.events) {
      const parsed = parseJson(event.data);
      if (!parsed || typeof parsed !== 'object') continue;
      if (event.event === 'message_start') {
        const messageUsage = (parsed as { message?: { usage?: Usage } }).message?.usage;
        if (messageUsage) usage = normalizeUsage(messageUsage);
      }
      if ((parsed as { usage?: Usage }).usage) {
        usage = normalizeUsage((parsed as { usage?: Usage }).usage);
      }
      if (event.event === 'content_block_delta') {
        const delta = (parsed as { delta?: { text?: string } }).delta;
        if (delta?.text) outputText += delta.text;
      }
    }
  }

  if (!usage) {
    const inputTokens = estimateTokensFromText(collectText(body.system) + collectMessageText(body.messages));
    const outputTokens = estimateTokensFromText(outputText);
    return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
  }

  return usage;
}

function streamAnthropicEvents(
  stream: AsyncIterable<Record<string, unknown>>,
  body: Record<string, unknown>,
  responseModel?: string
): { readable: ReadableStream<Uint8Array>; usagePromise: Promise<Usage> } {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let usage: Usage | null = null;
  let outputText = '';

  const usagePromise = (async () => {
    try {
      for await (const event of stream) {
        const eventType = (event as { type?: string }).type ?? 'message';
        const payload = { ...event } as Record<string, unknown>;

        if (eventType === 'message_start') {
          if (responseModel) {
            const message = (payload as { message?: { model?: string } }).message;
            if (message && typeof message.model === 'string') {
              message.model = responseModel;
            }
          }
          const messageUsage = (payload as { message?: { usage?: Usage } }).message?.usage;
          if (messageUsage) usage = normalizeUsage(messageUsage);
        }

        if ((payload as { usage?: Usage }).usage) {
          usage = normalizeUsage((payload as { usage?: Usage }).usage);
        }

        if (eventType === 'content_block_delta') {
          const delta = (payload as { delta?: { text?: string } }).delta;
          if (delta?.text) outputText += delta.text;
        }

        writer.write(encoder.encode(formatSseEvent(eventType, payload)));
      }

      if (!usage) {
        const inputTokens = estimateTokensFromText(collectText(body.system) + collectMessageText(body.messages));
        const outputTokens = estimateTokensFromText(outputText);
        usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
      }

      return usage;
    } finally {
      await writer.close();
    }
  })();

  usagePromise.then((resolved) => resolved).catch(() => null);

  return { readable, usagePromise };
}

function formatSseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
}

type ParsedSse = {
  events: Array<{ event: string; data: string }>;
  remaining: string;
};

function extractSseEvents(buffer: string): ParsedSse {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const chunks = normalized.split('\n\n');
  const events: Array<{ event: string; data: string }> = [];
  const remainder = normalized.endsWith('\n\n') ? '' : chunks.pop() || '';

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || 'message';
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join('\n') });
    }
  }

  return { events, remaining: remainder };
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch (error) {
    return null;
  }
}

function logLevel(env: Env): number {
  const value = env.PROXY_LOG_LEVEL?.toLowerCase();
  return LOG_LEVELS[value ?? 'info'] ?? LOG_LEVELS.info;
}

function logDebug(env: Env, message: string, data?: Record<string, unknown>): void {
  if (logLevel(env) > LOG_LEVELS.debug) return;
  console.debug(message, data ?? {});
}

function logInfo(env: Env, message: string, data?: Record<string, unknown>): void {
  if (logLevel(env) > LOG_LEVELS.info) return;
  console.info(message, data ?? {});
}

function logWarn(env: Env, message: string, data?: Record<string, unknown>): void {
  if (logLevel(env) > LOG_LEVELS.warn) return;
  console.warn(message, data ?? {});
}

function logError(env: Env, message: string, data?: Record<string, unknown>): void {
  if (logLevel(env) > LOG_LEVELS.error) return;
  console.error(message, data ?? {});
}

function normalizeUsage(usage: Usage): Usage {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage.total_tokens ?? input + output,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  };
}

function getRequestId(headers: Headers): string | null {
  return (
    headers.get('request-id') ||
    headers.get('x-request-id') ||
    headers.get('x-amzn-requestid') ||
    headers.get('x-amz-request-id') ||
    null
  );
}

type ErrorInfo = {
  type: string | null;
  message: string | null;
  code: string | null;
};

function extractErrorInfo(payload: Record<string, unknown> | null, rawText: string): ErrorInfo {
  if (payload && typeof payload === 'object') {
    const errorObj = (payload as { error?: Record<string, unknown> }).error;
    const type = (errorObj?.type as string | undefined) ?? (payload as { type?: string }).type ?? null;
    const code =
      (errorObj?.code as string | undefined) ??
      (payload as { code?: string }).code ??
      (payload as { errorCode?: string }).errorCode ??
      null;
    const messageCandidate =
      (errorObj?.message as unknown) ??
      (payload as { message?: unknown }).message ??
      (payload as { errorMessage?: unknown }).errorMessage ??
      (payload as { detail?: unknown }).detail ??
      null;
    let message = stringifyMessage(messageCandidate);
    if (!message || message === '[object Object]') {
      message = stringifyMessage(payload);
    }
    return {
      type,
      code,
      message,
    };
  }

  return {
    type: null,
    code: null,
    message: rawText ? truncate(rawText, 500) : null,
  };
}

function stringifyMessage(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return truncate(value, 500);
  if (value instanceof Error) return truncate(value.message || value.name, 500);
  try {
    return truncate(safeStringify(value), 500);
  } catch (error) {
    return truncate(String(value), 500);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  });
}

function estimateUsage(body: Record<string, unknown>, message: Record<string, unknown>): Usage {
  const inputText = collectText(body.system) + collectMessageText(body.messages);
  const outputText = extractTextFromAnthropicMessage(message);
  const inputTokens = estimateTokensFromText(inputText);
  const outputTokens = estimateTokensFromText(outputText);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

function collectMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  let text = '';
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    text += collectText((message as { content?: unknown }).content);
  }
  return text;
}

function collectText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block as { type?: string }).type === 'text') {
      text += (block as { text?: string }).text ?? '';
    }
  }
  return text;
}

function extractTextFromAnthropicMessage(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block as { type?: string }).type === 'text') {
      text += (block as { text?: string }).text ?? '';
    }
  }
  return text;
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

async function recordUsage(
  env: Env,
  usageContext: UsageContext | null,
  usage: Usage,
  provider: string,
  model?: string | null
): Promise<void> {
  if (!usageContext || !env.MAIN_RPC) return;
  try {
    await env.MAIN_RPC.recordProxyUsage(usageContext.orgId, usageContext.userId, usage, {
      provider,
      model: model ?? undefined,
      tokenId: usageContext.tokenId,
    });
  } catch (error) {
    logWarn(env, 'proxy usage write failed', {
      provider,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
