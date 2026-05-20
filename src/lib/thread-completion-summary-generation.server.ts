import OpenAI from "openai";

import { normalizeThreadCompletionSummary } from "./thread-preview";
import {
  resolveThreadTitleGatewayConfig,
  type ThreadTitleGenerationEnv,
  type ThreadTitleGenerationMetadata,
} from "./thread-title-generation.server";

export const THREAD_COMPLETION_SUMMARY_GENERATION_MODEL = "gpt-5.4-nano";
export const THREAD_COMPLETION_SUMMARY_REASONING_EFFORT = "none";
export const THREAD_COMPLETION_SUMMARY_SYSTEM_PROMPT =
  "Summarize the completed coding-agent turn for a compact chat-group hover row. " +
  "Write one short user-facing sentence fragment describing what the agent accomplished or found. " +
  "Avoid transcript detail, tool names, file dumps, logs, raw command output, and implementation chatter. " +
  "No markdown, no bullets, no quotes.";

const THREAD_COMPLETION_SUMMARY_MAX_OUTPUT_TOKENS = 80;
const THREAD_COMPLETION_SUMMARY_SOURCE_MAX_LENGTH = 6_000;

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

function normalizeSummarySource(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, THREAD_COMPLETION_SUMMARY_SOURCE_MAX_LENGTH);
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    return value.map(extractTextFromUnknown).filter(Boolean).join("\n");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.output_text === "string") return record.output_text;
  if (typeof record.result === "string") return record.result;
  if (typeof record.output === "string") return record.output;
  if ("content" in record) return extractTextFromUnknown(record.content);
  return "";
}

function extractMessageContentText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];
  const toolResultParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typed = part as Record<string, unknown>;
    const type = typeof typed.type === "string" ? typed.type : "";
    if (type === "text" || type === "output_text") {
      const text = extractTextFromUnknown(typed);
      if (text) textParts.push(text);
      continue;
    }
    if (type === "tool_result" || type === "tool-result" || type === "toolResult") {
      const text = extractTextFromUnknown(typed.content ?? typed.result ?? typed.output);
      if (text) toolResultParts.push(text);
    }
  }

  return (textParts.length > 0 ? textParts : toolResultParts).join("\n");
}

export function extractThreadCompletionSummarySource(
  messages: unknown[],
  fallbackText?: string | null,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    if (role !== "assistant" && role !== "tool" && role !== "toolResult") continue;
    const text = normalizeSummarySource(extractMessageContentText(message));
    if (text) return text;
  }

  return normalizeSummarySource(fallbackText);
}

export async function generateThreadCompletionSummaryWithOpenAI(
  env: ThreadTitleGenerationEnv,
  sourceText: string,
  metadata?: ThreadTitleGenerationMetadata,
): Promise<string | null> {
  const source = normalizeSummarySource(sourceText);
  if (!source) return null;

  const gateway = resolveThreadTitleGatewayConfig(env);
  if (!gateway) {
    throw new Error("Cloudflare AI Gateway is not configured for thread completion summary generation");
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
    model: THREAD_COMPLETION_SUMMARY_GENERATION_MODEL,
    instructions: THREAD_COMPLETION_SUMMARY_SYSTEM_PROMPT,
    input: source,
    reasoning: { effort: THREAD_COMPLETION_SUMMARY_REASONING_EFFORT },
    max_output_tokens: THREAD_COMPLETION_SUMMARY_MAX_OUTPUT_TOKENS,
    store: false,
  });

  return normalizeThreadCompletionSummary(response.output_text);
}
