import type {
  AssistantMessage,
  AssistantMessageEventStream,
  ToolCall,
} from "@earendil-works/pi-ai";

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
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content
    .filter((block): block is ToolCall => block.type === "toolCall")
    .map(piToolCallToOpenAi);
  const assistantMessage: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;

  return {
    id: message.responseId ?? `bedrock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor((message.timestamp ?? Date.now()) / 1000),
    model: message.responseModel ?? modelId,
    choices: [{
      index: 0,
      message: assistantMessage,
      finish_reason: piStopReasonToFinishReason(
        message.stopReason,
        toolCalls.length > 0,
      ),
    }],
    usage: piUsageToOpenAi(message.usage),
  };
}

export function piEventStreamToSSE(
  stream: AssistantMessageEventStream,
  modelId: string,
): ReadableStream<Uint8Array> {
  const id = `bedrock-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const toolCallIndexBySlot = new Map<number, number>();
  let nextToolCallIndex = 0;
  let sentRolePrefix = false;
  let lastResponseModel: string | undefined;

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
    controller.enqueue(
      encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
    );
  };

  const emitUsageOnly = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: AssistantMessage,
  ) => {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model: message.responseModel ?? lastResponseModel ?? modelId,
      choices: [],
      usage: piUsageToOpenAi(message.usage),
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
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
              const index = nextToolCallIndex++;
              toolCallIndexBySlot.set(event.contentIndex, index);
              const block = event.partial.content[event.contentIndex] as
                | (ToolCall & { partialJson?: string })
                | undefined;
              emit(controller, {
                tool_calls: [{
                  index,
                  id: block?.id ?? "",
                  type: "function",
                  function: { name: block?.name ?? "", arguments: "" },
                }],
              });
              break;
            }
            case "toolcall_delta": {
              const index = toolCallIndexBySlot.get(event.contentIndex);
              if (index !== undefined && event.delta) {
                emit(controller, {
                  tool_calls: [{
                    index,
                    function: { arguments: event.delta },
                  }],
                });
              }
              break;
            }
            case "done": {
              const toolCalls = event.message.content.filter(
                (block): block is ToolCall => block.type === "toolCall",
              );
              emit(
                controller,
                {},
                piStopReasonToFinishReason(
                  event.message.stopReason,
                  toolCalls.length > 0,
                ),
                piUsageToOpenAi(event.message.usage),
              );
              break;
            }
            case "error":
              if (
                (event.error.usage.input ?? 0) > 0 ||
                (event.error.usage.output ?? 0) > 0 ||
                (event.error.usage.cacheRead ?? 0) > 0 ||
                (event.error.usage.cacheWrite ?? 0) > 0
              ) {
                emitUsageOnly(controller, event.error);
              }
              throw new Error(
                event.error.errorMessage || "Bedrock stream errored",
              );
            default:
              break;
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function piToolCallToOpenAi(toolCall: ToolCall): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments ?? {}),
    },
  };
}

function piStopReasonToFinishReason(
  reason: AssistantMessage["stopReason"],
  hasToolCalls: boolean,
): string {
  if (reason === "toolUse") return hasToolCalls ? "tool_calls" : "stop";
  return reason === "length" ? "length" : "stop";
}

function piUsageToOpenAi(
  usage: AssistantMessage["usage"],
): Record<string, unknown> {
  const promptTokens =
    (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const completionTokens = usage.output ?? 0;
  const details: Record<string, number> = {};
  if (usage.cacheRead) details.cached_tokens = usage.cacheRead;
  if (usage.cacheWrite) {
    details.cache_write_tokens = usage.cacheWrite;
    details.cache_creation_input_tokens = usage.cacheWrite;
  }
  return {
    // OpenAI-compatible token details are subsets of prompt_tokens. Pi keeps
    // uncached input/cache-read/cache-write as exclusive counters, so rebuild
    // the inclusive wire total here for round-trip-compatible accounting.
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(Object.keys(details).length > 0
      ? { prompt_tokens_details: details }
      : {}),
  };
}
