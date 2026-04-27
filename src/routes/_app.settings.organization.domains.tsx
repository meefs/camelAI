import { useEffect, useState } from 'react';
import { useFetcher, useLoaderData, useNavigate, useRevalidator } from 'react-router';
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
import { AlertCircle, Check, Copy, Loader2, MessageSquare, Trash2 } from 'lucide-react';

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
    workspaceId: authContext.currentWorkspace?.id ?? null,
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
          <span className="text-muted-foreground">Type</span>
          <span className="ml-2 font-mono">CNAME</span>
        </div>
      </div>
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
              placeholder="www.example.com or example.com"
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
            <DnsRecordLine label="Create this DNS record" name={app.hostname} target={dnsTarget} />
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Add a hostname to see its DNS record.</span>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function DomainsPage() {
  const { org, isAdmin, dnsTarget, workspaceId, apps } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const chatFetcher = useFetcher<{
    thread?: { id: string; model?: string | null; provider?: string | null };
    error?: string;
  }>();
  const chatLoading = chatFetcher.state !== 'idle';
  const chatPrompt =
    '<camelai system message>The user clicked the custom-domain setup CTA from organization settings. Use the custom domain MCP tools to inspect or configure the domain when possible.</camelai system message>\n\nHelp me set up a custom domain.';
  const chatTitle = 'Set up custom domain';

  const handleSuccess = () => {
    if (revalidator.state === 'idle') {
      revalidator.revalidate();
    }
  };

  useEffect(() => {
    if (chatFetcher.state !== 'idle' || !chatFetcher.data) return;
    if (!chatFetcher.data.thread) return;

    const threadId = chatFetcher.data.thread.id;
    sessionStorage.setItem(
      'pendingMessage:newThread',
      JSON.stringify({
        message: chatPrompt,
        threadId,
        threadTitle: chatTitle,
        threadModel: chatFetcher.data.thread.model,
        threadProvider: chatFetcher.data.thread.provider,
        workspaceId,
        orgSlug: org.slug,
      })
    );
    navigate(`/chat/${threadId}?newThread=1`);
  }, [chatFetcher.state, chatFetcher.data, chatPrompt, workspaceId, org.slug, navigate]);

  const startCustomDomainChat = () => {
    if (chatLoading || !workspaceId) return;
    chatFetcher.submit(
      {
        intent: 'createThread',
        initialTitle: chatTitle,
      },
      { method: 'post', action: '/chat' }
    );
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Domains"
        description="Assign an exact hostname to each deployed app, then point that hostname at camelAI."
      />
      <Separator />

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Setup</h2>
          <p className="text-sm text-muted-foreground">
            Enter the hostname you want for an app, save it, then create the DNS record
            shown in that app's row. For root domains like example.com, use your DNS
            provider's CNAME flattening, ALIAS, or ANAME option if plain CNAME records
            are not allowed.
          </p>
          <p className="text-sm text-muted-foreground">
            You can also ask Camel to set up or troubleshoot a custom domain for one
            of your apps.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={startCustomDomainChat}
            disabled={chatLoading || !workspaceId}
          >
            {chatLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <MessageSquare className="size-3.5" />
            )}
            Start chat with Camel
          </Button>
          {chatFetcher.data?.error ? (
            <p className="text-xs text-destructive">{chatFetcher.data.error}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <span className="text-muted-foreground">DNS target</span>
            <span className="ml-2 font-mono break-all">{dnsTarget}</span>
          </div>
          <CopyButton value={dnsTarget} />
        </div>
      </section>

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
                <TableHead>DNS record</TableHead>
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
