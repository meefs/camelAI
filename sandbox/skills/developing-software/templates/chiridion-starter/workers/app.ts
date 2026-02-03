import { createRequestHandler } from "react-router";
// import { routeAgentRequest } from "agents";

// Export Durable Objects so Cloudflare can instantiate them
// Add new DOs here after creating them in workers/
export { ExampleDO } from "./example-do";
// export { Chat } from "./chat";

/**
 * Augment AppLoadContext to include Cloudflare bindings.
 * Access in loaders/actions via: context.cloudflare.env.BINDING_NAME
 */
declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export default {
  async fetch(request, env, ctx) {
    // Uncomment to enable Agents SDK routing (WebSocket for Chat DO)
    // const agentResponse = await routeAgentRequest(request, env);
    // if (agentResponse) {
    //   return agentResponse;
    // }

    // Handle all requests with React Router SSR
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;
