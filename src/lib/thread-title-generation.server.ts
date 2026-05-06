import OpenAI from "openai";

import {
  sanitizeGeneratedThreadTitle,
  THREAD_TITLE_GENERATION_SYSTEM_PROMPT,
} from "./thread-title";

export const THREAD_TITLE_GENERATION_MODEL = "gpt-5.4-nano";
export const THREAD_TITLE_GENERATION_REASONING_EFFORT = "none";

const THREAD_TITLE_MAX_OUTPUT_TOKENS = 50;

export interface ThreadTitleGenerationEnv {
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
}

export interface ThreadTitleGenerationMetadata {
  orgId?: string;
  workspaceId?: string;
  threadId?: string;
}

interface ThreadTitleGatewayConfig {
  baseURL: string;
  authToken: string;
}

function resolveGatewayAuthToken(env: ThreadTitleGenerationEnv): string | null {
  const explicitToken = env.AI_GATEWAY_AUTH_TOKEN?.trim();
  if (explicitToken) return explicitToken;

  const cfToken = env.CF_GATEWAY_TOKEN?.trim();
  if (cfToken) return cfToken;

  return null;
}

export function resolveThreadTitleGatewayConfig(
  env: ThreadTitleGenerationEnv,
): ThreadTitleGatewayConfig | null {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const gatewayName = env.CF_GATEWAY_NAME?.trim();
  const authToken = resolveGatewayAuthToken(env);

  if (!accountId || !gatewayName || !authToken) {
    return null;
  }

  return {
    baseURL:
      `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}` +
      `/${encodeURIComponent(gatewayName)}/openai`,
    authToken,
  };
}

function buildGatewayMetadataHeader(
  metadata: ThreadTitleGenerationMetadata | undefined,
): string | undefined {
  if (!metadata?.orgId && !metadata?.workspaceId && !metadata?.threadId) {
    return undefined;
  }

  const chiridion: Record<string, string> = {};
  if (metadata.orgId) chiridion.orgId = metadata.orgId;
  if (metadata.workspaceId) chiridion.workspaceId = metadata.workspaceId;
  if (metadata.threadId) chiridion.threadId = metadata.threadId;

  return JSON.stringify({
    uid: [metadata.orgId, metadata.workspaceId, metadata.threadId]
      .filter(Boolean)
      .join(":"),
    chiridion,
  });
}

export async function generateThreadTitleWithOpenAI(
  env: ThreadTitleGenerationEnv,
  message: string,
  metadata?: ThreadTitleGenerationMetadata,
): Promise<string | null> {
  const gateway = resolveThreadTitleGatewayConfig(env);
  if (!gateway) {
    throw new Error("Cloudflare AI Gateway is not configured for thread title generation");
  }

  const metadataHeader = buildGatewayMetadataHeader(metadata);
  const client = new OpenAI({
    apiKey: gateway.authToken,
    baseURL: gateway.baseURL,
    defaultHeaders: metadataHeader
      ? { "cf-aig-metadata": metadataHeader }
      : undefined,
  });

  const response = await client.responses.create({
    model: THREAD_TITLE_GENERATION_MODEL,
    instructions: THREAD_TITLE_GENERATION_SYSTEM_PROMPT,
    input: message,
    reasoning: { effort: THREAD_TITLE_GENERATION_REASONING_EFFORT },
    max_output_tokens: THREAD_TITLE_MAX_OUTPUT_TOKENS,
    store: false,
  });

  return sanitizeGeneratedThreadTitle(response.output_text);
}
