/**
 * OpenAI chat/completions ↔ Bedrock Mantle adapter.
 *
 * We translate the virtual binding's OpenAI input shape into pi-ai's normalized
 * `Context`, call Bedrock Mantle's Anthropic-compatible Messages API through
 * pi-ai's standard Anthropic provider, and translate the resulting event stream
 * back into OpenAI chat/completions.
 *
 * Bedrock requests do *not* go through CF AI Gateway — BYOK traffic is billed
 * to the user's AWS account directly, the gateway adds latency without value
 * on that path.
 */

import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  TextContent,
  Tool,
  ToolCall,
  UserMessage,
} from "@earendil-works/pi-ai";

const DEFAULT_REGION = "us-east-1";

export interface PiBedrockCall {
  context: Context;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  maxTokens?: number;
  temperature?: number;
  stream: boolean;
}

interface IncomingMessage {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

/**
 * Translate an OpenAI chat/completions request body into the pieces pi-ai
 * needs: a `Context` (messages + tools + systemPrompt) plus stream/tool_choice/
 * inference-config options. The `name` field on past assistant tool_calls is
 * threaded forward so we can populate `ToolResultMessage.toolName` when the
 * caller's `role:"tool"` reply omits it (OpenAI's spec only requires
 * `tool_call_id`).
 */
export function chatCompletionToPiCall(input: unknown): PiBedrockCall {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Bedrock route expects an object with messages");
  }
  const obj = input as Record<string, unknown>;
  const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];

  let systemPrompt: string | undefined;
  const messages: Message[] = [];
  const toolNamesByCallId = new Map<string, string>();
  const now = Date.now();

  for (const raw of rawMessages) {
    const msg = raw as IncomingMessage;
    const role = typeof msg.role === "string" ? msg.role : "";

    if (role === "system") {
      const text = flattenTextContent(msg.content);
      if (text) {
        systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
      }
      continue;
    }

    if (role === "user") {
      const content = convertUserContent(msg.content);
      const isEmpty =
        typeof content === "string" ? content.length === 0 : content.length === 0;
      if (isEmpty) continue;
      const userMsg: UserMessage = {
        role: "user",
        content,
        timestamp: now,
      };
      messages.push(userMsg);
      continue;
    }

    if (role === "assistant") {
      const text = flattenTextContent(msg.content);
      const toolCalls: ToolCall[] = [];
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          const tc = openAiToolCallToPi(call);
          if (tc) {
            toolCalls.push(tc);
            toolNamesByCallId.set(tc.id, tc.name);
          }
        }
      }
      if (!text && toolCalls.length === 0) continue;
      const content: AssistantMessage["content"] = [];
      if (text) content.push({ type: "text", text });
      for (const tc of toolCalls) content.push(tc);
      // pi-ai's AssistantMessage carries metadata that the provider doesn't
      // actually need when replaying history; zero/empty values are safe.
      const assistantMsg: AssistantMessage = {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "custom",
        model: "",
        usage: zeroUsage(),
        stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
        timestamp: now,
      };
      messages.push(assistantMsg);
      continue;
    }

    if (role === "tool") {
      const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
      if (!toolCallId) continue;
      const text = flattenTextContent(msg.content);
      const toolName =
        (typeof msg.name === "string" && msg.name) ||
        toolNamesByCallId.get(toolCallId) ||
        "";
      messages.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError: false,
        timestamp: now,
      });
      continue;
    }

    // Unknown role — skip silently. We never see role:"function" from the
    // OpenAI ecosystem any more (deprecated long ago).
  }

  const tools = openAiToolsToPiTools(obj.tools);
  const context: Context = { messages };
  if (systemPrompt) context.systemPrompt = systemPrompt;
  if (tools && tools.length > 0) context.tools = tools;

  return {
    context,
    toolChoice: mapToolChoice(obj.tool_choice),
    maxTokens: numericOrUndefined(obj.max_tokens ?? obj.max_completion_tokens),
    temperature: numericOrUndefined(obj.temperature),
    stream: obj.stream === true,
  };
}

/**
 * Build a Mantle model for pi-ai's Anthropic Messages provider.
 */
