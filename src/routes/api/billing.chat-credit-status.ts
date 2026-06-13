import type { Route } from "./+types/billing.chat-credit-status";
import { requireAuthContext } from "@/lib/auth.server";
import { getOrgBillingOverview } from "@/lib/billing.server";
import {
  applyDevBillingCreditStatusOverride,
  buildBillingCreditStatus,
} from "@/lib/chat-credit-status";
import { getEnv } from "@/lib/cloudflare.server";
import { isLlmModel } from "@/lib/llm-provider-config";
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { isSelfhostRuntime } from "@/lib/selfhost-runtime";

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const url = new URL(request.url);
  const rawModel = url.searchParams.get("model");
  const model = isLlmModel(rawModel) ? rawModel : null;
  const orgId = authContext.currentOrg.id;

  if (isSelfhostRuntime(env)) {
    return {
      ok: true,
      billingCreditStatus: null,
    };
  }

  try {
    const overview = await getOrgBillingOverview(env, authContext.currentOrg);
    const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
      env,
      authContext.currentOrgLlmProviderConfig,
    );

    return {
      ok: true,
      billingCreditStatus: applyDevBillingCreditStatusOverride(
        buildBillingCreditStatus(
          overview,
          effectiveLlmProviderConfig?.provider,
          model,
        ),
        url.searchParams,
      ),
    };
  } catch (error) {
    console.error("[billing] failed to refresh chat credit status", {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      error: "Failed to refresh chat credit status",
    };
  }
}
