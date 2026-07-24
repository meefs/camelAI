import type { DiscordBridgeEnv } from "./types.js";
import { evaluateDiscordBridgeReadiness } from "./bridge-health.js";

const GATEWAY_INSTANCE_NAME = "gateway:v1:0:1";
const CONTROL_INSTANCE_NAME = "control:v1";

export { DiscordGatewayDO } from "./discord-gateway-do.js";
export { DiscordControlDO } from "./discord-control-do.js";

export default {
  async fetch(request: Request, env: DiscordBridgeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/v1/status") {
      const [controlResponse, gatewayHealth] = await Promise.all([
        env.CONTROL.get(env.CONTROL.idFromName(CONTROL_INSTANCE_NAME)).fetch(request),
        env.GATEWAY.get(env.GATEWAY.idFromName(GATEWAY_INSTANCE_NAME)).health(),
      ]);
      const control = await controlResponse.json() as Record<string, unknown>;
      return Response.json({
        ...control,
        gateway: gatewayHealth,
        readiness: evaluateDiscordBridgeReadiness(env, gatewayHealth),
      });
    }
    if (url.pathname.startsWith("/internal/v1/gateway/")) {
      return env.GATEWAY.get(env.GATEWAY.idFromName(GATEWAY_INSTANCE_NAME)).fetch(request);
    }
    if (!url.pathname.startsWith("/internal/v1/")) {
      return new Response("Not Found", { status: 404 });
    }
    return env.CONTROL.get(env.CONTROL.idFromName(CONTROL_INSTANCE_NAME)).fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: DiscordBridgeEnv): Promise<void> {
    await Promise.all([
      env.GATEWAY.get(env.GATEWAY.idFromName(GATEWAY_INSTANCE_NAME)).ensureConnected(),
      env.CONTROL.get(env.CONTROL.idFromName(CONTROL_INSTANCE_NAME)).maintenance(),
    ]);
  },
} satisfies ExportedHandler<DiscordBridgeEnv>;
