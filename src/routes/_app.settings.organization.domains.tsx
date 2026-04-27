import { useEffect, useState } from 'react';
import { useFetcher, useLoaderData, useNavigate } from 'react-router';
import type { Route } from './+types/_app.settings.organization.domains';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { getOrgCustomDomain, isOrgAdmin } from '@/lib/auth-do';
import { getCustomHostnameDnsTarget } from '@/lib/custom-domain-dns';
import {
  extractCustomHostnameDcvRecord,
  findCustomHostnameByHostname,
  getCustomHostnameStatus,
  type CustomHostnameDcvRecord,
} from '../../workers/main/src/cf-api-proxy';
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

async function getAuthoritativeDcvRecord(options: {
  zoneId?: string | null;
  apiToken?: string | null;
  domain: string | null;
  scripts: Array<{
    script_name: string;
    custom_domain_hostname: string | null;
    custom_domain_cf_hostname_id: string | null;
  }>;
}): Promise<CustomHostnameDcvRecord | null> {
  const zoneId = options.zoneId?.trim();
  const apiToken = options.apiToken?.trim();
  if (!zoneId || !apiToken || !options.domain) return null;

  for (const script of options.scripts) {
    const expectedHostname = `${script.script_name}.${options.domain}`;
    let record = null;
    if (script.custom_domain_cf_hostname_id && script.custom_domain_hostname === expectedHostname) {
      record = await getCustomHostnameStatus(zoneId, apiToken, script.custom_domain_cf_hostname_id);
    }
    record ??= await findCustomHostnameByHostname(zoneId, apiToken, expectedHostname);

    const dcvRecord = extractCustomHostnameDcvRecord(record);
    if (dcvRecord) return dcvRecord;
  }

  return null;
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

  const [domain, admin, scripts] = await Promise.all([
    getOrgCustomDomain(authEnv, authContext.currentOrg.id),
    isOrgAdmin(authEnv, authContext.user.id, authContext.currentOrg.id),
    orgStub.listWorkerScripts(),
  ]);

  const dcvRecord = await getAuthoritativeDcvRecord({
    zoneId: env.CF_ZONE_ID,
    apiToken: env.CF_API_TOKEN,
    domain: domain?.domain ?? null,
    scripts,
  });

  const apps: AppDomainStatus[] = scripts.map((s) => ({
    name: s.script_name,
    hostname: s.custom_domain_hostname,
    status: s.custom_domain_status,
    ssl_status: s.custom_domain_ssl_status,
    error: s.custom_domain_error,
  }));

  return {
    org: authContext.currentOrg,
    domain,
    isAdmin: admin,
    dnsTarget: getCustomHostnameDnsTarget({
      cnameTarget: env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
      fallbackOrigin: env.CF_CUSTOM_HOSTNAME_FALLBACK,
    }),
    dcvRecord,
    apps,
    workspaceId: authContext.currentWorkspace?.id ?? null,
  };
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  switch (status) {
    case 'active':
      return <Badge variant="default" className="bg-green-600 hover:bg-green-600">Active</Badge>;
    case 'failed':
      return <Badge variant="destructive">Needs attention</Badge>;
    default:
      return <Badge variant="secondary">Pending activation</Badge>;
  }
}

function AppStatusIndicator({ app }: { app: AppDomainStatus }) {
  if (!app.hostname) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span className="size-2 rounded-full bg-muted-foreground/40" />
        Not provisioned
      </span>
    );
  }
  if (app.status === 'active' && app.ssl_status === 'active') {
    return (
      <span className="flex items-center gap-1.5 text-green-600">
        <span className="size-2 rounded-full bg-green-600" />
        Active
      </span>
    );
  }
  if (app.status === 'failed' || app.ssl_status === 'failed') {
    const errorText = app.error || 'Provisioning failed';
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1.5 text-destructive cursor-help">
            <span className="size-2 rounded-full bg-destructive" />
            Failed
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs">
          {errorText}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-yellow-600">
      <span className="size-2 rounded-full bg-yellow-500" />
      SSL pending
    </span>
  );
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
        {copied ? 'Copied!' : 'Copy'}
      </TooltipContent>
    </Tooltip>
  );
}

function DnsRecordCard({
  label,
  name,
  target,
}: {
  label: string;
  name: string;
  target: string;
}) {
  return (
    <div className="rounded-md border p-4 space-y-3">
      <p className="text-sm font-medium">{label}</p>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-muted-foreground w-14 inline-block">Type</span>
            <span className="ml-3 font-mono">CNAME</span>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <span className="text-muted-foreground w-14 inline-block">Name</span>
            <span className="ml-3 font-mono break-all">{name}</span>
          </div>
          <CopyButton value={name} />
        </div>
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <span className="text-muted-foreground w-14 inline-block">Target</span>
            <span className="ml-3 font-mono break-all">{target}</span>
          </div>
          <CopyButton value={target} />
        </div>
      </div>
    </div>
  );
}

const PENDING_NEW_THREAD_MESSAGE_KEY = 'pendingMessage:newThread';

