import {
  calculateCost,
  createAssistantMessageEventStream,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type Tool,
  type Usage,
} from '@mariozechner/pi-ai';
import type { BedrockOptions } from '@mariozechner/pi-ai';

const DEFAULT_BEDROCK_REGION = 'us-east-1';
const ANTHROPIC_VERSION = 'bedrock-2023-05-31';
const FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14';
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'refusal'
  | 'pause_turn'
  | 'stop_sequence'
  | 'sensitive';

type AnthropicStreamEvent =
  | {
      type: 'message_start';
      message: {
        id?: string;
        usage?: AnthropicUsage;
      };
    }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'text' }
        | { type: 'thinking' }
        | { type: 'redacted_thinking'; data?: string }
        | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'signature_delta'; signature: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason?: AnthropicStopReason | null };
      usage?: AnthropicUsage;
    }
  | { type: 'message_stop' };

type AnthropicUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

type StreamingBlock =
  | (TextContent & { index?: number })
  | (ThinkingContent & { index?: number })
  | (ToolCall & { index?: number; partialJson?: string });

type BedrockInvokeBody = {
  anthropic_version: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  system?: AnthropicTextBlock[];
  temperature?: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
  thinking?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
  anthropic_beta?: string[];
  metadata?: { user_id: string };
};

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
};
type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string | (AnthropicTextBlock | AnthropicImageBlock)[];
  is_error?: boolean;
};
type AnthropicThinkingBlock = {
  type: 'thinking';
  thinking: string;
  signature: string;
};
type AnthropicRedactedThinkingBlock = {
  type: 'redacted_thinking';
  data?: string;
};
type AnthropicTool = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  eager_input_streaming?: boolean;
};

type EventStreamBytes = Uint8Array<ArrayBufferLike>;

export const streamBedrock: StreamFunction<'bedrock-converse-stream', BedrockOptions> = (
  model,
  context,
  options,
) => {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    try {
      if (options?.signal?.aborted) {
        throw new Error('Request was aborted');
      }

      const bearerToken = options?.bearerToken?.trim() || options?.apiKey?.trim();
      if (!bearerToken) {
        throw new Error('Bedrock API key is missing');
      }

      let payload = buildBedrockInvokeBody(model, context, options);
      const nextPayload = await options?.onPayload?.(payload, model);
      if (nextPayload !== undefined) {
        payload = nextPayload as BedrockInvokeBody;
      }

      const response = await fetch(buildBedrockInvokeUrl(model, options), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          accept: 'application/json',
          'content-type': 'application/json',
          ...model.headers,
          ...options?.headers,
        },
        body: JSON.stringify(payload),
        signal: options?.signal,
      });

      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );

      if (!response.ok) {
        throw new Error(await formatBedrockResponseError(response));
      }
      if (!response.body) {
        throw new Error('Bedrock returned an empty streaming response');
      }

      stream.push({ type: 'start', partial: output });
      const blocks = output.content as StreamingBlock[];
      for await (const event of iterateBedrockAnthropicEvents(response.body, options?.signal)) {
        handleAnthropicEvent(event, model, context, output, blocks, stream);
      }

      if (options?.signal?.aborted) {
        throw new Error('Request was aborted');
      }
      if (output.stopReason === 'aborted' || output.stopReason === 'error') {
        throw new Error('An unknown Bedrock streaming error occurred');
      }

      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content as StreamingBlock[]) {
        delete block.index;
        if ('partialJson' in block) delete block.partialJson;
      }
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimpleBedrock: StreamFunction<'bedrock-converse-stream', SimpleStreamOptions> = (
  model,
  context,
  options,
) => {
  const base: BedrockOptions = {
    ...options,
    bearerToken: options?.apiKey,
    maxTokens:
      options?.maxTokens ??
      (model.maxTokens > 0 ? Math.min(model.maxTokens, 32000) : undefined),
  };

  if (options?.reasoning) {
    base.reasoning = options.reasoning;
    base.thinkingBudgets = options.thinkingBudgets;
  }

  return streamBedrock(model, context, base);
};

