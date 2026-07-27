import { useEffect, useState } from "react";
import { Form, useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/_app.settings.organization.sso";
import { requireAuthContext, requireOrgAdmin } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { buildOrgSsoPublicConfig } from "../../workers/main/src/org-sso";
import { SettingsHeader } from "@/components/settings/settings-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Check, CheckCircle2, Copy, Loader2, XCircle } from "lucide-react";

export function meta() {
  return [{ title: "SSO - Settings - camelAI" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const current = await requireAuthContext(request, context);
  const auth = await requireOrgAdmin(request, context, current.currentOrg.id);
  const env = getEnv(context);
  const orgStub = env.ORG.get(env.ORG.idFromName(auth.currentOrg.id));
  const testId = new URL(request.url).searchParams.get("sso_test");
  const [config, connectionTest] = await Promise.all([
    orgStub.getSsoConfig(),
    testId ? orgStub.getSsoConnectionTest(testId, auth.user.id) : null,
  ]);
  return {
    org: auth.currentOrg,
    canLink: !auth.user.is_superuser,
    config: config
      ? buildOrgSsoPublicConfig(
          config,
          env.WORKER_BASE_URL,
          auth.currentOrg.slug,
        )
      : null,
    connectionTest: connectionTest
      ? {
          id: connectionTest.id,
          status: connectionTest.status,
          checks: connectionTest.checks,
          identity: connectionTest.identity,
          error: connectionTest.error,
          candidate: buildOrgSsoPublicConfig(
            connectionTest.config,
            env.WORKER_BASE_URL,
            auth.currentOrg.slug,
          ),
        }
      : null,
    callbackUrl: new URL(
      "/api/auth/enterprise-oidc/callback",
      env.WORKER_BASE_URL,
    ).toString(),
  };
}

export default function OrganizationSsoSettings() {
  const { org, config, connectionTest, callbackUrl, canLink } =
    useLoaderData<typeof loader>();
  const testFetcher = useFetcher<{
    success?: boolean;
    error?: string;
    authorization_url?: string;
  }>();
  const mutationFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const revalidator = useRevalidator();
  const initial = connectionTest?.candidate ?? config;
  const [issuer, setIssuer] = useState(initial?.issuer ?? "");
  const [clientId, setClientId] = useState(initial?.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [domains, setDomains] = useState(
    initial?.email_domains.join(", ") ?? "",
  );
  const [authMethod, setAuthMethod] = useState(
    initial?.client_auth_method ?? "client_secret_post",
  );
  const [emailClaim, setEmailClaim] = useState(initial?.email_claim ?? "email");
  const [copied, setCopied] = useState<"callback" | "login" | null>(null);
  const busy = testFetcher.state !== "idle" || mutationFetcher.state !== "idle";

  useEffect(() => {
    if (testFetcher.state === "idle" && testFetcher.data?.authorization_url) {
      window.location.assign(testFetcher.data.authorization_url);
    }
  }, [testFetcher.data, testFetcher.state]);

  useEffect(() => {
    if (mutationFetcher.state === "idle" && mutationFetcher.data?.success) {
      setClientSecret("");
      revalidator.revalidate();
    }
  }, [mutationFetcher.data, mutationFetcher.state, revalidator]);

  const testConnection = () => {
    testFetcher.submit(
      JSON.stringify({
        intent: "test",
        issuer,
        client_id: clientId,
        client_secret: clientSecret,
        email_domains: domains,
        client_auth_method: authMethod,
        email_claim: emailClaim,
        session_ttl_hours: 8,
      }),
      {
        method: "POST",
        action: `/api/orgs/${org.id}/sso`,
        encType: "application/json",
      },
    );
  };
  const enable = () => {
    if (!connectionTest) return;
    mutationFetcher.submit(
      JSON.stringify({ intent: "enable", test_id: connectionTest.id }),
      {
        method: "POST",
        action: `/api/orgs/${org.id}/sso`,
        encType: "application/json",
      },
    );
  };
  const disable = () =>
    mutationFetcher.submit(null, {
      method: "DELETE",
      action: `/api/orgs/${org.id}/sso`,
    });
  const copy = async (kind: "callback" | "login", value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  };
  const testedFingerprint = connectionTest
    ? JSON.stringify({
        issuer: connectionTest.candidate.issuer,
        client_id: connectionTest.candidate.client_id,
        email_domains: connectionTest.candidate.email_domains.join(","),
        client_auth_method: connectionTest.candidate.client_auth_method,
        email_claim: connectionTest.candidate.email_claim,
      })
    : null;
  const currentFingerprint = JSON.stringify({
    issuer: issuer.trim(),
    client_id: clientId.trim(),
    email_domains: domains
      .split(",")
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean)
      .join(","),
    client_auth_method: authMethod,
    email_claim: emailClaim,
  });
  const testMatchesForm = Boolean(
    connectionTest?.status === "succeeded" &&
    testedFingerprint === currentFingerprint &&
    !clientSecret,
  );
  const testChecks = connectionTest
    ? ([
        [
          "Discovery document found",
          connectionTest.checks.discovery_document_found,
        ],
        [
          "Authorization endpoint found",
          connectionTest.checks.authorization_endpoint_found,
        ],
        ["Token endpoint found", connectionTest.checks.token_endpoint_found],
        ["JWKS signing keys loaded", connectionTest.checks.jwks_loaded],
        [
          "Token exchange succeeded",
          connectionTest.checks.token_exchange_succeeded,
        ],
      ] as const)
    : [];

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Single sign-on"
        description="Connect your organization directly to an OpenID Connect identity provider."
      />
      <Separator />
      {org.billing_status !== "enterprise" ? (
        <Alert>
          <AlertTitle>Enterprise feature</AlertTitle>
          <AlertDescription>
            Self-serve SSO is available for enterprise organizations.
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>OpenID Connect</CardTitle>
                <CardDescription>
                  Register the callback URL with your IdP, then enter its issuer
                  and client credentials.
                </CardDescription>
              </div>
              <Badge variant={config?.enabled ? "secondary" : "outline"}>
                {config?.enabled
                  ? "Active"
                  : config
                    ? "Disabled"
                    : "Not configured"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {(testFetcher.data?.error || mutationFetcher.data?.error) && (
              <Alert variant="destructive">
                <AlertDescription>
                  {testFetcher.data?.error ?? mutationFetcher.data?.error}
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-2">
              <Label>Callback URL</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={callbackUrl}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copy("callback", callbackUrl)}
                >
                  {copied === "callback" ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  <span className="sr-only">Copy callback URL</span>
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sso-issuer">Issuer URL</Label>
              <Input
                id="sso-issuer"
                type="url"
                value={issuer}
                onChange={(event) => setIssuer(event.target.value)}
                placeholder="https://idp.example.com"
                disabled={busy}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="sso-client-id">Client ID</Label>
                <Input
                  id="sso-client-id"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sso-client-secret">Client secret</Label>
                <Input
                  id="sso-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  placeholder={
                    config?.has_client_secret
                      ? "Leave blank to keep existing"
                      : "Required"
                  }
                  autoComplete="new-password"
                  disabled={busy}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Token endpoint authentication</Label>
                <Select
                  value={authMethod}
                  onValueChange={(value) =>
                    setAuthMethod(value as typeof authMethod)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="client_secret_post">
                      Client secret POST
                    </SelectItem>
                    <SelectItem value="client_secret_basic">
                      Client secret Basic
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Email claim</Label>
                <Select
                  value={emailClaim}
                  onValueChange={(value) =>
                    setEmailClaim(value as typeof emailClaim)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">email</SelectItem>
                    <SelectItem value="preferred_username">
                      preferred_username (Microsoft Entra)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sso-domains">Allowed email domains</Label>
              <Input
                id="sso-domains"
                value={domains}
                onChange={(event) => setDomains(event.target.value)}
                placeholder="example.com, subsidiary.example.com"
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                The signed identity claim must match one of these exact domains.
                Verified existing organization members are linked automatically
                on first sign-in; manual linking remains available as a
                fallback.
              </p>
            </div>
            {connectionTest && (
              <Alert
                variant={
                  connectionTest.status === "failed" ? "destructive" : "default"
                }
              >
                {connectionTest.status === "succeeded" ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <XCircle className="size-4" />
                )}
                <AlertTitle>
                  {connectionTest.status === "succeeded"
                    ? "Connection test passed"
                    : "Connection test failed"}
                </AlertTitle>
                <AlertDescription className="space-y-3">
                  {connectionTest.error && <p>{connectionTest.error}</p>}
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {testChecks.map(([label, passed]) => (
                      <li key={label} className="flex items-center gap-2">
                        {passed ? (
                          <CheckCircle2 className="size-4 text-emerald-600" />
                        ) : (
                          <XCircle className="size-4 text-destructive" />
                        )}
                        {label}
                      </li>
                    ))}
                  </ul>
                  {connectionTest.identity && (
                    <div className="grid gap-1 text-sm">
                      <p>
                        <span className="font-medium">User:</span>{" "}
                        {connectionTest.identity.email}
                      </p>
                      <p>
                        <span className="font-medium">Domain:</span>{" "}
                        {connectionTest.identity.domain}
                      </p>
                      <p>
                        <span className="font-medium">Email verified:</span>{" "}
                        {connectionTest.identity.email_verified === true
                          ? "Yes"
                          : connectionTest.identity.email_verified === false
                            ? "No"
                            : "Not asserted by provider"}
                      </p>
                    </div>
                  )}
                  {!testMatchesForm &&
                    connectionTest.status === "succeeded" && (
                      <p>
                        These fields changed after the test. Test the connection
                        again before enabling.
                      </p>
                    )}
                </AlertDescription>
              </Alert>
            )}
            {config?.login_url && (
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Organization sign-in URL</Label>
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={config.login_url}
                      className="font-mono text-xs"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => copy("login", config.login_url)}
                    >
                      {copied === "login" ? (
                        <Check className="size-4" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                      <span className="sr-only">Copy sign-in URL</span>
                    </Button>
                  </div>
                </div>
                {canLink ? (
                  <div className="grid gap-2">
                    <Label>Link this account</Label>
                    <Form method="post" action="/api/auth/enterprise-oidc/link">
                      <input type="hidden" name="org_id" value={org.id} />
                      <Button type="submit" variant="outline">
                        Link my account with SSO
                      </Button>
                    </Form>
                    <p className="text-xs text-muted-foreground">
                      You will confirm your identity with the configured IdP.
                      Linking cannot be initiated from an external URL.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Superusers can test this connection, but enterprise SSO
                    cannot mint a global superuser session. Use a regular
                    organization member to verify the live sign-in URL.
                  </p>
                )}
              </div>
            )}
            <div className="flex justify-between gap-3">
              <div>
                {config?.enabled && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" disabled={busy}>
                        Disable SSO
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Disable organization SSO?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          This immediately revokes sessions issued through this
                          connection.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          onClick={disable}
                        >
                          Disable SSO
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={testConnection}
                  disabled={
                    busy ||
                    !issuer.trim() ||
                    !clientId.trim() ||
                    (!clientSecret && !config?.has_client_secret) ||
                    !domains.trim()
                  }
                >
                  {testFetcher.state !== "idle" && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Test connection
                </Button>
                <Button onClick={enable} disabled={busy || !testMatchesForm}>
                  {mutationFetcher.state !== "idle" && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  {config?.enabled
                    ? "Apply tested configuration"
                    : "Enable SSO"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
