import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolCall,
  UserMessage,
} from "@earendil-works/pi-ai";

import type { PiBedrockCall } from "./bedrock-pi-contracts.js";

interface IncomingMessage {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

export function chatCompletionToPiCall(input: unknown): PiBedrockCall {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Bedrock route expects an object with messages");
  }
  const obj = input as Record<string, unknown>;
  const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];
  const messages: Message[] = [];
  const toolNamesByCallId = new Map<string, string>();
  const now = Date.now();
  let systemPrompt: string | undefined;

  for (const raw of rawMessages) {
    const msg = raw as IncomingMessage;
    const role = typeof msg.role === "string" ? msg.role : "";

    if (role === "system") {
      const text = flattenTextContent(msg.content);
      if (text) systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
      continue;
    }
    if (role === "user") {
      const content = convertUserContent(msg.content);
      if (content.length === 0) continue;
      const userMessage: UserMessage = { role: "user", content, timestamp: now };
      messages.push(userMessage);
      continue;
    }
    if (role === "assistant") {
      const assistant = convertAssistantMessage(msg, toolNamesByCallId, now);
      if (assistant) messages.push(assistant);
      continue;
    }
    if (role === "tool") {
      const toolCallId =
        typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
      if (!toolCallId) continue;
      messages.push({
        role: "toolResult",
        toolCallId,
        toolName:
          (typeof msg.name === "string" && msg.name) ||
          toolNamesByCallId.get(toolCallId) ||
          "",
        content: [{ type: "text", text: flattenTextContent(msg.content) }],
        isError: false,
        timestamp: now,
      });
    }
  }

  const tools = openAiToolsToPiTools(obj.tools);
  const context: PiBedrockCall["context"] = { messages };
  if (systemPrompt) context.systemPrompt = systemPrompt;
  if (tools?.length) context.tools = tools;
  return {
    context,
    toolChoice: mapToolChoice(obj.tool_choice),
    maxTokens: numericOrUndefined(obj.max_tokens ?? obj.max_completion_tokens),
    temperature: numericOrUndefined(obj.temperature),
    stream: obj.stream === true,
  };
}

function convertAssistantMessage(
  msg: IncomingMessage,
  toolNamesByCallId: Map<string, string>,
  timestamp: number,
): AssistantMessage | null {
  const text = flattenTextContent(msg.content);
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.flatMap((call) => {
        const toolCall = openAiToolCallToPi(call);
        if (!toolCall) return [];
        toolNamesByCallId.set(toolCall.id, toolCall.name);
        return [toolCall];
      })
    : [];
  if (!text && toolCalls.length === 0) return null;
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...toolCalls,
    ],
    api: "anthropic-messages",
    provider: "custom",
    model: "",
    usage: zeroUsage(),
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp,
  };
}

function convertUserContent(
  content: unknown,
): string | Array<TextContent | ImageContent> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: Array<TextContent | ImageContent> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    if (
      typeof value.text === "string" &&
      (value.type === "text" || value.type === undefined)
    ) {
      if (value.text) parts.push({ type: "text", text: value.text });
      continue;
    }
    if (value.type !== "image_url") continue;
    const image = parseImageUrlPart(value.image_url);
    if (image) {
      parts.push(image);
    } else {
      console.warn(
        "[bedrock-pi-adapter] dropping non-data image_url (remote URLs unsupported on Bedrock path)",
      );
    }
  }
  return parts.length === 1 && parts[0]?.type === "text"
    ? parts[0].text
    : parts;
}

function parseImageUrlPart(imageUrl: unknown): ImageContent | null {
  const url =
    typeof imageUrl === "string"
      ? imageUrl
      : imageUrl && typeof imageUrl === "object"
        ? (imageUrl as Record<string, unknown>).url
        : undefined;
  if (typeof url !== "string" || !url) return null;

  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) return null;
  const mimeType = match[1] || "image/png";
  const payload = match[3] ?? "";
  if (match[2]) return { type: "image", data: payload, mimeType };
  try {
    return {
      type: "image",
      data: btoa(decodeURIComponent(payload)),
      mimeType,
    };
  } catch {
    return null;
  }
}

function flattenTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      return (value.type === "text" || value.type === undefined) &&
        typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("");
}

function openAiToolCallToPi(call: unknown): ToolCall | null {
  if (!call || typeof call !== "object") return null;
  const value = call as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  const fn = value.function as Record<string, unknown> | undefined;
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
      // Malformed historical tool arguments replay as an empty object.
    }
  } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  }
  return { type: "toolCall", id, name, arguments: args };
}

function openAiToolsToPiTools(rawTools: unknown): Tool[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;
  return rawTools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const fn = (tool as Record<string, unknown>).function as
      | Record<string, unknown>
      | undefined;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) return [];
    const parameters =
      fn?.parameters &&
      typeof fn.parameters === "object" &&
      !Array.isArray(fn.parameters)
        ? fn.parameters
        : { type: "object", properties: {} };
    return [{
      name,
      description: typeof fn?.description === "string" ? fn.description : "",
      parameters: parameters as unknown as Tool["parameters"],
    }];
  });
}

function mapToolChoice(value: unknown): PiBedrockCall["toolChoice"] | undefined {
  if (value === "auto") return "auto";
  if (value === "required") return "any";
  if (value === "none") return "none";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const choice = value as Record<string, unknown>;
  const fn = choice.function as Record<string, unknown> | undefined;
  const name = choice.type === "function" && typeof fn?.name === "string"
    ? fn.name
    : "";
  return name ? { type: "tool", name } : undefined;
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
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}
