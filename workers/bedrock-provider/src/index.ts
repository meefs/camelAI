const DEFAULT_BEDROCK_REGION = 'us-east-1';

interface Env {
  BEDROCK_REGION?: string;
}

interface AnthropicMessagesRequest {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

interface BedrockModelMetadata {
  id: string;
  bedrockModelId: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ('text' | 'image')[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

const bedrockModels: BedrockModelMetadata[] = [
  {
    id: 'claude-fable-5',
    bedrockModelId: 'global.anthropic.claude-fable-5',
    name: 'Claude Fable 5',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh' },
    input: ['text', 'image'],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    bedrockModelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    name: 'Claude Haiku 4.5',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-opus-4-5-20251101',
    bedrockModelId: 'global.anthropic.claude-opus-4-5-20251101-v1:0',
    name: 'Claude Opus 4.5',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-opus-4-20250514',
    bedrockModelId: 'global.anthropic.claude-opus-4-20250514-v1:0',
    name: 'Claude Opus 4',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
  {
    id: 'claude-opus-4-8',
    bedrockModelId: 'global.anthropic.claude-opus-4-8',
    name: 'Claude Opus 4.8',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh' },
    input: ['text', 'image'],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: 'claude-sonnet-4-20250514',
    bedrockModelId: 'global.anthropic.claude-sonnet-4-20250514-v1:0',
    name: 'Claude Sonnet 4',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    bedrockModelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    name: 'Claude Sonnet 4.5',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-sonnet-4-6',
    bedrockModelId: 'global.anthropic.claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    bedrockModelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    name: 'Claude Sonnet 3.5 v2',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: 'claude-3-5-haiku-20241022',
    bedrockModelId: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    name: 'Claude Haiku 3.5',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

const bedrockModelMap: Record<string, string> = {
  ...Object.fromEntries(bedrockModels.map((model) => [model.id, model.bedrockModelId])),
  ...Object.fromEntries(bedrockModels.map((model) => [model.bedrockModelId, model.bedrockModelId])),
  'anthropic/claude-fable-5': 'global.anthropic.claude-fable-5',
  'anthropic.claude-fable-5': 'global.anthropic.claude-fable-5',
  'anthropic/claude-opus-4.8': 'global.anthropic.claude-opus-4-8',
  'anthropic/claude-opus-4-8': 'global.anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-8': 'global.anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4.8': 'global.anthropic.claude-opus-4-8',
  'claude-opus-4-6': 'global.anthropic.claude-opus-4-8',
  'claude-opus-4-7': 'global.anthropic.claude-opus-4-8',
  'anthropic/claude-opus-4.7': 'global.anthropic.claude-opus-4-8',
  'anthropic/claude-opus-4-7': 'global.anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-6': 'global.anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-7': 'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-opus-4-6': 'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-opus-4-7': 'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-opus-4-6-v1:0': 'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-opus-4-7-v1:0': 'global.anthropic.claude-opus-4-8',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'bedrock-provider' });
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({ data: bedrockModels.map(toModelListItem) });
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
      return new Response('Not Found', { status: 404 });
    }

    let body: AnthropicMessagesRequest;
    try {
      body = (await request.json()) as AnthropicMessagesRequest;
    } catch {
      return Response.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
    }

    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      return Response.json({ error: { message: 'Missing model in request body' } }, { status: 400 });
    }

    const region = request.headers.get('x-bedrock-region')?.trim() || env.BEDROCK_REGION?.trim() || DEFAULT_BEDROCK_REGION;
    const authorization = request.headers.get('authorization')?.trim();
    if (!authorization) {
      return Response.json({ error: { message: 'Missing Authorization header' } }, { status: 401 });
    }

    const stream = body.stream === true;
    const endpoint = stream ? 'invoke-with-response-stream' : 'invoke';
    const bedrockBody = toBedrockBody(body, request.headers);
    const upstreamUrl = new URL(
      `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(mapToBedrockModel(model))}/${endpoint}`
    );

    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(bedrockBody),
    });

    if (!stream || !upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: passthroughHeaders(upstream.headers),
      });
    }

    if (!upstream.body) {
      return Response.json({ error: { message: 'Bedrock returned an empty streaming response' } }, { status: 502 });
    }

    return new Response(convertBedrockStreamToSSE(upstream.body), {
      status: upstream.status,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  },
};

