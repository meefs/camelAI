const DEFAULT_BEDROCK_REGION = 'us-west-2';

interface Env {
  BEDROCK_REGION?: string;
}

interface AnthropicMessagesRequest {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

const bedrockModelMap: Record<string, string> = {
  'claude-sonnet-4-5-20250929': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-haiku-4-5-20251001': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-opus-4-5-20251101': 'global.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-sonnet-4-6': 'global.anthropic.claude-sonnet-4-6',
  'claude-opus-4-6': 'global.anthropic.claude-opus-4-6-v1',
  'claude-sonnet-4-20250514': 'global.anthropic.claude-sonnet-4-20250514-v1:0',
  'claude-opus-4-20250514': 'global.anthropic.claude-opus-4-20250514-v1:0',
  'claude-3-5-sonnet-20241022': 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-3-5-haiku-20241022': 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'bedrock-provider' });
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
