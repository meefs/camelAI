/**
 * Bedrock Adapter
 *
 * Transforms Anthropic API requests/responses to work with AWS Bedrock via CF AI Gateway.
 * The message format is identical - only transport differs.
 */

// Beta flags not supported by Bedrock (filter these out)
const UNSUPPORTED_BEDROCK_BETAS = new Set([
  'prompt-caching-scope-2026-01-05',
]);

// Map Anthropic model IDs to Bedrock model IDs
const MODEL_MAP: Record<string, string> = {
  // Claude 4.5 models
  'claude-sonnet-4-5-20250929': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-haiku-4-5-20251001': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-opus-4-5-20251101': 'global.anthropic.claude-opus-4-5-20251101-v1:0',
  // Claude 4.6 models
  'claude-opus-4-6': 'global.anthropic.claude-opus-4-6-v1:0',
  // Claude 4 models
  'claude-sonnet-4-20250514': 'global.anthropic.claude-sonnet-4-20250514-v1:0',
  'claude-opus-4-20250514': 'global.anthropic.claude-opus-4-20250514-v1:0',
  // Claude 3.5 models
  'claude-3-5-sonnet-20241022': 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-3-5-haiku-20241022': 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
};

export interface BedrockTransformOptions {
  cfAccountId: string;
  cfGatewayName: string;
  cfGatewayToken: string;
  region?: string;
  /** Headers to forward from client (e.g., anthropic-beta) */
  clientHeaders?: Record<string, string>;
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: unknown[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  system?: string | unknown[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}

export interface TransformResult {
  url: string;
  options: RequestInit;
  isStreaming: boolean;
}

/**
 * Transform an Anthropic API request for Bedrock via CF AI Gateway
 */
export function transformRequestForBedrock(
  body: AnthropicRequestBody,
  options: BedrockTransformOptions
): TransformResult {
  const { cfAccountId, cfGatewayName, cfGatewayToken, region = 'us-west-2', clientHeaders = {} } = options;

  const isStreaming = body.stream === true;

  // Map model ID
  const bedrockModel = MODEL_MAP[body.model] || `global.anthropic.${body.model}-v1:0`;

  // Build Bedrock request body (same as Anthropic, minus model, plus anthropic_version)
  const bedrockBody: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: body.max_tokens,
    messages: body.messages,
  };

  // Convert anthropic-beta header to body array (comma-separated -> array)
  // Filter out betas not supported by Bedrock
  const betaHeader = clientHeaders['anthropic-beta'];
  if (betaHeader) {
    const betas = betaHeader
      .split(',')
      .map((s) => s.trim())
      .filter((b) => !UNSUPPORTED_BEDROCK_BETAS.has(b));
    if (betas.length > 0) {
      bedrockBody.anthropic_beta = betas;
    }
  }

  // Copy optional fields
  if (body.tools) bedrockBody.tools = body.tools;
  if (body.tool_choice) bedrockBody.tool_choice = body.tool_choice;
  if (body.system) bedrockBody.system = body.system;
  if (body.temperature !== undefined) bedrockBody.temperature = body.temperature;
  if (body.top_p !== undefined) bedrockBody.top_p = body.top_p;
  if (body.top_k !== undefined) bedrockBody.top_k = body.top_k;
  if (body.stop_sequences) bedrockBody.stop_sequences = body.stop_sequences;

  // Build URL for CF AI Gateway → Bedrock
  const endpoint = isStreaming ? 'invoke-with-response-stream' : 'invoke';
  const url = `https://gateway.ai.cloudflare.com/v1/${cfAccountId}/${cfGatewayName}/aws-bedrock/bedrock-runtime/${region}/model/${bedrockModel}/${endpoint}`;

  return {
    url,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfGatewayToken}`,
      },
      body: JSON.stringify(bedrockBody),
    },
    isStreaming,
  };
}

export interface AnthropicGatewayOptions {
  cfAccountId: string;
  cfGatewayName: string;
  cfGatewayToken: string;
  /** Headers to forward from client (e.g., anthropic-beta, anthropic-version) */
  clientHeaders?: Record<string, string>;
}

/**
 * Build URL and headers for Anthropic via CF AI Gateway (fallback)
 */
export function buildAnthropicGatewayRequest(
  body: string,
  options: AnthropicGatewayOptions
): { url: string; options: RequestInit } {
  const { cfAccountId, cfGatewayName, cfGatewayToken, clientHeaders = {} } = options;

  const url = `https://gateway.ai.cloudflare.com/v1/${cfAccountId}/${cfGatewayName}/anthropic/v1/messages`;

  return {
    url,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfGatewayToken}`,
        'anthropic-version': '2023-06-01',
        ...clientHeaders, // Forward client headers (may override anthropic-version if client specified)
      },
      body,
    },
  };
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/**
 * Decode Base64 to UTF-8 string properly.
 * atob() returns a binary string (each char = 1 byte), not a UTF-8 string.
 * This function properly decodes multi-byte UTF-8 characters.
 */
function base64ToUtf8(base64: string): string {
  const binaryString = atob(base64);
  const bytes = Uint8Array.from(binaryString, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Create a TransformStream that converts Bedrock's AWS event stream to Anthropic SSE.
 * Also extracts usage information and calls onUsage callback when complete.
 *
 * Bedrock streams binary frames with format: {"bytes":"<base64-encoded-json>"}
 * We decode and re-emit as standard SSE: event: <type>\ndata: <json>\n\n
 */
export function createBedrockStreamAdapter(onUsage?: (usage: UsageInfo) => void): TransformStream<Uint8Array, Uint8Array> {
  let buffer = '';
  const usage: UsageInfo = { input_tokens: 0, output_tokens: 0 };

  const processEvent = (event: { type: string; message?: { usage?: UsageInfo }; usage?: Partial<UsageInfo> }) => {
    // Extract usage from message_start (input tokens, cache info)
    if (event.type === 'message_start' && event.message?.usage) {
      const u = event.message.usage;
      usage.input_tokens = u.input_tokens || 0;
      if (u.cache_creation_input_tokens) usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
      if (u.cache_read_input_tokens) usage.cache_read_input_tokens = u.cache_read_input_tokens;
      if (u.cache_creation) usage.cache_creation = u.cache_creation;
    }
    // Extract usage from message_delta (output tokens)
    if (event.type === 'message_delta' && event.usage) {
      usage.output_tokens = event.usage.output_tokens || 0;
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      buffer += text;

      // Match Bedrock's binary frame format
      const regex = /\{"bytes":"([A-Za-z0-9+/=]+)"[^}]*\}/g;
      let match;
      let lastIndex = 0;

      while ((match = regex.exec(buffer)) !== null) {
        try {
          const decoded = base64ToUtf8(match[1]);
          const event = JSON.parse(decoded);
          processEvent(event);

          // Format as SSE and forward
          const sse = `event: ${event.type}\ndata: ${decoded}\n\n`;
          controller.enqueue(new TextEncoder().encode(sse));
        } catch {
          // Skip malformed events
        }
        lastIndex = regex.lastIndex;
      }

      buffer = buffer.slice(lastIndex);
    },

    flush(controller) {
      // Process any remaining buffer
      if (buffer.length > 0) {
        const regex = /\{"bytes":"([A-Za-z0-9+/=]+)"[^}]*\}/g;
        let match;
        while ((match = regex.exec(buffer)) !== null) {
          try {
            const decoded = base64ToUtf8(match[1]);
            const event = JSON.parse(decoded);
            processEvent(event);

            const sse = `event: ${event.type}\ndata: ${decoded}\n\n`;
            controller.enqueue(new TextEncoder().encode(sse));
          } catch {
            // Skip malformed events
          }
        }
      }

      // Report final usage
      if (onUsage) {
        onUsage(usage);
      }
    },
  });
}

/**
 * Create a TransformStream that extracts usage from Anthropic SSE while passing through.
 * Used for the Anthropic fallback path.
 */
export function createAnthropicUsageExtractor(onUsage?: (usage: UsageInfo) => void): TransformStream<Uint8Array, Uint8Array> {
  let buffer = '';
  const usage: UsageInfo = { input_tokens: 0, output_tokens: 0 };

  const processEvent = (event: { type: string; message?: { usage?: UsageInfo }; usage?: Partial<UsageInfo> }) => {
    // Extract usage from message_start (input tokens, cache info)
    if (event.type === 'message_start' && event.message?.usage) {
      const u = event.message.usage;
      usage.input_tokens = u.input_tokens || 0;
      if (u.cache_creation_input_tokens) usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
      if (u.cache_read_input_tokens) usage.cache_read_input_tokens = u.cache_read_input_tokens;
      if (u.cache_creation) usage.cache_creation = u.cache_creation;
    }
    // Extract usage from message_delta (output tokens)
    if (event.type === 'message_delta' && event.usage) {
      usage.output_tokens = event.usage.output_tokens || 0;
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      // Pass through immediately
      controller.enqueue(chunk);

      // Also parse for usage
      const text = new TextDecoder().decode(chunk);
      buffer += text;

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));
            processEvent(event);
          } catch {
            // Skip non-JSON lines
          }
        }
      }
    },

    flush() {
      if (onUsage) {
        onUsage(usage);
      }
    },
  });
}
