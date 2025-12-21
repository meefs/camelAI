/**
 * Chiridion Outbound Worker
 *
 * Intercepts all outgoing fetch() requests from user workers deployed
 * in the Workers for Platforms dispatch namespace. This allows us to:
 *
 * 1. Proxy integration requests (localhost:8080) to upstream APIs
 *    with credentials from Chiridion's integration storage
 * 2. Log/audit all outbound requests from user workers
 * 3. Block requests to disallowed destinations
 *
 * All integrations use port 8080. The integration ID is extracted from
 * the auth header and determines the upstream destination.
 *
 * Authentication: Uses service binding to call DoRpcService directly.
 * No shared secrets needed - service bindings are trusted.
 *
 * Usage in user workers:
 *   // Any SDK - use integration ID as the API key, point to localhost:8080
 *   const stripe = new Stripe('your-stripe-integration-id', {
 *     host: '127.0.0.1',
 *     port: 8080,
 *     protocol: 'http',
 *   });
 *
 *   const openai = new OpenAI({
 *     apiKey: 'your-openai-integration-id',
 *     baseURL: 'http://127.0.0.1:8080/v1',
 *   });
 */

/**
 * Proxy configuration returned by the RPC service
 */
interface IntegrationProxyConfig {
  baseUrl: string;
  authHeader: { name: string; value: string } | null;
  defaultHeaders: Record<string, string>;
  authType: 'bearer' | 'basic' | 'header' | 'query';
}

/**
 * RPC service interface for the service binding
 */
interface DoRpcService {
  getIntegrationProxyConfig(
    orgId: string,
    integrationId: string
  ): Promise<{ config: IntegrationProxyConfig } | { error: string; status: number }>;
}

interface Env {
  // Passed from dispatcher via outbound parameters
  params: OutboundParams;
  // Service binding to Chiridion's RPC service
  CHIRIDION: DoRpcService;
}

interface OutboundParams {
  scriptName: string;
  orgId: string | null;
}

const PROXY_PORT = '8080';

/**
 * Extract integration ID from request headers.
 * Tries multiple formats to support different SDKs.
 */
function extractIntegrationId(request: Request): string | null {
  // Try Authorization: Bearer <id>
  const authHeader = request.headers.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) return bearerMatch[1];

  // Try x-api-key header (Anthropic style)
  const xApiKey = request.headers.get('x-api-key');
  if (xApiKey) return xApiKey;

  // Try explicit x-integration-id header
  const xIntegrationId = request.headers.get('x-integration-id');
  if (xIntegrationId) return xIntegrationId;

  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { params } = env;

    // Check if this is a request to our integration proxy port
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const isProxyPort = url.port === PROXY_PORT;

    if (isLocalhost && isProxyPort) {
      // This is a request to our integration proxy
      const integrationId = extractIntegrationId(request);

      if (!integrationId) {
        return new Response(
          JSON.stringify({
            error: 'Missing integration ID',
            details:
              'Pass the integration ID where you would normally pass the API key (Authorization: Bearer <id> or x-api-key header)',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // We need the orgId to route to the correct integration
      if (!params?.orgId) {
        return new Response(
          JSON.stringify({
            error: 'Organization not configured',
            details:
              'This worker is not associated with an organization. Integration proxy is not available.',
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      console.log(
        `[outbound] ${request.method} ${url.pathname} -> integration:${integrationId.slice(0, 8)}... (script: ${params.scriptName})`
      );

      // Get proxy config via service binding (trusted, no auth needed)
      const result = await env.CHIRIDION.getIntegrationProxyConfig(params.orgId, integrationId);

      if ('error' in result) {
        return new Response(
          JSON.stringify({ error: result.error }),
          {
            status: result.status,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      const { config } = result;

      // Build target URL
      const targetUrl = new URL(url.pathname + url.search, config.baseUrl);

      // Handle auth via query param if configured
      if (config.authType === 'query' && config.authHeader?.name === '_query_api_key') {
        targetUrl.searchParams.append('api_key', config.authHeader.value);
      }

      // Build headers
      const headers = new Headers();

      // Copy relevant headers from original request
      const headersToForward = ['content-type', 'accept', 'user-agent', 'content-length'];
      for (const header of headersToForward) {
        const value = request.headers.get(header);
        if (value) {
          headers.set(header, value);
        }
      }

      // Set default content-type if not present
      if (!headers.has('content-type') && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
        headers.set('content-type', 'application/json');
      }

      // Add auth header (unless it's a query param auth type)
      if (config.authHeader && config.authHeader.name !== '_query_api_key') {
        headers.set(config.authHeader.name, config.authHeader.value);
      }

      // Add default headers from proxy config
      for (const [key, value] of Object.entries(config.defaultHeaders)) {
        headers.set(key, value);
      }

      // Make the proxied request
      try {
        const response = await fetch(targetUrl.toString(), {
          method: request.method,
          headers,
          body: request.body,
        });

        // Build response headers (filter out problematic ones)
        const responseHeaders = new Headers();
        const headersToSkip = ['content-encoding', 'content-length', 'transfer-encoding'];
        response.headers.forEach((value, key) => {
          if (!headersToSkip.includes(key.toLowerCase())) {
            responseHeaders.set(key, value);
          }
        });

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      } catch (e) {
        const error = e as Error;
        console.error('[outbound] Proxy error:', error.message);
        return new Response(
          JSON.stringify({
            error: 'Proxy request failed',
            details: error.message,
          }),
          {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // Not an integration proxy request - pass through to original destination
    if (params?.scriptName) {
      console.log(`[outbound] ${params.scriptName}: ${request.method} ${url.host}${url.pathname}`);
    }

    return fetch(request);
  },
};