export default function DomainsPage() {
  const { org, domain: initialDomain, isAdmin, dnsTarget, dcvRecord, apps, workspaceId } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ domain?: unknown; success?: boolean; error?: string }>();
  const createThreadFetcher = useFetcher<{ thread?: { id: string }; error?: string }>();
  const navigate = useNavigate();
  const [domainInput, setDomainInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState(initialDomain);

  const loading = fetcher.state !== 'idle';

  useEffect(() => {
    setDomain(initialDomain);
  }, [initialDomain]);

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data.error) {
      setError(fetcher.data.error);
      return;
    }

    setError(null);
    if (fetcher.data.domain) {
      setDomain(fetcher.data.domain as typeof domain);
    } else if (fetcher.data.success) {
      setDomain(null);
    }
  }, [domain, fetcher.data, fetcher.state]);

  // Handle thread creation for troubleshooting
  useEffect(() => {
    if (createThreadFetcher.state !== 'idle' || !createThreadFetcher.data) return;

    if (createThreadFetcher.data.thread) {
      const threadId = createThreadFetcher.data.thread.id;
      sessionStorage.setItem(
        PENDING_NEW_THREAD_MESSAGE_KEY,
        JSON.stringify({
          message: `Help me troubleshoot my custom domain setup. My base domain is ${domain?.domain ?? 'unknown'}.`,
          threadId,
        })
      );
      navigate(`/chat/${threadId}?newThread=1`);
      return;
    }

    if (createThreadFetcher.data.error) {
      setError(createThreadFetcher.data.error);
    }
  }, [createThreadFetcher.state, createThreadFetcher.data, navigate, domain?.domain]);

  const handleSetDomain = () => {
    const value = domainInput.trim().toLowerCase();
    if (!value) return;

    setError(null);
    fetcher.submit(
      { intent: 'set', domain: value },
      { method: 'POST', action: `/api/orgs/${org.id}/custom-domain` }
    );
    setDomainInput('');
  };

  const handleRemoveDomain = () => {
    setError(null);
    fetcher.submit(
      { intent: 'remove' },
      { method: 'POST', action: `/api/orgs/${org.id}/custom-domain` }
    );
  };

  const handleTroubleshoot = () => {
    if (createThreadFetcher.state !== 'idle') return;
    createThreadFetcher.submit(
      {
        intent: 'createThread',
        firstMessage: 'Troubleshoot custom domain',
      },
      { method: 'post', action: '/chat' }
    );
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Domains"
        description="Point your own domain at camelAI so every app lives at {app-name}.your-domain."
      />
      <Separator />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {domain ? (
        <div className="space-y-8">
          {/* Domain Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-medium font-mono">{domain.domain}</h3>
                <StatusBadge status={domain.status} />
              </div>
              <p className="text-sm text-muted-foreground">
                Apps are served at <span className="font-mono text-foreground">{'{app-name}'}.{domain.domain}</span>.
                URLs switch from <span className="font-mono">*.camelai.app</span> once each app's hostname and SSL certificate are active.
              </p>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={loading || !isAdmin}
              onClick={handleRemoveDomain}
            >
              <Trash2 className="size-3.5" />
              Remove
            </Button>
          </div>

          <Separator />

          {/* DNS Records Section */}
          <div className="space-y-3">
            <h3 className="text-lg font-medium">DNS Records</h3>
            <p className="text-sm text-muted-foreground">Add both records at your DNS provider.</p>

            <div className="space-y-3">
              <DnsRecordCard
                label="Routing"
                name="*"
                target={dnsTarget}
              />

              {dcvRecord ? (
                <DnsRecordCard
                  label="SSL Validation"
                  name={dcvRecord.cname}
                  target={dcvRecord.cname_target}
                />
              ) : (
                <Alert>
                  <Info className="size-4" />
                  <AlertDescription>
                    Could not load the DCV delegation target right now. Reload this page before configuring DNS.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <Alert>
              <Info className="size-4" />
              <AlertDescription>
                If your DNS provider doesn't support wildcard records, add per-app CNAME records instead.
              </AlertDescription>
            </Alert>
          </div>

          <Separator />

          {/* App Status Section */}
          <div className="space-y-3">
            <h3 className="text-lg font-medium">App Status</h3>
            {apps.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>App</TableHead>
                      <TableHead>Hostname</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apps.map((app) => (
                      <TableRow key={app.name}>
                        <TableCell className="font-medium">{app.name}</TableCell>
                        <TableCell className="font-mono text-muted-foreground">
                          {app.hostname ?? `${app.name}.${domain.domain}`}
                        </TableCell>
                        <TableCell className="text-right">
                          <AppStatusIndicator app={app} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No apps deployed yet. Deploy an app and its custom hostname will be created automatically.
              </p>
            )}
          </div>

          <Separator />

          {/* Need Help Section */}
          <p className="text-sm text-muted-foreground">
            Having trouble?{' '}
            <button
              type="button"
              className="inline text-foreground underline underline-offset-4 hover:text-foreground/80 disabled:opacity-50"
              disabled={createThreadFetcher.state !== 'idle'}
              onClick={handleTroubleshoot}
            >
              {createThreadFetcher.state !== 'idle' ? 'Starting chat...' : 'Troubleshoot in chat'}
            </button>
            {' '}&mdash; the camelAI agent can check your DNS records, verify SSL status, and walk you through fixes.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-medium">Connect a custom domain</h3>
            <p className="text-sm text-muted-foreground">
              Your apps currently use <span className="font-mono text-foreground">*.camelai.app</span> URLs.
              Add a base domain to serve them at <span className="font-mono text-foreground">{'{app-name}'}.your-domain</span>.
            </p>
          </div>

          <div className="flex max-w-xl gap-2">
            <Input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="example.com"
              className="text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSetDomain();
                }
              }}
              disabled={!isAdmin}
            />
            <Button
              type="button"
              disabled={!domainInput.trim() || loading || !isAdmin}
              onClick={handleSetDomain}
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : null}
              Add Domain
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            After adding, we'll show the DNS records to configure at your DNS provider.
          </p>

          {!isAdmin && (
            <p className="text-xs text-muted-foreground">Only organization admins can manage custom domains.</p>
          )}
        </div>
      )}
    </div>
  );
}
