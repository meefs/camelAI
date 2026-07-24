import { useEffect, useState } from "react";
import { Form, useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/_app.settings.organization.sso";
import { requireAuthContext, requireOrgAdmin } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { buildOrgSsoPublicConfig } from "../../workers/main/src/org-sso";
import { SettingsHeader } from "@/components/settings/settings-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Check, Copy, Loader2 } from "lucide-react";

export function meta() {
  return [{ title: "SSO - Settings - camelAI" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const current = await requireAuthContext(request, context);
  const auth = await requireOrgAdmin(request, context, current.currentOrg.id);
  const env = getEnv(context);
  const orgStub = env.ORG.get(env.ORG.idFromName(auth.currentOrg.id));
  const config = await orgStub.getSsoConfig();
  return {
    org: auth.currentOrg,
    canLink: !auth.user.is_superuser,
    config: config
      ? buildOrgSsoPublicConfig(config, env.WORKER_BASE_URL, auth.currentOrg.slug)
      : null,
    callbackUrl: new URL("/api/auth/enterprise-oidc/callback", env.WORKER_BASE_URL).toString(),
  };
}

export default function OrganizationSsoSettings() {
  const { org, config, callbackUrl, canLink } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const revalidator = useRevalidator();
  const [issuer, setIssuer] = useState(config?.issuer ?? "");
  const [clientId, setClientId] = useState(config?.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [domains, setDomains] = useState(config?.email_domains.join(", ") ?? "");
  const [authMethod, setAuthMethod] = useState(config?.client_auth_method ?? "client_secret_post");
  const [emailClaim, setEmailClaim] = useState(config?.email_claim ?? "email");
  const [copied, setCopied] = useState<"callback" | "login" | null>(null);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      setClientSecret("");
      revalidator.revalidate();
    }
  }, [fetcher.data, fetcher.state, revalidator]);

  const save = () => {
    fetcher.submit(
      JSON.stringify({
        issuer,
        client_id: clientId,
        client_secret: clientSecret,
        email_domains: domains,
        client_auth_method: authMethod,
        email_claim: emailClaim,
        session_ttl_hours: 8,
      }),
      { method: "POST", action: `/api/orgs/${org.id}/sso`, encType: "application/json" },
    );
  };
  const disable = () => fetcher.submit(null, { method: "DELETE", action: `/api/orgs/${org.id}/sso` });
  const copy = async (kind: "callback" | "login", value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="space-y-6">
      <SettingsHeader title="Single sign-on" description="Connect your organization directly to an OpenID Connect identity provider." />
      <Separator />
      {org.billing_status !== "enterprise" ? (
        <Alert><AlertTitle>Enterprise feature</AlertTitle><AlertDescription>Self-serve SSO is available for enterprise organizations.</AlertDescription></Alert>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>OpenID Connect</CardTitle>
                <CardDescription>Register the callback URL with your IdP, then enter its issuer and client credentials.</CardDescription>
              </div>
              <Badge variant={config?.enabled ? "secondary" : "outline"}>{config?.enabled ? "Active" : config ? "Disabled" : "Not configured"}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {fetcher.data?.error && <Alert variant="destructive"><AlertDescription>{fetcher.data.error}</AlertDescription></Alert>}
            <div className="grid gap-2">
              <Label>Callback URL</Label>
              <div className="flex gap-2">
                <Input readOnly value={callbackUrl} className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={() => copy("callback", callbackUrl)}>{copied === "callback" ? <Check className="size-4" /> : <Copy className="size-4" />}<span className="sr-only">Copy callback URL</span></Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sso-issuer">Issuer URL</Label>
              <Input id="sso-issuer" type="url" value={issuer} onChange={(event) => setIssuer(event.target.value)} placeholder="https://idp.example.com" disabled={busy} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2"><Label htmlFor="sso-client-id">Client ID</Label><Input id="sso-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} disabled={busy} /></div>
              <div className="grid gap-2"><Label htmlFor="sso-client-secret">Client secret</Label><Input id="sso-client-secret" type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder={config?.has_client_secret ? "Leave blank to keep existing" : "Required"} autoComplete="new-password" disabled={busy} /></div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2"><Label>Token endpoint authentication</Label><Select value={authMethod} onValueChange={(value) => setAuthMethod(value as typeof authMethod)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="client_secret_post">Client secret POST</SelectItem><SelectItem value="client_secret_basic">Client secret Basic</SelectItem></SelectContent></Select></div>
              <div className="grid gap-2"><Label>Email claim</Label><Select value={emailClaim} onValueChange={(value) => setEmailClaim(value as typeof emailClaim)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="email">email</SelectItem><SelectItem value="preferred_username">preferred_username (Microsoft Entra)</SelectItem></SelectContent></Select></div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sso-domains">Allowed email domains</Label>
              <Input id="sso-domains" value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="example.com, subsidiary.example.com" disabled={busy} />
              <p className="text-xs text-muted-foreground">The signed identity claim must match one of these exact domains. Users must already have camelAI accounts, be members, and link SSO while signed in.</p>
            </div>
            {config?.login_url && (
              <div className="space-y-4">
                <div className="grid gap-2"><Label>Organization sign-in URL</Label><div className="flex gap-2"><Input readOnly value={config.login_url} className="font-mono text-xs" /><Button variant="outline" size="icon" onClick={() => copy("login", config.login_url)}>{copied === "login" ? <Check className="size-4" /> : <Copy className="size-4" />}<span className="sr-only">Copy sign-in URL</span></Button></div></div>
                {canLink ? <div className="grid gap-2"><Label>Link this account</Label><Form method="post" action="/api/auth/enterprise-oidc/link"><input type="hidden" name="org_id" value={org.id} /><Button type="submit" variant="outline">Link my account with SSO</Button></Form><p className="text-xs text-muted-foreground">You will confirm your identity with the configured IdP. Linking cannot be initiated from an external URL.</p></div> : null}
              </div>
            )}
            <div className="flex justify-between gap-3">
              <div>{config?.enabled && <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" disabled={busy}>Disable SSO</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Disable organization SSO?</AlertDialogTitle><AlertDialogDescription>This immediately revokes sessions issued through this connection.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={disable}>Disable SSO</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}</div>
              <Button onClick={save} disabled={busy || !issuer.trim() || !clientId.trim() || (!clientSecret && !config?.has_client_secret) || !domains.trim()}>{busy && <Loader2 className="size-4 animate-spin" />}{config ? "Save and enable" : "Enable SSO"}</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
