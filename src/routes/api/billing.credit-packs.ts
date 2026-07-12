import { redirect } from "react-router";
import type { Route } from "./+types/billing.credit-packs";
import { requireAuthContext, requireOrgAdmin } from "@/lib/auth.server";
import {
  createCreditsCheckoutSession,
  fetchConfiguredCreditPacks,
  getOrgBillingOverview,
  isStripeBillingConfigured,
} from "@/lib/billing.server";
import {
  buildCreditCheckoutReturnUrl,
  canBuyCreditsForBillingState,
  formatTopUpCreditPacks,
} from "@/lib/billing-credit-packs";
import { getEnv } from "@/lib/cloudflare.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const orgId = authContext.currentOrg.id;
  const role = authContext.orgs.find((org) => org.org_id === orgId)?.role;
  const isAdmin = role === "owner" || role === "admin";

  if (!isAdmin) {
    return {
      packs: [],
      canTopUp: false,
      unavailableReason: "Ask an organization admin to top up credits.",
    };
  }

  if (!isStripeBillingConfigured(env)) {
    return {
      packs: [],
      canTopUp: false,
      unavailableReason: "Top-up is not configured yet.",
    };
  }

  const [overview, creditPacks] = await Promise.all([
    getOrgBillingOverview(env, authContext.currentOrg).catch((error) => {
      console.error("[billing] failed to load billing overview for credit packs", error);
      return null;
    }),
    fetchConfiguredCreditPacks(env).catch((error) => {
      console.error("[billing] failed to load configured credit packs", error);
      return [];
    }),
  ]);

  if (!overview) {
    return {
      packs: [],
      canTopUp: false,
      unavailableReason: "Billing state is unavailable. Try again shortly.",
    };
  }

  const canTopUp = canBuyCreditsForBillingState(overview);
  return {
    packs: formatTopUpCreditPacks(creditPacks),
    canTopUp,
    unavailableReason: canTopUp
      ? creditPacks.length > 0
        ? null
        : "Top-up packs are not available."
      : "Choose Pay as you go or an active subscription before buying credits.",
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "buyCredits") {
    return Response.json({ error: "Unknown billing action" }, { status: 400 });
  }

  const priceId = String(formData.get("priceId") || "");
  const returnTo = formData.get("returnTo");
  const successUrl = buildCreditCheckoutReturnUrl(
    request.url,
    returnTo,
    "success",
  );
  const cancelUrl = buildCreditCheckoutReturnUrl(
    request.url,
    returnTo,
    "cancelled",
  );
  const url = await createCreditsCheckoutSession({
    env,
    org: authContext.currentOrg,
    customerEmail: authContext.user.email,
    successUrl,
    cancelUrl,
    priceId,
  });
  throw redirect(url);
}
