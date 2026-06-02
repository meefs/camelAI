import { useEffect, useState } from "react";
import {
  Link,
  redirect,
  useFetcher,
  useLoaderData,
  useSearchParams,
} from "react-router";
import type { Route } from "./+types/_app.settings.organization.usage";
import {
  requireAuthContext,
  requireOrgAdmin,
  getAuthEnv,
} from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  createCreditsCheckoutSession,
  fetchConfiguredCreditPacks,
  getOrgBillingOverview,
  isStripeBillingConfigured,
} from "@/lib/billing.server";
import {
  formatCreditBalance,
  formatCreditsFromUsd,
} from "@/lib/billing";
import {
  canBuyCreditsForBillingState,
  formatTopUpCreditPacks,
} from "@/lib/billing-credit-packs";
import { BYOK_PROVIDERS } from "@/lib/byok-providers";
import { buildPublicLlmProviderConfig } from "@/lib/llm-provider-config";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { SettingsHeader } from "@/components/settings/settings-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TopUpDialog,
  type TopUpDialogPack,
} from "@/components/billing/top-up-dialog";
import type { LlmProvider } from "@/types";

interface UsageLogEntry {
  id: number;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  created_at_ms: number;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const renewalDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

export function meta() {
  return [
    { title: "Usage - Settings - camelAI" },
    {
      name: "description",
      content: "Track camelAI credit consumption.",
    },
  ];
}

function getByokProviderLabel(provider: LlmProvider): string {
  if (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "openrouter" ||
    provider === "bedrock"
  ) {
    return BYOK_PROVIDERS[provider].label;
  }
  return provider;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const orgId = authContext.currentOrg.id;

  const currentUserOrg = authContext.orgs.find((o) => o.org_id === orgId);
  const isOrgAdmin =
    currentUserOrg?.role === "owner" || currentUserOrg?.role === "admin";

  const stripeConfigured = isStripeBillingConfigured(env);

  const [overview, log, creditPacks, llmProviderConfig] = await Promise.all([
    getOrgBillingOverview(env, authContext.currentOrg).catch(() => null),
    (async () => {
      try {
        const authEnv = getAuthEnv(env);
        const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
        return (await orgStub.getUsageLog({ limit: 20 })) as {
          entries: UsageLogEntry[];
        };
      } catch {
        return null;
      }
    })(),
    stripeConfigured
      ? fetchConfiguredCreditPacks(env).catch(() => [])
      : Promise.resolve([]),
    (async () => {
      try {
        const authEnv = getAuthEnv(env);
        const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
        const record = await orgStub.getLlmProviderConfig();
        if (!record) return null;
        return await buildPublicLlmProviderConfig(
          record,
          env.INTEGRATION_SECRET_KEY,
        );
      } catch {
        return null;
      }
    })(),
  ]);

  return {
    orgName: authContext.currentOrg.name,
    overview,
    log,
    stripeConfigured,
    isOrgAdmin,
    creditPacks: formatTopUpCreditPacks(creditPacks),
    llmProviderConfig,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const successUrl = new URL(
    "/settings/organization/usage?checkout=success",
    request.url,
  ).toString();
  const cancelUrl = new URL(
    "/settings/organization/usage?checkout=cancelled",
    request.url,
  ).toString();

  switch (intent) {
    case "buyCredits": {
      const selectedPriceId = String(formData.get("priceId") || "");
      const url = await createCreditsCheckoutSession({
        env,
        org: authContext.currentOrg,
        customerEmail: authContext.user.email,
        successUrl,
        cancelUrl,
        priceId: selectedPriceId,
      });
      throw redirect(url);
    }
    default:
      return { error: "Unknown usage action" };
  }
}

export default function OrganizationUsagePage() {
  const {
    orgName,
    overview,
    log,
    stripeConfigured,
    isOrgAdmin,
    creditPacks,
    llmProviderConfig,
  } = useLoaderData<typeof loader>();

  const topUpFetcher = useFetcher();
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const topUpSubmitting = topUpFetcher.state !== "idle";

  useEffect(() => {
    if (searchParams.get("action") !== "topup") return;
    setTopUpOpen(true);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  if (!overview) {
    return (
      <div className="space-y-6">
        <SettingsHeader
          title="Usage"
          description={`Track camelAI credit consumption for ${orgName}.`}
        />
        <Separator />
        <p className="text-sm text-muted-foreground">
          Usage tracking is not available. The sandbox host may be unreachable.
        </p>
      </div>
    );
  }

  const isEnterprise = overview.billing_status === "enterprise";
  const billingPlan = overview.billing_plan;
  const canTopUpCredits = canBuyCreditsForBillingState(overview);

  const totalLimitCents = overview.total_credit_limit_cents;
  const usageCents = overview.chargeable_usage_cents;
  const availableCents = overview.available_credits_cents;
  const usagePercent =
    totalLimitCents > 0 ? Math.min(100, (usageCents / totalLimitCents) * 100) : 0;

  const renewalLabel = overview.billing_trial_ends_at
    ? renewalDateFormatter.format(new Date(overview.billing_trial_ends_at))
    : null;

  const topUpUnavailable =
    !stripeConfigured || creditPacks.length === 0 || !canTopUpCredits;
  const topUpDisabled = topUpUnavailable || topUpSubmitting;
  const topUpPacks: TopUpDialogPack[] = creditPacks;

  function handleTopUpClick() {
    if (topUpPacks.length === 1) {
      topUpFetcher.submit(
        { intent: "buyCredits", priceId: topUpPacks[0].id },
        { method: "post" },
      );
      return;
    }
    setTopUpOpen(true);
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Usage"
        description={`Track camelAI credit consumption for ${orgName}.`}
      />
      <Separator />

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Credit balance</h2>
        {isEnterprise ? (
          <div className="space-y-1">
            <p className="text-3xl font-semibold">Enterprise</p>
            <p className="text-sm text-muted-foreground">
              Hosted usage and tool calls are billed outside camelAI credits
              for this organization.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-3xl font-semibold">
                {formatCreditBalance(availableCents)}
              </p>
              <p className="text-sm text-muted-foreground">
                {billingPlan === "payg"
                  ? "Available credits"
                  : "Available this billing period"}
              </p>
            </div>
            <Progress value={usagePercent} className="h-2" />
            <p className="text-sm text-muted-foreground">
              {(usageCents / 100).toFixed(2)} used of{" "}
              {formatCreditBalance(totalLimitCents)}.
              {renewalLabel ? ` Resets ${renewalLabel}.` : ""}
            </p>
            <p className="text-sm text-muted-foreground">
              Credits cover hosted LLM calls and built-in tools like web search.
              Bringing your own LLM key only avoids the LLM cost.
            </p>
            {llmProviderConfig ? (
              <p className="text-sm text-muted-foreground">
                Using your{" "}
                {getByokProviderLabel(llmProviderConfig.provider)} key for LLM
                turns. Built-in tools still draw from credits.{" "}
                <Link
                  to="/settings/organization/ai-provider"
                  className="text-primary hover:underline"
                >
                  Manage in AI Provider →
                </Link>
              </p>
            ) : null}
          </div>
        )}
      </section>

      {!isEnterprise && isOrgAdmin ? (
        <>
          <Separator />
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Top up</h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Top up any time. Credits never expire and roll over alongside
                any monthly included balance.
              </p>
              <Button
                type="button"
                onClick={handleTopUpClick}
                disabled={topUpDisabled}
              >
                {topUpSubmitting ? "Opening Stripe…" : "Top up credits"}
              </Button>
            </div>
            {topUpUnavailable ? (
              <p className="text-xs text-muted-foreground">
                {!canTopUpCredits
                  ? "Choose Pay as you go or an active subscription before buying credits."
                  : "Top-up is not configured yet."}
              </p>
            ) : null}
            {topUpPacks.length > 0 ? (
              <TopUpDialog
                open={topUpOpen}
                onOpenChange={setTopUpOpen}
                packs={topUpPacks}
              />
            ) : null}
          </section>
        </>
      ) : null}

      {log && log.entries.length > 0 ? (
        <>
          <Separator />
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Recent requests</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Input</TableHead>
                  <TableHead>Output</TableHead>
                  <TableHead>Credits</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {log.entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-mono text-xs">
                      {entry.model
                        .replace("claude-", "")
                        .replace(/-\d{8}$/, "")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {entry.input_tokens.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {entry.output_tokens.toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {formatCreditsFromUsd(entry.cost_usd)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {dateFormatter.format(new Date(entry.created_at_ms))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </>
      ) : null}
    </div>
  );
}