export function buildBedrockPiModel(
  modelId: string,
  region: string = DEFAULT_REGION,
): Model<"anthropic-messages"> {
  const mantleModelId = toMantleAnthropicModelId(modelId);
  const metadata = anthropicMantleMetadata(mantleModelId);
  return {
    id: mantleModelId,
    name: metadata.name,
    api: "anthropic-messages",
    provider: "custom",
    baseUrl: `https://bedrock-mantle.${region}.api.aws/anthropic`,
    reasoning: metadata.reasoning,
    thinkingLevelMap: metadata.thinkingLevelMap,
    input: metadata.input,
    cost: metadata.cost,
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
    headers: {
      "anthropic-dangerous-direct-browser-access": "true",
    },
    // Mantle rejects Anthropic's eager tool streaming extension for custom tools.
    compat: {
      ...metadata.compat,
      supportsEagerToolInputStreaming: false,
    },
  };
}

type AnthropicMantleMetadata = Pick<
  Model<"anthropic-messages">,
  "name" | "compat" | "reasoning" | "thinkingLevelMap" | "input" | "cost" | "contextWindow" | "maxTokens"
>;

function toMantleAnthropicModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.includes("fable-5")) return "anthropic.claude-fable-5";
  if (normalized.includes("opus-4-8") || normalized.includes("opus-4.8")) {
    return "anthropic.claude-opus-4-8";
  }
  if (normalized.includes("opus-4-7") || normalized.includes("opus-4.7")) {
    return "anthropic.claude-opus-4-7";
  }
  if (normalized.includes("sonnet-5")) return "anthropic.claude-sonnet-5";
  if (normalized.includes("haiku-4-5") || normalized.includes("haiku-4.5")) {
    return "anthropic.claude-haiku-4-5";
  }
  if (normalized.startsWith("anthropic.")) return normalized;
  if (normalized.startsWith("global.anthropic.")) return normalized.slice("global.".length);
  return `anthropic.${modelId}`;
}

