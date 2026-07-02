// Single utility model for all auxiliary generation (thread titles, chat
// group emoji, completion summaries, help-ticket subjects). Chosen over the
// small llamas and the newer Gemma/GLM/Qwen/gpt-oss models after live
// benchmarking: ~340ms median (as fast as the 3B), perfect instruction
// following on trivial-output tasks, and no hidden thinking mode — the new
// reasoning models spend 2-7s (or their whole token budget) thinking before
// answering, which is the wrong trade for short utility calls.
export const AUXILIARY_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface AuxiliaryAiChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  response?: string | null;
}

export interface AuxiliaryAiBinding {
  run(
    model: string,
    inputs: {
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      max_tokens?: number;
    },
    options?: {
      gateway?: {
        id: string;
        metadata?: Record<string, string | number | boolean | null | bigint>;
      };
      tags?: string[];
    },
  ): Promise<unknown>;
}

export interface AuxiliaryAiMetadata {
  orgId?: string;
  workspaceId?: string;
  threadId?: string;
  groupId?: string;
}

export interface AuxiliaryAiRunContext {
  gatewayName?: string;
}

function buildAuxiliaryAiRunOptions(
  metadata: AuxiliaryAiMetadata | undefined,
  context: AuxiliaryAiRunContext | undefined,
): {
  gateway?: {
    id: string;
    metadata?: Record<string, string | number | boolean | null | bigint>;
  };
  tags?: string[];
} | undefined {
  const gatewayName = context?.gatewayName?.trim();
  const chiridion: Record<string, string> = {};
  if (metadata?.orgId) chiridion.orgId = metadata.orgId;
  if (metadata?.workspaceId) chiridion.workspaceId = metadata.workspaceId;
  if (metadata?.threadId) chiridion.threadId = metadata.threadId;
  if (metadata?.groupId) chiridion.groupId = metadata.groupId;

  const tags = [
    metadata?.orgId ? `org:${metadata.orgId}` : null,
    metadata?.workspaceId ? `workspace:${metadata.workspaceId}` : null,
    metadata?.threadId ? `thread:${metadata.threadId}` : null,
    metadata?.groupId ? `group:${metadata.groupId}` : null,
  ].filter((tag): tag is string => Boolean(tag));

  if (!gatewayName && tags.length === 0) {
    return undefined;
  }

  return {
    ...(gatewayName
      ? {
          gateway: {
            id: gatewayName,
            ...(Object.keys(chiridion).length > 0
              ? {
                  metadata: {
                    uid: [
                      metadata?.orgId,
                      metadata?.workspaceId,
                      metadata?.threadId,
                      metadata?.groupId,
                    ]
                      .filter(Boolean)
                      .join(":"),
                    chiridion: JSON.stringify(chiridion),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export async function runAuxiliaryAiChatCompletion(
  ai: AuxiliaryAiBinding | undefined | null,
  options: {
    systemPrompt: string;
    userMessage: string;
    maxTokens: number;
    metadata?: AuxiliaryAiMetadata;
    context?: AuxiliaryAiRunContext;
  },
): Promise<string | null> {
  if (!ai) {
    throw new Error("Workers AI binding is not configured for auxiliary generation");
  }

  const result = (await ai.run(
    AUXILIARY_AI_MODEL,
    {
      messages: [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: options.userMessage },
      ],
      max_tokens: options.maxTokens,
    },
    buildAuxiliaryAiRunOptions(options.metadata, options.context),
  )) as AuxiliaryAiChatCompletion;

  const content = result.choices?.[0]?.message?.content?.trim() || result.response?.trim();
  return content || null;
}
