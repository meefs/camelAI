/**
 * MCP protocol route
 */

import type { RouteContext } from '../types.js';
import { handleMcpRequest } from '../mcp-handler.js';

export async function handleMcp({ req, env, ctx }: RouteContext): Promise<Response> {
  return handleMcpRequest(req, env, ctx);
}
