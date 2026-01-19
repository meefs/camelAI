/**
 * Mock MCP handler for workers tests
 *
 * The real MCP SDK uses ajv which has CommonJS code incompatible
 * with the Cloudflare Workers test runtime.
 */

import { DurableObject } from 'cloudflare:workers';

export interface McpEnv {
  DO_RPC: unknown;
  MCP_OBJECT: DurableObjectNamespace<ChiridionMcp>;
  API_TOKENS: KVNamespace;
  TOKEN_SIGNING_SECRET: string;
}

/**
 * Mock ChiridionMcp class for tests
 */
export class ChiridionMcp extends DurableObject<McpEnv> {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ error: 'MCP not available in tests' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/**
 * Mock MCP request handler
 */
export async function handleMcpRequest(
  request: Request,
  _env: McpEnv,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // Health check still works
  if (url.pathname === '/mcp/health') {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'MCP not available in tests' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}
