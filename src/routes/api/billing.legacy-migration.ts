import type { Route } from "./+types/billing.legacy-migration";
import { requireAuthContext, requireOrgAdmin } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  getBillableTeamSeatCountForOrg,
  migrateLegacyStripeSubscription,
} from "@/lib/billing.server";
import { getMinimumSeats, isBillingPlan } from "@/lib/billing-plans";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const formData = await request.formData();
  const rawPlan = String(formData.get("plan") || "").trim();
  if (
    !isBillingPlan(rawPlan) ||
    rawPlan === "free" ||
    rawPlan === "enterprise"
  ) {
    return Response.json(
      { error: "Choose Starter, Pro, or Team to migrate." },
      { status: 400 },
    );
  }

  try {
    const orgStub = env.ORG.get(env.ORG.idFromName(authContext.currentOrg.id));
    const latestOrg =
      (await orgStub.getInfo().catch(() => null)) ?? authContext.currentOrg;
    const seatCount =
      rawPlan === "team"
        ? await getBillableTeamSeatCountForOrg(env, authContext.currentOrg.id)
        : getMinimumSeats(rawPlan);
    const org = await migrateLegacyStripeSubscription({
      env,
      org: latestOrg,
      userEmail: authContext.user.email,
      plan: rawPlan,
      seatCount,
    });

    return Response.json({
      success: true,
      org: {
        id: org.id,
        billing_status: org.billing_status,
        billing_plan: org.billing_plan,
        billing_seat_count: org.billing_seat_count,
      },
    });
  } catch (error) {
    console.error("[billing] legacy migration failed", {
      orgId: authContext.currentOrg.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to migrate legacy billing.",
      },
      { status: 400 },
    );
  }
}
