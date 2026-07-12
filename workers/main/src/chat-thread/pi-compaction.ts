// Pure Pi context-compaction helpers extracted from chat-thread-do.ts: token
// estimation, cut-index selection, summary chunking/generation, and fallback
// summaries. Each function reads only its arguments; the stateful compaction
// orchestrators (compactPiContext, compactPiContextAfterTurn) stay on
// ChatThreadDO and call into this module.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { stripPiUiMetadata } from "../../../../src/lib/runtime-artifacts";
import { piAgentLoopErrorDetails } from "./pi-message-helpers";

export function piModelContextWindow(model: Model<any> | null | undefined): number {
  return typeof model?.contextWindow === "number" && model.contextWindow > 0
    ? model.contextWindow
    : 128_000;
}

export function piEffectiveMaxOutputTokens(model: Model<any> | null | undefined): number {
  const maxTokens = Math.floor(Number(model?.maxTokens ?? 0));
  return Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.min(maxTokens, 32_000)
    : 0;
}

export function piCompactionReserveTokens(model: Model<any> | null | undefined): number {
  const contextWindow = piModelContextWindow(model);
  const outputReserveTokens = piEffectiveMaxOutputTokens(model);
  return Math.max(16_384, Math.ceil(contextWindow * 0.1), outputReserveTokens);
}

export function estimatePiCompactionTokens(messages: AgentMessage[]): number {
  return Math.ceil(estimatePiContextTokens(messages) * 1.12);
}

export function piAssistantContextTokens(message: AgentMessage): number | null {
  const record = message as unknown as {
    role?: unknown;
    usage?: {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
      totalTokens?: unknown;
    };
  };
  if (record.role !== "assistant") return null;
  const usage = record.usage;
  if (!usage || typeof usage !== "object") return null;
  const totalTokens = Number(usage.totalTokens);
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    return Math.floor(totalTokens);
  }
  const input = Math.max(0, Math.floor(Number(usage.input ?? 0)));
  const output = Math.max(0, Math.floor(Number(usage.output ?? 0)));
  const cacheRead = Math.max(0, Math.floor(Number(usage.cacheRead ?? 0)));
  const cacheWrite = Math.max(0, Math.floor(Number(usage.cacheWrite ?? 0)));
  const total = input + output + cacheRead + cacheWrite;
  return total > 0 ? total : null;
}

export function shouldCompactPiAfterAssistantUsage(
  message: AgentMessage,
  model: Model<any> | null | undefined,
): boolean {
  const contextWindow = piModelContextWindow(model);
  if (isPiContextOverflowMessage(message, contextWindow)) return true;
  const contextTokens = piAssistantContextTokens(message);
  if (contextTokens === null) return false;
  return contextTokens >= contextWindow - piCompactionReserveTokens(model);
}

export function isPiContextOverflowMessage(message: AgentMessage, contextWindow: number): boolean {
  const record = message as unknown as {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    usage?: unknown;
    content?: unknown;
    timestamp?: unknown;
  };
  if (record.role !== "assistant") return false;
  return isContextOverflow(record as Parameters<typeof isContextOverflow>[0], contextWindow);
}

export async function loadPiCompleteSimple(): Promise<typeof import("@earendil-works/pi-ai/compat").completeSimple> {
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  return completeSimple;
}

export function estimatePiContextTokens(messages: AgentMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + estimatePiMessageTokens(message),
    0,
  );
}

export function estimatePiMessageTokens(message: AgentMessage): number {
  const record = message as unknown as { role?: unknown; content?: unknown };
  let text = "";
  if (record.role === "user") {
    text = stringifyPiUserContentForCompaction(record.content);
  } else if (record.role === "assistant") {
    text = stringifyPiAssistantContentForCompaction(record.content);
  } else if (record.role === "toolResult") {
    text = stringifyPiToolResultContentForCompaction(record.content);
  } else {
    try {
      text = JSON.stringify(message);
    } catch {
      text = String(message);
    }
  }
  return Math.ceil(text.length / 4);
}

