import { useEffect, useState } from 'react';
import { useFetcher, useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/_app.settings.organization.domains';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { isOrgAdmin } from '@/lib/auth-do';
import { getCustomHostnameDnsTarget } from '@/lib/custom-domain-dns';
import { refreshWorkerScriptCustomDomainStates } from '@/lib/custom-domain.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { AlertCircle, Check, Copy, Info, Loader2, Trash2 } from 'lucide-react';

export function meta() {
  return [
    { title: 'Domains - Settings - camelAI' },
    { name: 'description', content: 'Manage custom domains' },
  ];
}

interface AppDomainStatus {
  name: string;
  hostname: string | null;
  status: string | null;
  ssl_status: string | null;
  error: string | null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv: AuthEnv = {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
  };

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(authContext.currentOrg.id));

  const [admin, scripts] = await Promise.all([
    isOrgAdmin(authEnv, authContext.user.id, authContext.currentOrg.id),
    orgStub.listWorkerScripts(),
  ]);

  const refreshedScripts = await refreshWorkerScriptCustomDomainStates(
    env,
    authContext.currentOrg.id,
    scripts,
    null
  );

  const apps: AppDomainStatus[] = refreshedScripts.map((s) => ({
    name: s.script_name,
    hostname: s.custom_domain_hostname,
    status: s.custom_domain_status,
    ssl_status: s.custom_domain_ssl_status,
    error: s.custom_domain_error,
  }));

  return {
    org: authContext.currentOrg,
    isAdmin: admin,
    dnsTarget: getCustomHostnameDnsTarget({
      cnameTarget: env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
      fallbackOrigin: env.CF_CUSTOM_HOSTNAME_FALLBACK,
    }),
    apps,
  };
}

function StatusBadge({ app }: { app: AppDomainStatus }) {
  if (!app.hostname) {
    return <Badge variant="outline">Not configured</Badge>;
  }
  if (app.status === 'active' && app.ssl_status === 'active') {
    return <Badge variant="default" className="bg-green-600 hover:bg-green-600">Active</Badge>;
  }
  if (app.status === 'failed' || app.ssl_status === 'failed') {
    return <Badge variant="destructive">Needs attention</Badge>;
  }
  return <Badge variant="secondary">Pending SSL</Badge>;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" onClick={handleCopy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {copied ? 'Copied' : 'Copy'}
      </TooltipContent>
    </Tooltip>
  );
}

function DnsRecordLine({
  label,
  name,
  target,
}: {
  label: string;
  name: string;
  target: string;
}) {
  return (
    <div className="space-y-1.5 text-xs">
      <p className="font-medium">{label}</p>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-muted-foreground">Name</span>
          <span className="ml-2 font-mono break-all">{name}</span>
        </div>
        <CopyButton value={name} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-muted-foreground">Target</span>
          <span className="ml-2 font-mono break-all">{target}</span>
        </div>
        <CopyButton value={target} />
      </div>
    </div>
  );
}

function AppDomainRow({
  app,
  orgId,
  dnsTarget,
  isAdmin,
  onSuccess,
}: {
  app: AppDomainStatus;
  orgId: string;
  dnsTarget: string;
  isAdmin: boolean;
  onSuccess: () => void;
}) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [hostname, setHostname] = useState(app.hostname ?? '');
  const [error, setError] = useState<string | null>(null);
  const loading = fetcher.state !== 'idle';

  useEffect(() => {
    setHostname(app.hostname ?? '');
  }, [app.hostname]);

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data.error) {
      setError(fetcher.data.error);
      return;
    }
    setError(null);
    onSuccess();
  }, [fetcher.data, fetcher.state, onSuccess]);

  const submitSet = () => {
    const value = hostname.trim().toLowerCase();
    if (!value) return;
    setError(null);
    fetcher.submit(
      { intent: 'set', scriptName: app.name, hostname: value },
      { method: 'POST', action: `/api/orgs/${orgId}/custom-domain` }
    );
  };

  const submitRemove = () => {
    setError(null);
    fetcher.submit(
      { intent: 'remove', scriptName: app.name },
      { method: 'POST', action: `/api/orgs/${orgId}/custom-domain` }
    );
  };

  return (
    <TableRow>
      <TableCell className="align-top font-medium">{app.name}</TableCell>
      <TableCell className="align-top">
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              placeholder="example.com"
              className="h-9 min-w-56 font-mono text-xs"
              disabled={!isAdmin || loading}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitSet();
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={!isAdmin || loading || !hostname.trim()}
              onClick={submitSet}
            >
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save
            </Button>
            {app.hostname ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!isAdmin || loading}
                onClick={submitRemove}
                aria-label={`Remove custom hostname for ${app.name}`}
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            ) : null}
          </div>
          {error || app.error ? (
            <p className="text-xs text-destructive">{error ?? app.error}</p>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <StatusBadge app={app} />
      </TableCell>
      <TableCell className="align-top">
        {app.hostname ? (
          <div className="space-y-2 rounded-md border p-3">
            <DnsRecordLine label="DNS target" name={app.hostname} target={dnsTarget} />
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Add a hostname to see DNS records.</span>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function DomainsPage() {
  const { org, isAdmin, dnsTarget, apps } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  const handleSuccess = () => {
    if (revalidator.state === 'idle') {
      revalidator.revalidate();
    }
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Domains"
        description="Choose one hostname for each deployed app. camelAI provides the DNS target."
      />
      <Separator />

      <Alert>
        <Info className="size-4" />
        <AlertDescription>
          Wildcard domains are no longer supported. Enter the hostname you want to use, such as example.com or app.example.com, then point it to the generated camelAI target.
        </AlertDescription>
      </Alert>

      {!isAdmin ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>Only organization admins can manage custom domains.</AlertDescription>
        </Alert>
      ) : null}

      {apps.length > 0 ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead>Hostname</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>DNS records</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => (
                <AppDomainRow
                  key={app.name}
                  app={app}
                  orgId={org.id}
                  dnsTarget={dnsTarget}
                  isAdmin={isAdmin}
                  onSuccess={handleSuccess}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No apps deployed yet. Deploy an app, then assign an exact hostname here.
        </p>
      )}
    </div>
  );
}
