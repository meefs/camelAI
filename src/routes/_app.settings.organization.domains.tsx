import { useEffect, useState } from 'react';
import { useFetcher, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.domains';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { getOrgCustomDomain, isOrgAdmin } from '@/lib/auth-do';
import { getCustomHostnameDnsTarget } from '@/lib/custom-domain-dns';
import { getDcvDelegationUuid } from '../../workers/main/src/cf-api-proxy';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, ArrowRight, CheckCircle2, Globe2, Info, Loader2, Trash2 } from 'lucide-react';

export function meta() {
  return [
    { title: 'Domains - Settings - camelAI' },
    { name: 'description', content: 'Manage custom domains' },
  ];
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

  const [domain, admin, dcvUuid] = await Promise.all([
    getOrgCustomDomain(authEnv, authContext.currentOrg.id),
    isOrgAdmin(authEnv, authContext.user.id, authContext.currentOrg.id),
    env.CF_ZONE_ID && env.CF_API_TOKEN
      ? getDcvDelegationUuid(env.CF_ZONE_ID, env.CF_API_TOKEN)
      : Promise.resolve(null),
  ]);

  return {
    org: authContext.currentOrg,
    domain,
    isAdmin: admin,
    dnsTarget: getCustomHostnameDnsTarget({
      cnameTarget: env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
      fallbackOrigin: env.CF_CUSTOM_HOSTNAME_FALLBACK,
    }),
    dcvUuid,
  };
}

function getDomainStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'failed':
      return 'Needs attention';
    default:
      return 'Pending activation';
  }
}

export default function DomainsPage() {
  const { org, domain: initialDomain, isAdmin, dnsTarget, dcvUuid } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ domain?: unknown; success?: boolean; error?: string }>();
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

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Domains"
        description="Point your own domain at camelAI so every app can live at {app-name}.your-domain."
      />
      <Separator />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {domain ? (
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Globe2 className="size-4 text-muted-foreground" />
                  <CardTitle className="text-base font-medium">Custom domain configured</CardTitle>
                  <Badge variant="secondary">{getDomainStatusLabel(domain.status)}</Badge>
                </div>
                <CardDescription className="max-w-2xl">
                  Your base domain is <span className="font-mono text-foreground">{domain.domain}</span>. Each app will
                  eventually use <span className="font-mono text-foreground">{'{app-name}'}.{domain.domain}</span>.
                  camelAI keeps serving the default app URL until Cloudflare reports that specific hostname and certificate
                  as active, so customers do not get sent to a half-provisioned domain.
                </CardDescription>
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
            </CardHeader>
          </Card>

          <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-medium">1. Add DNS at your provider</CardTitle>
                <CardDescription>
                  Add both records below. The first handles routing, and the second delegates SSL certificate validation to Cloudflare.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div className="rounded-md border bg-muted/40 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Record 1: Routing</p>
                    <div className="mt-3 grid gap-3 font-mono text-sm sm:grid-cols-3">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Host</p>
                        <p className="mt-1 select-all">*</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Type</p>
                        <p className="mt-1">CNAME</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Target</p>
                        <p className="mt-1 break-all select-all">{dnsTarget}</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-md border bg-muted/40 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Record 2: SSL Validation</p>
                    {dcvUuid ? (
                      <div className="mt-3 grid gap-3 font-mono text-sm sm:grid-cols-3">
                        <div>
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">Host</p>
                          <p className="mt-1 break-all select-all">_acme-challenge.{domain.domain}</p>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">Type</p>
                          <p className="mt-1">CNAME</p>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">Target</p>
                          <p className="mt-1 break-all select-all">{dcvUuid}.dcv.cloudflare.com</p>
                        </div>
                      </div>
                    ) : (
                      <Alert className="mt-3">
                        <Info className="size-4" />
                        <AlertDescription>
                          Could not load the DCV delegation target right now. Reload this page before asking the customer to finish DNS setup.
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </div>

                <Alert>
                  <Info className="size-4" />
                  <AlertDescription>
                    If your DNS provider does not support wildcard records, you can add exact host records per app instead.
                    Example: <span className="font-mono">signup</span> <ArrowRight className="mx-1 inline size-3" />
                    <span className="font-mono">CNAME {dnsTarget}</span>.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base font-medium">2. What happens next</CardTitle>
                <CardDescription>Cloudflare provisions each app hostname separately.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <div className="flex gap-3">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-foreground" />
                  <p>camelAI creates a Cloudflare custom hostname for each deployed app under this base domain.</p>
                </div>
                <div className="flex gap-3">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-foreground" />
                  <p>Links stay on the normal <span className="font-mono text-foreground">*.camelai.app</span> URL until that app hostname and SSL certificate are active.</p>
                </div>
                <div className="flex gap-3">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-foreground" />
                  <p>If either DNS record is missing or you test too early, Cloudflare may show DNS, SSL, or cross-account CNAME errors while provisioning catches up.</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">Connect your domain</CardTitle>
            <CardDescription>
              Pick the base domain that should sit after each app name. Example:
              <span className="ml-1 font-mono text-foreground">signup.your-domain.com</span>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="font-medium text-foreground">1. Add your base domain</p>
                <p className="mt-1">Use something like <span className="font-mono text-foreground">apps.example.com</span> or <span className="font-mono text-foreground">example.com</span>.</p>
              </div>
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="font-medium text-foreground">2. Point DNS to camelAI</p>
                <p className="mt-1">We’ll show the exact routing and SSL validation records after you save the domain.</p>
              </div>
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="font-medium text-foreground">3. Wait for activation</p>
                <p className="mt-1">Each app hostname and certificate becomes active independently.</p>
              </div>
            </div>

            <div className="flex max-w-xl gap-2">
              <Input
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                placeholder="apps.example.com"
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

            {!isAdmin && (
              <p className="text-xs text-muted-foreground">Only organization admins can manage custom domains.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
