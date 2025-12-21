/**
 * Chiridion Outbound Worker
 *
 * Intercepts all outgoing fetch() requests from user workers deployed
 * in the Workers for Platforms dispatch namespace. This allows us to:
 *
 * 1. Proxy integration requests (localhost:8080) to Chiridion's
 *    authenticated integration proxy
 * 2. Log/audit all outbound requests from user workers
 * 3. Block requests to disallowed destinations
 *
 * All integrations use port 8080. The integration ID is extracted from
 * the auth header and determines the upstream destination.
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

interface Env {
  // Passed from dispatcher via outbound parameters
  params: OutboundParams;
  // Chiridion app URL for proxying
  CHIRIDION_APP_URL: string;
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

      // Build the proxy URL
      const proxyPath = `/api/orgs/${params.orgId}/integrations/${integrationId}/proxy${url.pathname}${url.search}`;
      const proxyUrl = new URL(proxyPath, env.CHIRIDION_APP_URL);

      // Build headers - forward relevant ones but NOT the original auth
      const headers = new Headers();
      const headersToForward = ['content-type', 'accept', 'user-agent', 'content-length'];
      for (const header of headersToForward) {
        const value = request.headers.get(header);
        if (value) {
          headers.set(header, value);
        }
      }

      // For outbound workers, we authenticate based on the script/org context
      // rather than requiring an API token. The fact that the request came through
      // the dispatch namespace proves it's from a legitimate user worker.
      headers.set('x-chiridion-outbound', 'true');
      headers.set('x-chiridion-script-name', params.scriptName);
      headers.set('x-chiridion-org-id', params.orgId);

      console.log(
        `[outbound] ${request.method} ${url.pathname} -> integration:${integrationId.slice(0, 8)}... (script: ${params.scriptName})`
      );

      // Make the proxied request
      const proxyRequest = new Request(proxyUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      });

      try {
        return await fetch(proxyRequest);
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
