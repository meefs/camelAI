import { createRequestHandler } from "react-router";

// Export Durable Objects so Cloudflare can instantiate them
// Add new DOs here after creating them in workers/
export { ExampleDO } from "./example-do";

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
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;
