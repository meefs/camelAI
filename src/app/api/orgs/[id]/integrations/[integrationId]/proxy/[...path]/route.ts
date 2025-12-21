/**
 * Transparent HTTP Proxy
 *
 * Forwards requests to the target API with stored credentials.
 * Supports all HTTP methods and passes through request/response as-is.
 *
 * Authentication:
 *   Authorization: Bearer tok_xxx
 *
 * Usage:
 *   curl https://app.example.com/api/orgs/{orgId}/integrations/{integrationId}/proxy/v1/customers \
 *     -H "Authorization: Bearer tok_xxx"
 */

import { NextRequest, NextResponse } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  getIntegrationDefinition,
  isProxyable,
  type ProxyConfig,
} from '@/lib/integration-registry';
import { getCloudflareContext } from '@opennextjs/cloudflare';

interface RouteParams {
  params: Promise<{ id: string; integrationId: string; path: string[] }>;
}

interface ProxyEnv {
  DO_RPC: {
    getOrgIntegrationCredentials(
      orgId: string,
      integrationId: string
    ): Promise<Record<string, unknown> | null>;
  };
}

interface ProxyCredentials {
  api_key?: string;
  api_secret?: string;
  access_token?: string;
}

/**
 * Authenticate request via Bearer token
 */
async function authenticateRequest(
  request: NextRequest,
  orgId: string,
  integrationId: string
): Promise<{ authorized: boolean; error?: string }> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { authorized: false, error: 'Missing Authorization header. Use: Bearer <token>' };
  }

  const token = authHeader.substring(7);

  // Validate token from KV
  const tokenData = await authDO.validateApiToken(token, orgId);
  if (!tokenData) {
    return { authorized: false, error: 'Invalid or expired API token' };
  }

  // Check token matches org
  if (tokenData.org_id !== orgId) {
    return { authorized: false, error: 'Token not valid for this organization' };
  }

  // Check token scope includes 'proxy'
  if (!tokenData.scopes.includes('proxy')) {
    return { authorized: false, error: 'Token does not have proxy scope' };
  }

  // Check token is for this integration (or all integrations)
  if (tokenData.integration_id && tokenData.integration_id !== integrationId) {
    return { authorized: false, error: 'Token not valid for this integration' };
  }

  return { authorized: true };
}

/**
 * Handle all HTTP methods
 */
async function handleRequest(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId, integrationId, path } = await params;

    // Authenticate request
    const auth = await authenticateRequest(request, orgId, integrationId);
    if (!auth.authorized) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    // Get integration
    const integration = await authDO.getOrgIntegration(orgId, integrationId);
    if (!integration) {
      return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
    }

    if (!integration.enabled) {
      return NextResponse.json({ error: 'Integration is disabled' }, { status: 400 });
    }

    // Check if proxyable
    if (!isProxyable(integration.integration_type)) {
      return NextResponse.json(
        { error: `Integration type '${integration.integration_type}' does not support HTTP proxy` },
        { status: 400 }
      );
    }

    const definition = getIntegrationDefinition(integration.integration_type);
    if (!definition?.proxyConfig) {
      return NextResponse.json({ error: 'Proxy configuration not found' }, { status: 500 });
    }

    // Get credentials
    const { env } = (await getCloudflareContext()) as unknown as { env: ProxyEnv };
    const credentials = (await env.DO_RPC.getOrgIntegrationCredentials(
      orgId,
      integrationId
    )) as ProxyCredentials | null;

    if (!credentials) {
      return NextResponse.json(
        { error: 'Failed to retrieve integration credentials' },
        { status: 500 }
      );
    }

    // Build target URL
    const targetPath = '/' + path.join('/');
    const baseUrl = getBaseUrl(definition.proxyConfig, integration.config);
    const targetUrl = new URL(targetPath, baseUrl);

    // Copy query parameters
    request.nextUrl.searchParams.forEach((value, key) => {
      targetUrl.searchParams.append(key, value);
    });

    // Handle auth via query param if configured
    if (definition.proxyConfig.authType === 'query' && credentials.api_key) {
      targetUrl.searchParams.append('api_key', credentials.api_key);
    }

    // Build headers
    const headers = new Headers();

    // Copy relevant headers from original request
    const headersToForward = ['content-type', 'accept', 'user-agent'];
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

    // Add auth header
    const authHeader = buildAuthHeader(definition.proxyConfig, credentials);
    if (authHeader) {
      const headerName =
        definition.proxyConfig.authType === 'header' && definition.proxyConfig.authHeader
          ? definition.proxyConfig.authHeader
          : 'Authorization';
      headers.set(headerName, authHeader);
    }

    // Add default headers from proxy config
    if (definition.proxyConfig.defaultHeaders) {
      for (const [key, value] of Object.entries(definition.proxyConfig.defaultHeaders)) {
        headers.set(key, value);
      }
    }

    // Add config-based headers
    if (definition.proxyConfig.configHeaders) {
      for (const [headerName, configField] of Object.entries(definition.proxyConfig.configHeaders)) {
        const value = integration.config[configField];
        if (value !== undefined && value !== null && value !== '') {
          headers.set(headerName, String(value));
        }
      }
    }

    // Build request options
    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
    };

    // Forward body for methods that support it
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      const body = await request.text();
      if (body) {
        fetchOptions.body = body;
      }
    }

    // Make the request
    const response = await fetch(targetUrl.toString(), fetchOptions);

    // Build response headers (filter out problematic ones)
    const responseHeaders = new Headers();
    const headersToSkip = ['content-encoding', 'content-length', 'transfer-encoding'];
    response.headers.forEach((value, key) => {
      if (!headersToSkip.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    // Return the response
    const responseBody = await response.arrayBuffer();
    return new NextResponse(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Proxy request failed' },
      { status: 500 }
    );
  }
}

/**
 * Get base URL, potentially from config (e.g., Salesforce instance_url)
 */
function getBaseUrl(proxyConfig: ProxyConfig, config: Record<string, unknown>): string {
  if (!proxyConfig.baseUrl && config.instance_url) {
    return String(config.instance_url);
  }
  return proxyConfig.baseUrl;
}

/**
 * Build authorization header based on auth type
 */
function buildAuthHeader(proxyConfig: ProxyConfig, credentials: ProxyCredentials): string | null {
  const apiKey = credentials.api_key || credentials.access_token;

  switch (proxyConfig.authType) {
    case 'bearer':
      return apiKey ? `Bearer ${apiKey}` : null;

    case 'basic':
      if (credentials.api_key && credentials.api_secret) {
        const encoded = btoa(`${credentials.api_key}:${credentials.api_secret}`);
        return `Basic ${encoded}`;
      }
      return null;

    case 'header':
      return apiKey || null;

    case 'query':
      return null;

    default:
      return apiKey ? `Bearer ${apiKey}` : null;
  }
}

// Export handlers for all HTTP methods
export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
export const HEAD = handleRequest;
export const OPTIONS = handleRequest;
