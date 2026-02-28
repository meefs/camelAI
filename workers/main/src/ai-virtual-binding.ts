import { WorkerEntrypoint } from 'cloudflare:workers';

interface AIVirtualBindingEnv {
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  AI_VIRTUAL_MODEL?: string;
}

interface AIVirtualBindingProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

const ALLOWED_MODEL_ALIASES = new Set(['auto', 'auto_search', 'auto_image']);

export function mapModelToGateway(alias: string): string {
  const trimmed = alias.trim();
  if (ALLOWED_MODEL_ALIASES.has(trimmed)) {
    return `dynamic/${trimmed}`;
  }
  return 'dynamic/auto';
}

/**
 * Virtual AI binding for user-uploaded workers.
 *
 * User workers can declare a native `ai` binding, and deploy-time rewriting
 * maps it to this entrypoint for tenant-safe routing through the platform worker.
 */
export class AIVirtualBinding extends WorkerEntrypoint<AIVirtualBindingEnv, AIVirtualBindingProps> {
  async run(model: string, input: unknown, _options?: unknown): Promise<unknown> {
    const { model: inputModel, input: sanitizedInput } = extractModelFromInput(input);
    const envDefault = resolveVirtualModel(this.env);

    // Resolve alias: caller param → input body model → env default — first in allowlist wins
    const resolvedAlias = pickAllowedAlias(model, inputModel, envDefault);
    const gatewayModel = mapModelToGateway(resolvedAlias);

    const gatewaySettings = resolveGatewaySettings(this.env);
    if (!gatewaySettings) {
      throw new Error(
        'AI gateway is not configured. Required: CF_ACCOUNT_ID, CF_GATEWAY_NAME, and CF_GATEWAY_TOKEN or AI_GATEWAY_AUTH_TOKEN.'
      );
    }

    return runViaGatewayHTTP(gatewaySettings, this.ctx.props, sanitizedInput, gatewayModel);
  }
}

const DEFAULT_VIRTUAL_MODEL = 'auto';

export function resolveVirtualModel(env: Pick<AIVirtualBindingEnv, 'AI_VIRTUAL_MODEL'>): string {
  const configured = env.AI_VIRTUAL_MODEL?.trim();
  return configured || DEFAULT_VIRTUAL_MODEL;
}

function pickAllowedAlias(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (c && ALLOWED_MODEL_ALIASES.has(c.trim())) {
      return c.trim();
    }
  }
  return DEFAULT_VIRTUAL_MODEL;
}

export function extractModelFromInput(input: unknown): { model: string | undefined; input: unknown } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { model: undefined, input };
  }
  const obj = input as Record<string, unknown>;
  if (!('model' in obj)) {
    return { model: undefined, input };
  }

  const { model, ...rest } = obj;
  return { model: typeof model === 'string' ? model : undefined, input: rest };
}

export interface GatewaySettings {
  accountID: string;
  gatewayID: string;
  authToken: string;
}

function resolveGatewayAuthToken(env: Pick<AIVirtualBindingEnv, 'AI_GATEWAY_AUTH_TOKEN' | 'CF_GATEWAY_TOKEN'>): string | undefined {
  const explicitToken = env.AI_GATEWAY_AUTH_TOKEN?.trim();
  if (explicitToken) return explicitToken;

  const cfToken = env.CF_GATEWAY_TOKEN?.trim();
  if (cfToken) return cfToken;

  return undefined;
}

export function resolveGatewaySettings(
  env: Pick<AIVirtualBindingEnv, 'CF_ACCOUNT_ID' | 'CF_GATEWAY_NAME' | 'AI_GATEWAY_AUTH_TOKEN' | 'CF_GATEWAY_TOKEN'>
): GatewaySettings | undefined {
  const accountID = env.CF_ACCOUNT_ID?.trim();
  const gatewayID = env.CF_GATEWAY_NAME?.trim();
  const authToken = resolveGatewayAuthToken(env);
  if (!accountID || !gatewayID || !authToken) return undefined;

  return {
    accountID,
    gatewayID,
    authToken,
  };
}

function buildGatewayMetadata(props: AIVirtualBindingProps): string {
  const userId = props.userId?.trim();
  const uid = userId
    ? `${props.orgId}:${props.workspaceId}:${userId}`
    : `${props.orgId}:${props.workspaceId}`;
  const chiridion: Record<string, string> = {
    orgId: props.orgId,
    workspaceId: props.workspaceId,
  };
  if (userId) {
    chiridion.userId = userId;
  }
  return JSON.stringify({
    uid,
    chiridion,
  });
}

function buildGatewayURL(accountID: string, gatewayID: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountID)}/${encodeURIComponent(gatewayID)}/compat/chat/completions`;
}

export async function runViaGatewayHTTP(
  settings: GatewaySettings,
  props: AIVirtualBindingProps,
  input: unknown,
  model: string = 'dynamic/auto'
): Promise<unknown> {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${settings.authToken}`);
  headers.set('Content-Type', 'application/json');
  headers.set('cf-aig-metadata', buildGatewayMetadata(props));
  const payload = toGatewayPayload(input, model);

  const resp = await fetch(buildGatewayURL(settings.accountID, settings.gatewayID), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const streamRequested = payload.stream === true;
  if (resp.ok && shouldPassthroughStream(resp, streamRequested)) {
    if (!resp.body) {
      throw new Error('AI Gateway returned an empty streaming response');
    }
    return resp.body;
  }

  const responseText = await resp.text();
  const responsePayload = responseText ? safeJsonParse(responseText) : undefined;
  if (!resp.ok) {
    const message =
      extractGatewayErrorMessage(responsePayload) ??
      (responseText.trim() || undefined) ??
      `AI Gateway request failed (${resp.status})`;
    throw new Error(message);
  }

  if (responsePayload !== undefined) {
    return responsePayload;
  }

  if (responseText.trim()) {
    throw new Error('AI Gateway returned a non-JSON non-streaming response');
  }
  return {};
}

function toGatewayPayload(input: unknown, model: string): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const asObject = input as Record<string, unknown>;
    return { ...asObject, model };
  }
  return { model };
}

function shouldPassthroughStream(resp: Response, streamRequested: boolean): boolean {
  if (!streamRequested) return false;
  const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/event-stream')) return true;
  return !!resp.body;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function extractGatewayErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }

  const error = (payload as { error?: unknown }).error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }

  const errors = (payload as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const message = (first as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
  }

  return undefined;
}
