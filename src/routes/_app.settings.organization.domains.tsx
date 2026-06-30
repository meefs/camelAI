import { useEffect, useLayoutEffect, useState } from 'react';
import { useFetcher, useLoaderData, useNavigation, useRevalidator, useSubmit } from 'react-router';
import type { Route } from './+types/_app.settings.organization.domains';
import { requireAuthContext } from '@/lib/auth.server';
import { APP_BUILD_ID } from '@/lib/app-build-id';
import { getEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { isOrgAdmin } from '@/lib/auth-do';
import { getCustomHostnameDnsTarget } from '@/lib/custom-domain-dns';
import { refreshWorkerScriptCustomDomainStates } from '@/lib/custom-domain.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Check, ChevronDown, Copy, Loader2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

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
    // FIXME(badge-positive): Badge has no positive/success variant yet — emulate via outline + primary tokens.
    return (
      <Badge variant="outline" className="border-primary/30 text-primary">
        Active
      </Badge>
    );
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
  const [expanded, setExpanded] = useState<boolean>(Boolean(app.error));
  const loading = fetcher.state !== 'idle';

  useEffect(() => {
    setHostname(app.hostname ?? '');
  }, [app.hostname]);

  useEffect(() => {
    if (app.error) setExpanded(true);
  }, [app.error]);

  useLayoutEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data.error) {
      setError(fetcher.data.error);
      setExpanded(true);
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

  const showDisclosure = expanded && Boolean(app.hostname);

  return (
    <>
      <TableRow>
        <TableCell className="align-top font-medium">{app.name}</TableCell>
        <TableCell className="align-top">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              placeholder="www.example.com or example.com"
              className="w-[300px] max-w-[450px] flex-1 font-mono"
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
                variant="destructive"
                size="icon-sm"
                disabled={!isAdmin || loading}
                onClick={submitRemove}
                aria-label={`Remove custom hostname for ${app.name}`}
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
          {!app.hostname && error ? (
            <p className="mt-2 text-xs text-destructive">{error}</p>
          ) : null}
        </TableCell>
        <TableCell className="align-top">
          <StatusBadge app={app} />
        </TableCell>
        <TableCell className="align-top text-right">
          {app.hostname ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              aria-controls={`dns-${app.name}`}
            >
              DNS
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform',
                  expanded && 'rotate-180'
                )}
              />
            </Button>
          ) : null}
        </TableCell>
      </TableRow>
      {showDisclosure ? (
        <TableRow id={`dns-${app.name}`}>
          <TableCell colSpan={4} className="whitespace-normal bg-muted/30">
            <div className="space-y-2 px-2 py-3 text-sm">
              <DnsRecordLine
                label={`DNS for ${app.hostname}`}
                name={app.hostname!}
                target={dnsTarget}
              />
              <p className="text-xs text-muted-foreground">
                For root domains, use your DNS provider's CNAME flattening, ALIAS,
                or ANAME option.
              </p>
              {error || app.error ? (
                <p className="text-xs text-destructive">{error ?? app.error}</p>
              ) : null}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export default function DomainsPage() {
  const { org, isAdmin, dnsTarget, workspaceId, apps } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const navigation = useNavigation();
  const chatLoading =
    navigation.state !== 'idle' &&
    navigation.formData?.get('intent') === 'createThreadAndStart';
  const chatPrompt =
    '<camelai system message>The user clicked the custom-domain setup CTA from organization settings. Use the custom domain MCP tools to inspect or configure the domain when possible.</camelai system message>\n\nHelp me set up a custom domain.';
  const chatTitle = 'Set up custom domain';

  const handleSuccess = () => {
    if (revalidator.state === 'idle') {
      revalidator.revalidate();
    }
  };

  const startCustomDomainChat = () => {
    if (chatLoading || !workspaceId) return;
    submit(
      {
        intent: 'createThreadAndStart',
        clientBuildId: APP_BUILD_ID,
        initialTitle: chatTitle,
        firstMessage: chatPrompt,
      },
      { method: 'post', action: '/chat' }
    );
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Domains"
        description="Point your own hostname at each deployed app, then update DNS."
      />
      <Separator />

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Have Camel set up your custom domain</h2>
        <p className="text-sm text-muted-foreground">
          Camel has tools to inspect DNS, configure your hostname, and troubleshoot
          SSL. It walks you through DNS provider steps live.
        </p>
        <div>
          <Button
            type="button"
            onClick={startCustomDomainChat}
            disabled={chatLoading || !workspaceId}
          >
            {chatLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Start chat with Camel
          </Button>
        </div>
        {!workspaceId ? (
          <p className="text-xs text-muted-foreground">
            Open a workspace to start a chat with Camel.
          </p>
        ) : null}
      </section>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Configure manually</h2>
        <p className="text-sm text-muted-foreground">
          Prefer to do it yourself? Add a hostname to any deployed app, then point
          your DNS at the camelAI target below.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">DNS target</span>
          <span className="font-mono break-all">{dnsTarget}</span>
          <CopyButton value={dnsTarget} />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Apps</h2>
        {!isAdmin ? (
          <p className="text-sm text-muted-foreground">
            Only organization admins can change custom domains. Ask an admin to add
            a hostname for an app.
          </p>
        ) : null}
        {apps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No apps deployed yet. Once you publish an app, add its hostname here.
          </p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Hostname</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <span className="sr-only">DNS</span>
                  </TableHead>
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
        )}
      </section>
    </div>
  );
}