export const bedrockProviderModule = {
  streamBedrock,
  streamSimpleBedrock,
};

export const __testing = {
  buildBedrockInvokeBody,
  normalizeAnthropicToolResultAdjacency,
};

function buildBedrockInvokeBody(
  model: Model<'bedrock-converse-stream'>,
  context: Context,
  options: BedrockOptions = {},
): BedrockInvokeBody {
  const betaFeatures = buildBetaFeatures(model, context, options);
  const payload: BedrockInvokeBody = {
    anthropic_version: ANTHROPIC_VERSION,
    messages: normalizeAnthropicToolResultAdjacency(convertMessages(context)),
    max_tokens:
      options.maxTokens ??
      (model.maxTokens > 0 ? Math.min(model.maxTokens, 32000) : undefined),
    ...(betaFeatures.length > 0 ? { anthropic_beta: betaFeatures } : {}),
  };

  if (context.systemPrompt?.trim()) {
    payload.system = [{ type: 'text', text: sanitizeSurrogates(context.systemPrompt) }];
  }
  if (options.temperature !== undefined && !options.reasoning) {
    payload.temperature = options.temperature;
  }
  if (context.tools?.length) {
    payload.tools = convertTools(context.tools);
  }
  if (options.toolChoice) {
    payload.tool_choice =
      typeof options.toolChoice === 'string'
        ? { type: options.toolChoice }
        : options.toolChoice;
  }
  if (model.reasoning && options.reasoning) {
    applyThinkingConfig(payload, model, options);
  } else if (model.reasoning) {
    payload.thinking = { type: 'disabled' };
  }
  if (typeof options.metadata?.user_id === 'string') {
    payload.metadata = { user_id: options.metadata.user_id };
  }

  return payload;
}

