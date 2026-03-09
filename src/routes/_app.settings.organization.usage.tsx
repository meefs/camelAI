import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.usage';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

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
    { title: 'Usage - Settings - camelAI' },
    { name: 'description', content: 'View AI usage and spend limits' },
  ];
}

interface LoaderData {
  orgName: string;
  spend: { total_cost_usd: number; total_requests: number; windows: WindowSpend[] } | null;
  log: { entries: UsageLogEntry[] } | null;
}

export async function loader({ request, context }: Route.LoaderArgs): Promise<LoaderData> {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const orgId = authContext.currentOrg.id;

  let spend: LoaderData['spend'] = null;
  let log: LoaderData['log'] = null;

  if (env.SANDBOX_HOST) {
    const [spendResp, logResp] = await Promise.all([
      env.SANDBOX_HOST
        .fetch(`http://sandbox/v1/usage/orgs/${encodeURIComponent(orgId)}/spend`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      env.SANDBOX_HOST
        .fetch(`http://sandbox/v1/usage/orgs/${encodeURIComponent(orgId)}/log?limit=20`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    spend = spendResp as LoaderData['spend'];
    log = logResp as LoaderData['log'];
  }

  return { orgName: authContext.currentOrg.name, spend, log };
}

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export default function OrganizationUsagePage() {
  const { orgName, spend, log } = useLoaderData() as LoaderData;

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Usage"
        description={`AI usage and spend limits for ${orgName}.`}
      />
      <Separator />

      {!spend ? (
        <p className="text-sm text-muted-foreground">
          Usage tracking is not available. The sandbox host may be unreachable.
        </p>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Spend</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">${spend.total_cost_usd.toFixed(2)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Requests</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{spend.total_requests.toLocaleString()}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Status</CardDescription>
              </CardHeader>
              <CardContent>
                {spend.windows.some((w) => w.exceeded) ? (
                  <Badge variant="destructive" className="text-base px-3 py-1">
                    Limit Exceeded
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-base px-3 py-1">
                    Within Limits
                  </Badge>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Spend Windows</CardTitle>
              <CardDescription>
                Rolling time windows with budget caps
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                {spend.windows.map((w) => (
                  <div
                    key={w.label}
                    className={cn(
                      'rounded-lg border p-4',
                      w.exceeded ? 'border-destructive/50 bg-destructive/5' : 'border-border',
                    )}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">{w.label} window</span>
                      {w.exceeded ? (
                        <Badge variant="destructive">Exceeded</Badge>
                      ) : (
                        <Badge variant="outline">OK</Badge>
                      )}
                    </div>
                    <div className="text-2xl font-semibold">
                      ${w.spent_usd.toFixed(2)}{' '}
                      <span className="text-sm font-normal text-muted-foreground">
                        / ${w.limit_usd.toFixed(0)}
                      </span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          w.exceeded ? 'bg-destructive' : 'bg-primary',
                        )}
                        style={{
                          width: `${Math.min(100, (w.spent_usd / w.limit_usd) * 100)}%`,
                        }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {((w.spent_usd / w.limit_usd) * 100).toFixed(1)}% used
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {log && log.entries.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Recent Requests</CardTitle>
                <CardDescription>Last {log.entries.length} AI requests</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead>Input</TableHead>
                      <TableHead>Output</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {log.entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="font-mono text-xs">
                          {entry.model.replace('claude-', '').replace(/-\d{8}$/, '')}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {entry.input_tokens.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {entry.output_tokens.toLocaleString()}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          ${entry.cost_usd.toFixed(4)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {dateFormatter.format(new Date(entry.created_at_ms))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