export function stringifyPiUserContentForCompaction(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown; mimeType?: unknown };
      if (record.type === "text") return typeof record.text === "string" ? record.text : "";
      if (record.type === "image") return `[image:${String(record.mimeType || "unknown")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function stringifyPiAssistantContentForCompaction(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (record.type === "text") return typeof record.text === "string" ? record.text : "";
      if (record.type === "thinking") return typeof record.thinking === "string" ? record.thinking : "";
      if (record.type === "toolCall") {
        return `Tool call: ${String(record.name || "unknown")} ${JSON.stringify(record.arguments ?? {})}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function stringifyPiToolResultContentForCompaction(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown; mimeType?: unknown };
      if (record.type === "text") return typeof record.text === "string" ? record.text : "";
      if (record.type === "image") return `[image:${String(record.mimeType || "unknown")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function findPiCompactionCutIndex(messages: AgentMessage[], keepRecentTokens: number): number {
  let tokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    tokens += estimatePiContextTokens([messages[index] as AgentMessage]);
    if (tokens >= keepRecentTokens) {
      for (let cut = index; cut < messages.length; cut++) {
        const role = (messages[cut] as { role?: unknown }).role;
        if (role === "user" || role === "assistant") {
          return cut;
        }
      }
      return index;
    }
  }
  return 0;
}

export async function summarizePiMessages(
  messages: AgentMessage[],
  model: Model<any>,
  apiKey: string,
  completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
  signal?: AbortSignal,
  previousSummary?: string,
): Promise<string> {
  const summaryMaxTokens = piSummaryMaxTokens(model);
  const inputTokenBudget = piSummaryInputTokenBudget(model, summaryMaxTokens);
  const chunks = chunkPiMessagesForSummary(messages, inputTokenBudget);
  if (chunks.length === 0) {
    throw new Error("Nothing to compact");
  }

  let summary: string | undefined = previousSummary;
  for (const chunk of chunks) {
    summary = await summarizePiMessageChunk(
      chunk,
      model,
      apiKey,
      completeSimple,
      summaryMaxTokens,
      inputTokenBudget,
      signal,
      summary,
    );
  }
  return summary ?? "";
}

export function piSummaryMaxTokens(model: Model<any>): number {
  const contextWindow = piModelContextWindow(model);
  const reserveTokens = piCompactionReserveTokens(model);
  const modelOutputTokens = piEffectiveMaxOutputTokens(model) || reserveTokens;
  return Math.max(
    512,
    Math.min(
      Math.floor(reserveTokens * 0.8),
      modelOutputTokens,
      Math.max(512, Math.floor(contextWindow * 0.25)),
    ),
  );
}

export function piSummaryInputTokenBudget(model: Model<any>, summaryMaxTokens: number): number {
  const contextWindow = piModelContextWindow(model);
  const budget = Math.floor((contextWindow - summaryMaxTokens - 2048) * 0.85);
  return Math.max(2048, budget);
}

export function chunkPiMessagesForSummary(messages: AgentMessage[], inputTokenBudget: number): AgentMessage[][] {
  const chunks: AgentMessage[][] = [];
  let chunk: AgentMessage[] = [];
  let chunkTokens = 0;
  for (const message of messages) {
    const messageTokens = Math.max(1, estimatePiMessageTokens(message));
    if (chunk.length > 0 && chunkTokens + messageTokens > inputTokenBudget) {
      chunks.push(chunk);
      chunk = [];
      chunkTokens = 0;
    }
    chunk.push(message);
    chunkTokens += messageTokens;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export async function summarizePiMessageChunk(
  messages: AgentMessage[],
  model: Model<any>,
  apiKey: string,
  completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
  summaryMaxTokens: number,
  inputTokenBudget: number,
  signal?: AbortSignal,
  previousSummary?: string,
): Promise<string> {
  const serialized = messages
    .map((message) => serializePiMessageForSummary(message))
    .filter(Boolean)
    .join("\n\n");
  const previous = previousSummary
    ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
    : "";
  const maxConversationCharacters = Math.max(
    4000,
    (inputTokenBudget * 4) - previous.length - 2000,
  );
  const boundedSerialized = serialized.length > maxConversationCharacters
    ? `${serialized.slice(0, maxConversationCharacters)}\n\n[...truncated oversized compaction chunk...]`
    : serialized;
  const prompt = `${previous}<conversation>\n${boundedSerialized}\n</conversation>\n\nSummarize this coding-agent conversation for future continuation. Preserve exact file paths, commands, tool results that changed decisions, completed work, current goal, constraints, and next steps. Do not answer the conversation.`;
  const summaryContext = {
    systemPrompt: "You produce compact continuation summaries for coding-agent conversations.",
    messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
  };
  const summaryOptions = {
    apiKey,
    signal,
    maxTokens: summaryMaxTokens,
    ...(model.reasoning ? { reasoning: "high" as const } : {}),
  } as Parameters<typeof completeSimple>[2];
  const response = await completeSimple(
    model,
    summaryContext,
    summaryOptions,
  );
  if ((response as { stopReason?: unknown }).stopReason === "error") {
    const errorMessage = typeof (response as { errorMessage?: unknown }).errorMessage === "string"
      ? (response as { errorMessage: string }).errorMessage
      : "Compaction summary generation failed";
    throw new Error(errorMessage);
  }
  if ((response as { stopReason?: unknown }).stopReason === "aborted") {
    throw new Error("Compaction summary generation was aborted");
  }
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Compaction summary was empty");
  return text;
}

export function serializePiMessageForSummary(message: AgentMessage): string {
  const sanitizedMessage = stripPiUiMetadata(message);
  const role = (sanitizedMessage as { role?: unknown }).role;
  if (role === "user") {
    const content = (sanitizedMessage as { content?: unknown }).content;
    return `[User]\n${typeof content === "string" ? content : JSON.stringify(content)}`;
  }
  if (role === "assistant") {
    return `[Assistant]\n${JSON.stringify((sanitizedMessage as { content?: unknown }).content)}`;
  }
  if (role === "toolResult") {
    const toolName = (sanitizedMessage as { toolName?: unknown }).toolName;
    const content = (sanitizedMessage as { content?: unknown }).content;
    return `[Tool result: ${String(toolName || "unknown")}]\n${JSON.stringify(content).slice(0, 4000)}`;
  }
  return "";
}

export function createFallbackPiCompactionSummary(messages: AgentMessage[], error: unknown): string {
  const details = piAgentLoopErrorDetails(error);
  const roleCounts = messages.reduce<Record<string, number>>((counts, message) => {
    const role = String((message as unknown as Record<string, unknown>).role || "unknown");
    counts[role] = (counts[role] ?? 0) + 1;
    return counts;
  }, {});
  const snippets = messages
    .map((message) => serializePiMessageForSummary(message))
    .filter((line): line is string => Boolean(line && line.trim()))
    .slice(-8)
    .map((line) => line.length > 1000 ? `${line.slice(0, 1000)}\n[...truncated...]` : line)
    .join("\n\n");
  return [
    "Automatic fallback summary created because model-generated compaction failed.",
    `Compaction error: ${details.name}: ${details.message}`,
    `Compacted message count: ${messages.length}`,
    `Role counts: ${JSON.stringify(roleCounts)}`,
    snippets ? `Recent compacted excerpts:\n${snippets}` : "",
  ].filter(Boolean).join("\n\n").slice(0, 80_000);
}

export function createPiSummaryMessage(summary: string, timestamp = Date.now()): AgentMessage {
  return {
    role: "user",
    content: `[Context Summary]\n\n${summary}`,
    timestamp,
  };
}
