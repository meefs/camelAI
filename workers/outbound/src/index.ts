/**
 * Chiridion Outbound Worker
 *
 * Intercepts all outgoing fetch() requests from user workers deployed
 * in the Workers for Platforms dispatch namespace. This allows us to:
 *
 * 1. Log/audit all outbound requests from user workers
 * 2. Block requests to disallowed destinations (future)
 *
 * Note: Integration credentials are passed directly to containers as
 * environment variables, so no proxy logic is needed here.
 */

interface Env {
  // Passed from dispatcher via outbound parameters
  params: OutboundParams;
}

interface OutboundParams {
  scriptName: string;
  orgId: string | null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { params } = env;

    // Log outbound requests for auditing
    if (params?.scriptName) {
      console.log(`[outbound] ${params.scriptName}: ${request.method} ${url.host}${url.pathname}`);
    }

    // Pass through to original destination
    return fetch(request);
  },
};
