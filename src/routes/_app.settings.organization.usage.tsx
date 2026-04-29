import { useLoaderData } from "react-router";
import type { Route } from "./+types/_app.settings.organization.usage";
import { requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getOrgBillingOverview } from "@/lib/billing.server";
import {
  billingStatusBadgeVariant,
  billingStatusLabel,
  formatCreditBalance,
  formatCreditsFromUsd,
} from "@/lib/billing";
import { Separator } from "@/components/ui/separator";
import { SettingsHeader } from "@/components/settings/settings-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface WindowSpend {
  label: string;
  window_ms: number;
  limit_usd: number;
  spent_usd: number;
  exceeded: boolean;
}

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

export function meta() {
  return [
    { title: "Usage - Settings - camelAI" },
    { name: "description", content: "View AI usage and spend limits" },
  ];
}

interface LoaderData {
  orgName: string;
  overview: Awaited<ReturnType<typeof getOrgBillingOverview>> | null;
  spend: {
    total_cost_usd: number;
    total_requests: number;
    windows: WindowSpend[];
  } | null;
  log: { entries: UsageLogEntry[] } | null;
}

export async function loader({
  request,
  context,
}: Route.LoaderArgs): Promise<LoaderData> {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const orgId = authContext.currentOrg.id;

  let overview: LoaderData["overview"] = null;
  let spend: LoaderData["spend"] = null;
  let log: LoaderData["log"] = null;

  if (env.SANDBOX_HOST) {
    const [overviewResp, spendResp, logResp] = await Promise.all([
      getOrgBillingOverview(env, authContext.currentOrg).catch(() => null),
      env.SANDBOX_HOST.fetch(
        `http://sandbox/v1/usage/orgs/${encodeURIComponent(orgId)}/spend`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      env.SANDBOX_HOST.fetch(
        `http://sandbox/v1/usage/orgs/${encodeURIComponent(orgId)}/log?limit=20`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    overview = overviewResp as LoaderData["overview"];
    spend = spendResp as LoaderData["spend"];
    log = logResp as LoaderData["log"];
  }

  return { orgName: authContext.currentOrg.name, overview, spend, log };
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export default function OrganizationUsagePage() {
  const { orgName, overview, spend, log } = useLoaderData() as LoaderData;

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Usage"
        description={`Usage and credit consumption for ${orgName}.`}
      />
      <Separator />

      {!overview ? (
        <p className="text-sm text-muted-foreground">
          Usage tracking is not available. The sandbox host may be unreachable.
        </p>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Lifetime Usage</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatCreditBalance(overview.lifetime_spend_cents)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Available Credits</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatCreditBalance(overview.available_credits_cents)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Subscription</CardDescription>
              </CardHeader>
              <CardContent>
                <Badge
                  variant={billingStatusBadgeVariant(overview.billing_status)}
                  className="px-3 py-1 text-base"
                >
                  {billingStatusLabel(overview.billing_status)}
                </Badge>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Chargeable Usage</CardTitle>
              <CardDescription>
                Hosted model usage is deducted from included and purchased
                credits.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <p className="text-sm font-medium">Billable usage</p>
                  <p className="mt-2 text-2xl font-semibold">
                    {formatCreditBalance(overview.chargeable_usage_cents)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {overview.chargeable_request_count.toLocaleString()}{" "}
                    chargeable requests
                  </p>
                </div>
                <div className="rounded-lg border p-4">
                  <p className="text-sm font-medium">Total credits</p>
                  <p className="mt-2 text-2xl font-semibold">
                    {formatCreditBalance(overview.total_credit_limit_cents)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatCreditBalance(
                      overview.billing_credit_grant_total_cents,
                    )}{" "}
                    included,{" "}
                    {formatCreditBalance(
                      overview.billing_credit_purchase_total_cents,
                    )}{" "}
                    purchased.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {spend && spend.windows.length > 0 ? (
            <>
              <Separator />
              <div className="space-y-3">
                <div>
                  <h3 className="text-lg font-medium">Usage Windows</h3>
                  <p className="text-sm text-muted-foreground">
                    Rolling time windows with usage caps.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {spend.windows.map((w) => (
                    <div
                      key={w.label}
                      className={cn(
                        "rounded-lg border p-4",
                        w.exceeded
                          ? "border-destructive/50 bg-destructive/5"
                          : "border-border",
                      )}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-medium">
                          {w.label} window
                        </span>
                        {w.exceeded ? (
                          <Badge variant="destructive">Exceeded</Badge>
                        ) : (
                          <Badge variant="outline">OK</Badge>
                        )}
                      </div>
                      <div className="text-2xl font-semibold">
                        {formatCreditsFromUsd(w.spent_usd, 2)}{" "}
                        <span className="text-sm font-normal text-muted-foreground">
                          / {formatCreditsFromUsd(w.limit_usd, 0)}
                        </span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            w.exceeded ? "bg-destructive" : "bg-primary",
                          )}
                          style={{
                            width: `${Math.min(
                              100,
                              (w.spent_usd / w.limit_usd) * 100,
                            )}%`,
                          }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {((w.spent_usd / w.limit_usd) * 100).toFixed(1)}% used
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {log && log.entries.length > 0 ? (
            <>
              <Separator />
              <div className="space-y-3">
                <div>
                  <h3 className="text-lg font-medium">Recent Requests</h3>
                  <p className="text-sm text-muted-foreground">
                    Last {log.entries.length} AI requests.
                  </p>
                </div>
                <div className="rounded-md border">
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
                            {dateFormatter.format(
                              new Date(entry.created_at_ms),
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