function anthropicMantleMetadata(modelId: string): AnthropicMantleMetadata {
  if (modelId.includes("claude-fable-5")) {
    return {
      name: "Claude Fable 5",
      compat: { forceAdaptiveThinking: true },
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "xhigh" },
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
  }
  if (modelId.includes("claude-opus-4-8") || modelId.includes("claude-opus-4-7")) {
    return {
      name: modelId.includes("4-7") ? "Claude Opus 4.7" : "Claude Opus 4.8",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
  }
  if (modelId.includes("claude-haiku-4-5")) {
    return {
      name: "Claude Haiku 4.5",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
  }
  return {
    name: "Claude Sonnet 5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };
}

/**
 * Run a Bedrock request through pi-ai with a BYOK Bearer token and return the
 * OpenAI chat-completions response — either a JSON object (non-streaming) or
 * an SSE `ReadableStream` (when the caller asked for `stream: true`).
 */
export async function runBedrockViaPi(args: {
  call: PiBedrockCall;
  modelId: string;
  bearerToken: string;
  region?: string;
}): Promise<unknown> {
  const model = buildBedrockPiModel(args.modelId, args.region);
  const eventStream = streamSimple(model, args.call.context, {
    apiKey: args.bearerToken,
    toolChoice: args.call.toolChoice,
    maxTokens: args.call.maxTokens,
    temperature: args.call.temperature,
  });

  if (args.call.stream) {
    return piEventStreamToSSE(eventStream, args.modelId);
  }
  const finalMessage = await eventStream.result();
  return piMessageToChatCompletion(finalMessage, args.modelId);
}

export function piMessageToChatCompletion(
  message: AssistantMessage,
  modelId: string,
): Record<string, unknown> {
  if (message.stopReason === "error") {
    throw new Error(message.errorMessage || "Bedrock request failed");
  }
  if (message.stopReason === "aborted") {
    throw new Error(message.errorMessage || "Bedrock request was aborted");
  }
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content
    .filter((block): block is ToolCall => block.type === "toolCall")
    .map((tc) => piToolCallToOpenAi(tc));
  const assistantMessage: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;

  const usage = piUsageToOpenAi(message.usage);
  return {
    id: message.responseId ?? `bedrock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor((message.timestamp ?? Date.now()) / 1000),
    model: message.responseModel ?? modelId,
    choices: [
      {
        index: 0,
        message: assistantMessage,
        finish_reason: piStopReasonToFinishReason(message.stopReason, toolCalls.length > 0),
      },
    ],
    usage,
  };
}

/**
 * Convert pi-ai's `AssistantMessageEventStream` into an OpenAI
 * chat-completion-chunk SSE stream. Text deltas, tool-call deltas (indexed),
 * and a terminal chunk with `finish_reason` + final `usage` are all forwarded
 * incrementally — this is real streaming, not a synthetic single chunk.
 */
export function piEventStreamToSSE(
  stream: AssistantMessageEventStream,
  modelId: string,
): ReadableStream<Uint8Array> {
  const id = `bedrock-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  // pi-ai's contentIndex covers all block types; OpenAI's tool_calls[].index is
  // a separate counter for tool calls only.
  const toolCallIndexBySlot = new Map<number, number>();
  let nextToolCallIndex = 0;
  let sentRolePrefix = false;
  let lastResponseModel: string | undefined;

  const sse = (payload: unknown) =>
    encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usage?: Record<string, unknown>,
  ) => {
    const chunk: Record<string, unknown> = {
      id,
      object: "chat.completion.chunk",
      created,
      model: lastResponseModel ?? modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) chunk.usage = usage;
    controller.enqueue(sse(chunk));
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === "start") {
            lastResponseModel = event.partial.responseModel ?? lastResponseModel;
            continue;
          }
          if (!sentRolePrefix) {
            emit(controller, { role: "assistant" });
            sentRolePrefix = true;
          }
          switch (event.type) {
            case "text_delta":
              emit(controller, { content: event.delta });
              break;
            case "toolcall_start": {
              const slot = event.contentIndex;
              const index = nextToolCallIndex++;
              toolCallIndexBySlot.set(slot, index);
              const block = event.partial.content[slot] as
                | (ToolCall & { partialJson?: string })
                | undefined;
              emit(controller, {
                tool_calls: [
                  {
                    index,
                    id: block?.id ?? "",
                    type: "function",
                    function: { name: block?.name ?? "", arguments: "" },
                  },
                ],
              });
              break;
            }
            case "toolcall_delta": {
              const index = toolCallIndexBySlot.get(event.contentIndex);
              if (index === undefined || !event.delta) break;
              emit(controller, {
                tool_calls: [
                  { index, function: { arguments: event.delta } },
                ],
              });
              break;
            }
            case "done": {
              const finalMessage = event.message;
              const toolCalls = finalMessage.content.filter(
                (block): block is ToolCall => block.type === "toolCall",
              );
              const finishReason = piStopReasonToFinishReason(
                finalMessage.stopReason,
                toolCalls.length > 0,
              );
              emit(
                controller,
                {},
                finishReason,
                piUsageToOpenAi(finalMessage.usage),
              );
              break;
            }
            case "error":
              throw new Error(
                event.error.errorMessage || "Bedrock stream errored",
              );
            default:
              break;
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Convert an OpenAI user-message `content` into pi-ai user content,
 * preserving image parts. pi-ai's Anthropic provider turns `ImageContent` into
 * Anthropic base64 image blocks downstream, so vision
 * requests survive the round-trip instead of being flattened to text.
 *
 * Only `data:` image URLs are supported (the common case for uploaded/generated
 * images). Remote `http(s)` image URLs are skipped — pi-ai's `ImageContent`
 * only models base64 data, and fetching arbitrary caller-supplied URLs from the
 * platform worker would be an SSRF risk.
 */
function convertUserContent(content: unknown): string | Array<TextContent | ImageContent> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: Array<TextContent | ImageContent> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string" && (p.type === "text" || p.type === undefined)) {
      if (p.text) parts.push({ type: "text", text: p.text });
      continue;
    }
    if (p.type === "image_url") {
      const image = parseImageUrlPart(p.image_url);
      if (image) parts.push(image);
      else {
        console.warn(
          "[bedrock-pi-adapter] dropping non-data image_url (remote URLs unsupported on Bedrock path)",
        );
      }
    }
  }

  // Collapse to a plain string when there's exactly one text part and no images
  // — keeps simple prompts as `content: "..."` rather than a single-element array.
  if (parts.length === 1 && parts[0].type === "text") {
    return (parts[0] as TextContent).text;
  }
  return parts;
}

function parseImageUrlPart(imageUrl: unknown): ImageContent | null {
  let url: string | undefined;
  if (typeof imageUrl === "string") {
    url = imageUrl;
  } else if (imageUrl && typeof imageUrl === "object") {
    const u = (imageUrl as Record<string, unknown>).url;
    if (typeof u === "string") url = u;
  }
  if (!url) return null;

  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) return null; // remote URL — unsupported here
  const mimeType = match[1] || "image/png";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  if (isBase64) {
    return { type: "image", data: payload, mimeType };
  }
  // Non-base64 data URL (rare) — re-encode the (URL-decoded) text as base64.
  try {
    return { type: "image", data: btoa(decodeURIComponent(payload)), mimeType };
  } catch {
    return null;
  }
}

function flattenTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push(p.text);
      continue;
    }
    if (p.type === undefined && typeof p.text === "string") {
      parts.push(p.text);
    }
  }
  return parts.join("");
}

