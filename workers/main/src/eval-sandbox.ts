import { Sandbox } from "@cloudflare/sandbox";
import type { OutboundHandler } from "@cloudflare/containers";

import { proxyCloudflareApi } from "./cf-api-proxy.js";
import type { DeploySideEffectsInfo } from "./cf-api-proxy.js";
import {
  getEvalDeployContext,
  isRealEvalDeployEnabled,
} from "./eval-deploy-context.js";
import {
  EVAL_CLOUDFLARE_API_BASE_URL,
  EVAL_CLOUDFLARE_API_HOST,
} from "./project-vm-protocol.js";
import { handleDeploySideEffects } from "./services/deploy.js";
import type { Env } from "./types.js";

export { EVAL_CLOUDFLARE_API_BASE_URL, EVAL_CLOUDFLARE_API_HOST };

function cfError(message: string, status: number): Response {
  return Response.json(
    { success: false, errors: [{ code: 10000, message }], messages: [], result: null },
    { status },
  );
}

async function resolveOrgSlug(env: Env, orgId: string): Promise<string | null> {
  try {
    return (await env.ORG.get(env.ORG.idFromName(orgId)).getSlug()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Agent evals run the sandbox container inside Miniflare, so its `wrangler deploy`
 * traffic never reaches a deployed Worker. We intercept the container's Cloudflare API
 * calls here and forward them to the real production cf-api-proxy in-process, so the
 * deploy is genuinely published to the testing-grounds namespace and registered in
 * OrgDO exactly like a production deploy. Identity is supplied via the proxy's
 * `trustedIdentity` option, sourced from the per-container eval deploy context.
 */
const handleEvalCloudflareApi: OutboundHandler<Env> = async (request, env, ctx) => {
  // Honor the real-deploy opt-out: when EVAL_REAL_DEPLOY=0 or no CF_API_TOKEN is set, do
  // not publish for real. There is no mock fallback, so surface a clear error instead of
  // forwarding (which would either publish despite the opt-out or fail with a cryptic
  // Missing CF_API_TOKEN). The deploy eval itself skips in this case.
  if (!isRealEvalDeployEnabled(env)) {
    return cfError(
      "Real eval deploys are disabled (set EVAL_REAL_DEPLOY!=0 and provide CF_API_TOKEN)",
      403,
    );
  }

  const context = await getEvalDeployContext(env.APP_DB, ctx.containerId);
  if (!context) {
    return cfError("Eval deploy context not found for container", 401);
  }
  const orgSlug = await resolveOrgSlug(env, context.orgId);
  if (!orgSlug) {
    return cfError("Eval deploy org has no slug", 401);
  }

  // proxyCloudflareApi normally runs onDeploySideEffects in a waitUntil after returning the
  // deploy response. For evals we instead capture the info (the callback is invoked
  // synchronously) and await the registration before releasing the response, so the script
  // is in OrgDO by the time `bun run deploy` returns — list_apps/set_preview and the final
  // result then never race the deferred registration.
  let pendingDeploy: DeploySideEffectsInfo | null = null;
  const response = await proxyCloudflareApi(request, env, {
    trustedIdentity: {
      orgId: context.orgId,
      orgSlug,
      workspaceId: context.workspaceId,
      userId: context.userId,
      threadId: context.threadId ?? undefined,
      projectId: context.projectId ?? undefined,
    },
    onDeploySideEffects: (info) => {
      pendingDeploy = info;
      return Promise.resolve();
    },
  });

  if (pendingDeploy) {
    // Match the proxy's own catch-and-log: a side-effect failure must not turn a successful
    // deploy response into an error.
    try {
      await handleDeploySideEffects(env, pendingDeploy);
    } catch (error) {
      console.error("[eval-sandbox] deploy side effects failed", String(error));
    }
  }

  return response;
};

export class EvalSandbox extends Sandbox<Env> {}

EvalSandbox.outboundByHost = {
  [EVAL_CLOUDFLARE_API_HOST]: handleEvalCloudflareApi,
};
