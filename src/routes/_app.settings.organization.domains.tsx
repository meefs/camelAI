import { useState, useEffect } from 'react';
import { useLoaderData, useFetcher } from 'react-router';
import type { Route } from './+types/_app.settings.organization.domains';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { getOrgCustomDomain, isOrgAdmin } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Globe2, Loader2, RefreshCw, Trash2, AlertCircle } from 'lucide-react';

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

  const [domain, admin] = await Promise.all([
    getOrgCustomDomain(authEnv, authContext.currentOrg.id),
    isOrgAdmin(authEnv, authContext.user.id, authContext.currentOrg.id),
  ]);

  return {
    org: authContext.currentOrg,
    domain,
    isAdmin: admin,
    dcvUuid: env.CF_DCV_DELEGATION_UUID ?? null,
    cnameFallback: env.CF_CUSTOM_HOSTNAME_FALLBACK ?? 'custom-domains.camelai.app',
  };
}

export default function DomainsPage() {
  const { org, domain: initialDomain, isAdmin, dcvUuid, cnameFallback } = useLoaderData<typeof loader>();
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
    } else {
      setError(null);
      if (fetcher.data.domain) {
        setDomain(fetcher.data.domain as typeof domain);
      } else if (fetcher.data.success) {
        setDomain(null);
      }
    }
  }, [fetcher.state, fetcher.data]);

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

  const handleCheckStatus = () => {
    setError(null);
    fetcher.submit(
      { intent: 'checkStatus' },
      { method: 'POST', action: `/api/orgs/${org.id}/custom-domain` }
    );
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Domains"
        description="Set a custom domain so all your apps are available at {app-name}.your-domain."
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
          <div className="flex items-center justify-between gap-3 rounded-lg border p-4">
            <div className="flex items-center gap-3 min-w-0">
              <Globe2 className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-mono text-sm truncate">*.{domain.domain}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  All apps available as <span className="font-mono">{'{app-name}'}.{domain.domain}</span>
                </p>
              </div>
              <Badge
                variant={domain.status === 'active' ? 'default' : 'secondary'}
                className="shrink-0 text-[10px]"
              >
                {domain.status === 'active' ? 'Active' : domain.status === 'pending' ? 'Pending' : 'Failed'}
              </Badge>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {domain.status !== 'active' && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading || !isAdmin}
                  onClick={handleCheckStatus}
                >
                  <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
                  Check Status
                </Button>
              )}
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
          </div>

          {domain.status !== 'active' && (
            <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
              <p className="text-sm font-medium">DNS Configuration Required</p>
              <p className="text-sm text-muted-foreground">
                Add the following DNS records:
              </p>
              <div className="space-y-2">
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">1. Wildcard CNAME (routes traffic)</p>
                  <div className="rounded-md bg-background p-3 font-mono text-sm">
                    <span className="text-muted-foreground">*.{domain.domain}</span>
                    {' CNAME '}
                    <span className="select-all">{cnameFallback}</span>
                  </div>
                </div>
                {dcvUuid && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">2. DCV Delegation CNAME (enables automatic SSL)</p>
                    <div className="rounded-md bg-background p-3 font-mono text-sm break-all">
                      <span className="text-muted-foreground">_acme-challenge.{domain.domain}</span>
                      {' CNAME '}
                      <span className="select-all">{domain.domain}.{dcvUuid}.dcv.cloudflare.com</span>
                    </div>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                SSL will be provisioned automatically once both records are detected.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Enter a base domain and we'll set up a wildcard (<span className="font-mono">*.your-domain</span>) so every
            app is automatically available at <span className="font-mono">{'{app-name}'}.your-domain</span>.
          </p>
          <div className="flex gap-2 max-w-md">
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
            <p className="text-xs text-muted-foreground">
              Only organization admins can manage custom domains.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