function openAiToolCallToPi(call: unknown): ToolCall | null {
  if (!call || typeof call !== "object") return null;
  const c = call as Record<string, unknown>;
  const id = typeof c.id === "string" ? c.id : "";
  const fn = c.function as Record<string, unknown> | undefined;
  const name = typeof fn?.name === "string" ? fn.name : "";
  if (!id || !name) return null;
  let args: Record<string, unknown> = {};
  const rawArgs = fn?.arguments;
  if (typeof rawArgs === "string" && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Empty args object; better than smuggling a malformed JSON string.
    }
  } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  }
  return { type: "toolCall", id, name, arguments: args };
}

function openAiToolsToPiTools(rawTools: unknown): Tool[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;
  const out: Tool[] = [];
  for (const t of rawTools) {
    if (!t || typeof t !== "object") continue;
    const fn = (t as Record<string, unknown>).function as
      | Record<string, unknown>
      | undefined;
    if (!fn) continue;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    const description = typeof fn.description === "string" ? fn.description : "";
    const parameters =
      fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
        ? (fn.parameters as Record<string, unknown>)
        : { type: "object", properties: {} };
    // pi-ai's Tool.parameters is typed as TSchema (typebox); at runtime a plain
    // JSON Schema works identically — the provider just forwards it.
    out.push({ name, description, parameters: parameters as unknown as Tool["parameters"] });
  }
  return out;
}

function mapToolChoice(value: unknown): PiBedrockCall["toolChoice"] | undefined {
  if (typeof value === "string") {
    if (value === "auto") return "auto";
    if (value === "required") return "any";
    if (value === "none") return "none";
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.type === "function") {
      const fn = v.function as Record<string, unknown> | undefined;
      const name = typeof fn?.name === "string" ? fn.name : "";
      if (name) return { type: "tool", name };
    }
  }
  return undefined;
}

function piToolCallToOpenAi(tc: ToolCall): Record<string, unknown> {
  return {
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments ?? {}),
    },
  };
}

function piStopReasonToFinishReason(
  reason: AssistantMessage["stopReason"],
  hasToolCalls: boolean,
): string {
  switch (reason) {
    case "toolUse":
      return hasToolCalls ? "tool_calls" : "stop";
    case "length":
      return "length";
    default:
      return "stop";
  }
}

function piUsageToOpenAi(usage: AssistantMessage["usage"]): Record<string, unknown> {
  const details: Record<string, number> = {};
  if (usage.cacheRead) details.cached_tokens = usage.cacheRead;
  if (usage.cacheWrite) {
    details.cache_write_tokens = usage.cacheWrite;
    details.cache_creation_input_tokens = usage.cacheWrite;
  }
  return {
    prompt_tokens: usage.input ?? 0,
    completion_tokens: usage.output ?? 0,
    total_tokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
    ...(Object.keys(details).length > 0 ? { prompt_tokens_details: details } : {}),
  };
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function numericOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