function buildBedrockInvokeUrl(
  model: Model<'bedrock-converse-stream'>,
  options?: BedrockOptions,
): string {
  const region = options?.region?.trim() || regionFromBaseUrl(model.baseUrl) || DEFAULT_BEDROCK_REGION;
  const modelId = mapToBedrockModelId(model.id);
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke-with-response-stream`;
}

function mapToBedrockModelId(modelId: string): string {
  if (modelId.includes('.anthropic.') || modelId.startsWith('anthropic.')) {
    return modelId;
  }
  const normalized = modelId.toLowerCase();
  if (normalized.includes('sonnet-4-6') || normalized.includes('sonnet-4.6')) {
    return 'global.anthropic.claude-sonnet-4-6';
  }
  if (normalized.includes('opus-4-6') || normalized.includes('opus-4.6')) {
    return 'global.anthropic.claude-opus-4-6-v1';
  }
  return `global.anthropic.${modelId}-v1:0`;
}

function regionFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const host = new URL(baseUrl).host;
    const match = /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function convertMessages(context: Context): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  const sourceMessages = context.messages;

  for (let index = 0; index < sourceMessages.length; index++) {
    const message = sourceMessages[index];
    if (message.role === 'user') {
      const content = convertUserContent(message.content);
      if (content) messages.push({ role: 'user', content });
      continue;
    }

    if (message.role === 'assistant') {
      const blocks = message.content.flatMap(convertAssistantBlock);
      if (blocks.length > 0) {
        messages.push({ role: 'assistant', content: blocks });
      }
      continue;
    }

    const toolResults: AnthropicToolResultBlock[] = [];
    toolResults.push(convertToolResult(message));
    let nextIndex = index + 1;
    while (sourceMessages[nextIndex]?.role === 'toolResult') {
      toolResults.push(convertToolResult(sourceMessages[nextIndex] as typeof message));
      nextIndex++;
    }
    index = nextIndex - 1;
    messages.push({ role: 'user', content: toolResults });
  }

  return messages;
}

function normalizeAnthropicToolResultAdjacency(messages: AnthropicMessage[]): AnthropicMessage[] {
  const normalized: AnthropicMessage[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      normalized.push(sanitizeStandaloneUserToolResults(message));
      continue;
    }

    normalized.push(message);
    const toolUseIds = getAssistantToolUseIds(message);
    if (toolUseIds.length === 0) continue;

    const next = messages[index + 1];
    const consumedResultBlocks: AnthropicToolResultBlock[] = [];
    let leftoverUserBlocks: AnthropicContentBlock[] = [];

    if (next?.role === 'user' && Array.isArray(next.content)) {
      const availableResults = new Map<string, AnthropicToolResultBlock[]>();

      for (const block of next.content) {
        if (block.type !== 'tool_result') {
          leftoverUserBlocks.push(block);
          continue;
        }
        const normalizedId = normalizeToolCallId(block.tool_use_id);
        const blocks = availableResults.get(normalizedId) ?? [];
        blocks.push({ ...block, tool_use_id: normalizedId });
        availableResults.set(normalizedId, blocks);
      }

      for (const id of toolUseIds) {
        const matching = availableResults.get(id);
        const block = matching?.shift();
        consumedResultBlocks.push(block ?? createSyntheticToolResult(id));
      }

      for (const blocks of availableResults.values()) {
        for (const block of blocks) {
          leftoverUserBlocks.push(toolResultBlockToText(block));
        }
      }

      index++;
    } else if (next?.role === 'user' && typeof next.content === 'string') {
      for (const id of toolUseIds) {
        consumedResultBlocks.push(createSyntheticToolResult(id));
      }
      const text = sanitizeSurrogates(next.content);
      if (text.trim()) {
        leftoverUserBlocks = [{ type: 'text', text }];
      }
      index++;
    } else {
      for (const id of toolUseIds) {
        consumedResultBlocks.push(createSyntheticToolResult(id));
      }
    }

    normalized.push({ role: 'user', content: [...consumedResultBlocks, ...leftoverUserBlocks] });
  }

  return normalized;
}

function getAssistantToolUseIds(message: AnthropicMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => {
    if (block.type !== 'tool_use') return [];
    return [normalizeToolCallId(block.id)];
  });
}

function sanitizeStandaloneUserToolResults(message: AnthropicMessage): AnthropicMessage {
  if (message.role !== 'user' || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((block): AnthropicContentBlock => {
    if (block.type !== 'tool_result') return block;
    changed = true;
    return toolResultBlockToText(block);
  });
  return changed ? { ...message, content } : message;
}

function createSyntheticToolResult(toolUseId: string): AnthropicToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: 'Tool call interrupted; no result was recorded.',
    is_error: true,
  };
}

function toolResultBlockToText(block: AnthropicToolResultBlock): AnthropicTextBlock {
  const content = typeof block.content === 'string'
    ? block.content
    : block.content.map((part) => {
        if (part.type === 'text') return part.text;
        return '[image result omitted]';
      }).join('\n');
  return {
    type: 'text',
    text: `[Tool result: ${block.tool_use_id}]\n${content}`.trim(),
  };
}

function convertUserContent(
  content: string | (TextContent | ImageContent)[],
): string | AnthropicContentBlock[] | null {
  if (typeof content === 'string') {
    const text = sanitizeSurrogates(content);
    return text.trim() ? text : null;
  }

  const blocks = content.flatMap((block): AnthropicContentBlock[] => {
    if (block.type === 'text') {
      const text = sanitizeSurrogates(block.text);
      return text.trim() ? [{ type: 'text', text }] : [];
    }
    return [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType,
          data: block.data,
        },
      },
    ];
  });

  return blocks.length > 0 ? blocks : null;
}

function convertAssistantBlock(block: TextContent | ThinkingContent | ToolCall): AnthropicContentBlock[] {
  if (block.type === 'text') {
    const text = sanitizeSurrogates(block.text);
    return text.trim() ? [{ type: 'text', text }] : [];
  }

  if (block.type === 'thinking') {
    if (block.redacted) {
      return [{ type: 'redacted_thinking', data: block.thinkingSignature }];
    }
    const thinking = sanitizeSurrogates(block.thinking);
    if (!thinking.trim()) return [];
    if (!block.thinkingSignature?.trim()) {
      return [{ type: 'text', text: thinking }];
    }
    return [{ type: 'thinking', thinking, signature: block.thinkingSignature }];
  }

  return [
    {
      type: 'tool_use',
      id: normalizeToolCallId(block.id),
      name: block.name,
      input: block.arguments ?? {},
    },
  ];
}

function convertToolResult(message: Extract<Context['messages'][number], { role: 'toolResult' }>): AnthropicToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: normalizeToolCallId(message.toolCallId),
    content: convertToolResultContent(message.content),
    is_error: message.isError,
  };
}

function convertToolResultContent(
  content: (TextContent | ImageContent)[],
): string | (AnthropicTextBlock | AnthropicImageBlock)[] {
  const hasImages = content.some((block) => block.type === 'image');
  if (!hasImages) {
    return sanitizeSurrogates(
      content
        .filter((block): block is TextContent => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    );
  }

  const blocks = content.flatMap((block): (AnthropicTextBlock | AnthropicImageBlock)[] => {
    if (block.type === 'text') {
      const text = sanitizeSurrogates(block.text);
      return text.trim() ? [{ type: 'text', text }] : [];
    }
    return [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType,
          data: block.data,
        },
      },
    ];
  });

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '(see attached image)' }];
}

function convertTools(tools: Tool[]): AnthropicTool[] {
  return tools.map((tool) => {
    const schema = tool.parameters as unknown as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      name: tool.name,
      description: tool.description,
      eager_input_streaming: true,
      input_schema: {
        type: 'object',
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      },
    };
  });
}

function buildBetaFeatures(
  model: Model<'bedrock-converse-stream'>,
  context: Context,
  options: BedrockOptions,
): string[] {
  const betas: string[] = [];
  if (context.tools?.length) {
    betas.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  if (options.interleavedThinking !== false && options.reasoning && !supportsAdaptiveThinking(model.id)) {
    betas.push(INTERLEAVED_THINKING_BETA);
  }
  return betas;
}

function applyThinkingConfig(
  payload: BedrockInvokeBody,
  model: Model<'bedrock-converse-stream'>,
  options: BedrockOptions,
): void {
  const display = options.thinkingDisplay ?? 'summarized';
  if (supportsAdaptiveThinking(model.id)) {
    payload.thinking = { type: 'adaptive', display };
    payload.output_config = { effort: mapReasoningEffort(model, options.reasoning) };
    return;
  }

  payload.thinking = {
    type: 'enabled',
    budget_tokens: getThinkingBudget(options),
    display,
  };
}

function supportsAdaptiveThinking(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return (
    normalized.includes('opus-4-6') ||
    normalized.includes('opus-4.6') ||
    normalized.includes('opus-4-7') ||
    normalized.includes('opus-4.7') ||
    normalized.includes('sonnet-4-6') ||
    normalized.includes('sonnet-4.6')
  );
}

function mapReasoningEffort(
  model: Model<'bedrock-converse-stream'>,
  reasoning: BedrockOptions['reasoning'],
): 'low' | 'medium' | 'high' | 'xhigh' {
  const mapped = reasoning ? model.thinkingLevelMap?.[reasoning] : undefined;
  if (mapped === 'low' || mapped === 'medium' || mapped === 'high' || mapped === 'xhigh') {
    return mapped;
  }
  switch (reasoning) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    default:
      return 'high';
  }
}

function getThinkingBudget(options: BedrockOptions): number {
  const defaults = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  const reasoning = options.reasoning === 'xhigh' ? 'high' : options.reasoning;
  return options.thinkingBudgets?.[reasoning ?? 'medium'] ?? defaults[reasoning ?? 'medium'];
}

function handleAnthropicEvent(
  event: AnthropicStreamEvent,
  model: Model<Api>,
  context: Context,
  output: AssistantMessage,
  blocks: StreamingBlock[],
  stream: AssistantMessageEventStream,
): void {
  if (event.type === 'message_start') {
    output.responseId = event.message.id;
    applyUsage(model, output.usage, event.message.usage);
    return;
  }

  if (event.type === 'content_block_start') {
    if (event.content_block.type === 'text') {
      const block: StreamingBlock = { type: 'text', text: '', index: event.index };
      blocks.push(block);
      stream.push({ type: 'text_start', contentIndex: blocks.length - 1, partial: output });
      return;
    }

    if (event.content_block.type === 'thinking') {
      const block: StreamingBlock = {
        type: 'thinking',
        thinking: '',
        thinkingSignature: '',
        index: event.index,
      };
      blocks.push(block);
      stream.push({ type: 'thinking_start', contentIndex: blocks.length - 1, partial: output });
      return;
    }

    if (event.content_block.type === 'redacted_thinking') {
      const block: StreamingBlock = {
        type: 'thinking',
        thinking: '[Reasoning redacted]',
        thinkingSignature: event.content_block.data,
        redacted: true,
        index: event.index,
      };
      blocks.push(block);
      stream.push({ type: 'thinking_start', contentIndex: blocks.length - 1, partial: output });
      return;
    }

    const block: StreamingBlock = {
      type: 'toolCall',
      id: event.content_block.id,
      name: event.content_block.name,
      arguments: event.content_block.input ?? {},
      partialJson: '',
      index: event.index,
    };
    blocks.push(block);
    stream.push({ type: 'toolcall_start', contentIndex: blocks.length - 1, partial: output });
    return;
  }

  if (event.type === 'content_block_delta') {
    const index = blocks.findIndex((block) => block.index === event.index);
    const block = blocks[index];
    if (!block) return;

    if (event.delta.type === 'text_delta' && block.type === 'text') {
      block.text += event.delta.text;
      stream.push({ type: 'text_delta', contentIndex: index, delta: event.delta.text, partial: output });
      return;
    }

    if (event.delta.type === 'thinking_delta' && block.type === 'thinking') {
      block.thinking += event.delta.thinking;
      stream.push({
        type: 'thinking_delta',
        contentIndex: index,
        delta: event.delta.thinking,
        partial: output,
      });
      return;
    }

    if (event.delta.type === 'input_json_delta' && block.type === 'toolCall') {
      block.partialJson = (block.partialJson ?? '') + event.delta.partial_json;
      block.arguments = parseStreamingJson(block.partialJson);
      stream.push({
        type: 'toolcall_delta',
        contentIndex: index,
        delta: event.delta.partial_json,
        partial: output,
      });
      return;
    }

    if (event.delta.type === 'signature_delta' && block.type === 'thinking') {
      block.thinkingSignature = (block.thinkingSignature ?? '') + event.delta.signature;
    }
    return;
  }

  if (event.type === 'content_block_stop') {
    const index = blocks.findIndex((block) => block.index === event.index);
    const block = blocks[index];
    if (!block) return;

    delete block.index;
    if (block.type === 'text') {
      stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial: output });
      return;
    }
    if (block.type === 'thinking') {
      stream.push({ type: 'thinking_end', contentIndex: index, content: block.thinking, partial: output });
      return;
    }
    block.arguments = parseStreamingJson(block.partialJson);
    delete block.partialJson;
    stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial: output });
    return;
  }

  if (event.type === 'message_delta') {
    if (event.delta.stop_reason) {
      output.stopReason = mapStopReason(event.delta.stop_reason);
      if (output.stopReason !== 'toolUse' && context.tools?.length && blocks.some((block) => block.type === 'toolCall')) {
        output.stopReason = 'toolUse';
      }
    }
    applyUsage(model, output.usage, event.usage);
  }
}

function applyUsage(model: Model<Api>, usage: Usage, eventUsage: AnthropicUsage | undefined): void {
  if (!eventUsage) return;
  if (eventUsage.input_tokens != null) usage.input = eventUsage.input_tokens;
  if (eventUsage.output_tokens != null) usage.output = eventUsage.output_tokens;
  if (eventUsage.cache_read_input_tokens != null) usage.cacheRead = eventUsage.cache_read_input_tokens;
  if (eventUsage.cache_creation_input_tokens != null) usage.cacheWrite = eventUsage.cache_creation_input_tokens;
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  calculateCost(model, usage);
}

function mapStopReason(reason: AnthropicStopReason): AssistantMessage['stopReason'] {
  switch (reason) {
    case 'end_turn':
    case 'pause_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'toolUse';
    case 'refusal':
    case 'sensitive':
      return 'error';
  }
}

async function* iterateBedrockAnthropicEvents(
  body: ReadableStream<EventStreamBytes>,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer: EventStreamBytes = new Uint8Array(0);
  let sawMessageStart = false;
  let sawMessageStop = false;

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Request was aborted');
      }

      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      buffer = concatUint8Arrays(buffer, value);
      while (buffer.length >= 12) {
        const totalLength = readUint32BE(buffer, 0);
        const headersLength = readUint32BE(buffer, 4);
        if (totalLength < 16) {
          throw new Error(`Invalid Bedrock eventstream frame length: ${totalLength}`);
        }
        if (buffer.length < totalLength) break;

        const frame = buffer.slice(0, totalLength);
        buffer = buffer.slice(totalLength);
        const payloadStart = 12 + headersLength;
        const payloadEnd = totalLength - 4;
        if (payloadStart >= payloadEnd) continue;

        const event = decodeBedrockEventPayload(frame.slice(payloadStart, payloadEnd), decoder);
        if (!event) continue;
        if (event.type === 'message_start') sawMessageStart = true;
        if (event.type === 'message_stop') sawMessageStop = true;
        yield event;
      }
    }

    if (sawMessageStart && !sawMessageStop) {
      throw new Error('Bedrock stream ended before message_stop');
    }
  } finally {
    reader.releaseLock();
  }
}

function decodeBedrockEventPayload(
  payload: EventStreamBytes,
  decoder: TextDecoder,
): AnthropicStreamEvent | null {
  const frame = JSON.parse(decoder.decode(payload)) as {
    bytes?: string;
    message?: string;
    Message?: string;
    exceptionType?: string;
    __type?: string;
  };

  if (!frame.bytes) {
    const message = frame.message || frame.Message;
    const type = frame.exceptionType || frame.__type;
    if (message || type) {
      throw new Error(`Bedrock stream error${type ? ` (${type})` : ''}: ${message ?? 'unknown error'}`);
    }
    return null;
  }

  const json = decoder.decode(decodeBase64(frame.bytes));
  return JSON.parse(json) as AnthropicStreamEvent;
}

function decodeBase64(value: string): EventStreamBytes {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function concatUint8Arrays(left: EventStreamBytes, right: EventStreamBytes): EventStreamBytes {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

function readUint32BE(bytes: EventStreamBytes, offset: number): number {
  return (
    (bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!
  ) >>> 0;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

async function formatBedrockResponseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) {
    return `Bedrock request failed with HTTP ${response.status}`;
  }

  try {
    const json = JSON.parse(text) as {
      message?: string;
      Message?: string;
      error?: { message?: string };
      __type?: string;
    };
    const message = json.message || json.Message || json.error?.message || text;
    return `Bedrock request failed with HTTP ${response.status}: ${message}`;
  } catch {
    return `Bedrock request failed with HTTP ${response.status}: ${text}`;
  }
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function sanitizeSurrogates(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}