function toModelListItem(model: BedrockModelMetadata): Record<string, unknown> {
  return {
    id: model.id,
    object: 'model',
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    context_window: model.contextWindow,
    maxTokens: model.maxTokens,
    max_tokens: model.maxTokens,
    bedrockModelId: model.bedrockModelId,
  };
}

function toBedrockBody(body: AnthropicMessagesRequest, headers: Headers): Record<string, unknown> {
  const bedrockBody: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
  };

  for (const [key, value] of Object.entries(body)) {
    if (key === 'model' || key === 'stream') continue;
    bedrockBody[key] = value;
  }

  const betaHeader = headers.get('anthropic-beta');
  if (betaHeader) {
    const betas = betaHeader
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (betas.length > 0) {
      bedrockBody.anthropic_beta = betas;
    }
  }

  return bedrockBody;
}

function mapToBedrockModel(model: string): string {
  if (bedrockModelMap[model]) {
    return bedrockModelMap[model];
  }

  const normalized = model.toLowerCase();
  if (normalized.includes('fable-5')) {
    return 'global.anthropic.claude-fable-5';
  }
  if (normalized.includes('opus-4-8') || normalized.includes('opus-4.8')) {
    return 'global.anthropic.claude-opus-4-8';
  }
  if (normalized.includes('opus-4-6') || normalized.includes('opus-4.6')) {
    return 'global.anthropic.claude-opus-4-8';
  }
  if (normalized.includes('opus-4-7') || normalized.includes('opus-4.7')) {
    return 'global.anthropic.claude-opus-4-8';
  }
  if (normalized.includes('sonnet-4-6') || normalized.includes('sonnet-4.6')) {
    return 'global.anthropic.claude-sonnet-4-6';
  }

  return `global.anthropic.${model}-v1:0`;
}

function passthroughHeaders(headers: Headers): Headers {
  const next = new Headers();
  const contentType = headers.get('content-type');
  if (contentType) next.set('content-type', contentType);
  const requestId = headers.get('x-amzn-requestid');
  if (requestId) next.set('x-amzn-requestid', requestId);
  return next;
}

function convertBedrockStreamToSSE(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;

          buffer = concatUint8Arrays(buffer, Uint8Array.from(value));

          while (buffer.length >= 12) {
            const totalLength = readUint32BE(buffer, 0);
            const headersLength = readUint32BE(buffer, 4);

            if (totalLength < 16) {
              controller.error(new Error(`Invalid Bedrock eventstream frame length: ${totalLength}`));
              return;
            }

            if (buffer.length < totalLength) break;

            const frame = buffer.slice(0, totalLength);
            buffer = buffer.slice(totalLength);

            const payloadStart = 12 + headersLength;
            const payloadEnd = totalLength - 4;
            if (payloadStart >= payloadEnd) continue;

            const payload = frame.slice(payloadStart, payloadEnd);
            const decodedEvent = decodeBedrockEventPayload(payload, decoder);
            if (!decodedEvent) continue;

            const sse = `event: ${decodedEvent.type}\ndata: ${decodedEvent.json}\n\n`;
            controller.enqueue(encoder.encode(sse));
          }
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function decodeBedrockEventPayload(
  payload: Uint8Array<ArrayBufferLike>,
  decoder: TextDecoder
): { type: string; json: string } | null {
  let frame: { bytes?: string };
  try {
    frame = JSON.parse(decoder.decode(payload)) as { bytes?: string };
  } catch {
    return null;
  }

  if (!frame.bytes) return null;

  let decodedBytes: Uint8Array<ArrayBufferLike>;
  try {
    decodedBytes = Uint8Array.from(atob(frame.bytes), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }

  const json = decoder.decode(decodedBytes);
  let type = 'content_block_delta';
  try {
    const event = JSON.parse(json) as { type?: string };
    if (typeof event.type === 'string' && event.type.trim()) {
      type = event.type;
    }
  } catch {
    // Use the default SSE event name when the payload is not JSON.
  }

  return { type, json };
}

function concatUint8Arrays(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

function readUint32BE(bytes: Uint8Array<ArrayBufferLike>, offset: number): number {
  return (
    (bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!
  ) >>> 0;
}
