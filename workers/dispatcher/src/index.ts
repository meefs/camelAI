/**
 * Chiridion Dispatch Worker
 *
 * Routes requests to user workers deployed in the Workers for Platforms
 * dispatch namespace. Supports subdomain-based routing.
 *
 * Example: hello-world.chiridion.ai -> routes to worker "hello-world"
 */

interface Env {
  DISPATCHER: {
    get(
      name: string,
      args?: Record<string, unknown>,
      options?: {
        outbound?: {
          params: OutboundParams;
        };
      }
    ): {
      fetch(request: Request): Promise<Response>;
    };
  };
  // KV namespace for script->org mapping lookup
  SCRIPT_MAPPINGS: KVNamespace;
}

interface OutboundParams {
  scriptName: string;
  orgId: string | null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Check for subdomain-based routing (e.g., hello-world.chiridion.ai)
    // Skip for apex domain and www
    const hostParts = hostname.split('.');
    if (hostParts.length >= 3 || (hostParts.length === 2 && !hostname.includes('workers.dev'))) {
      const subdomain = hostParts[0];

      if (subdomain && subdomain !== 'www' && subdomain !== 'chiridion') {
        try {
          // Look up orgId from script name mapping
          const orgId = await env.SCRIPT_MAPPINGS.get(`script_to_org:${subdomain}`);

          const outboundParams: OutboundParams = {
            scriptName: subdomain,
            orgId,
          };

          if (orgId) {
            console.log(`[dispatcher] ${subdomain} -> org:${orgId}`);
          } else {
            console.log(`[dispatcher] ${subdomain} -> no org mapping found`);
          }

          const userWorker = env.DISPATCHER.get(
            subdomain,
            {},
            {
              outbound: {
                params: outboundParams,
              },
            }
          );
          return await userWorker.fetch(request);
        } catch (e) {
          const error = e as Error;
          if (error.message?.startsWith('Worker not found')) {
            return new Response(`Worker "${subdomain}" not found`, {
              status: 404,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          return new Response(`Error dispatching to worker "${subdomain}": ${error.message}`, {
            status: 500,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
      }
    }

    // Default response for apex domain
    return new Response(
      JSON.stringify(
        {
          message: 'Chiridion Dispatch Worker',
          routes: {
            subdomain: '<worker-name>.chiridion.ai',
          },
          example: 'hello-world.chiridion.ai',
        },
        null,
        2
      ),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};
