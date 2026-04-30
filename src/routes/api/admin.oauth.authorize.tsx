import type { Route } from "./+types/admin.oauth.authorize";
import { data, redirect } from "react-router";
import { ShieldCheck } from "lucide-react";
import { getEnv } from "@/lib/cloudflare.server";
import { requireUserContext } from "@/lib/auth.server";
import {
  ADMIN_MCP_SCOPE,
  getAdminMcpOAuth,
  getAdminMcpResource,
  isAllowedOAuthRedirectUri,
  OAuthError,
} from "@/lib/admin-mcp-oauth.server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function parseAuthorizeParams(params: URLSearchParams) {
  return {
    clientId: params.get("client_id"),
    redirectUri: params.get("redirect_uri"),
    responseType: params.get("response_type"),
    codeChallenge: params.get("code_challenge"),
    codeChallengeMethod: params.get("code_challenge_method"),
    state: params.get("state") ?? "",
    scope: params.get("scope") ?? ADMIN_MCP_SCOPE,
    resource: params.get("resource"),
  };
}

function hasAdminMcpScope(scope: string): boolean {
  return scope.split(/\s+/).includes(ADMIN_MCP_SCOPE);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const oauth = getAdminMcpOAuth(env);
  const url = new URL(request.url);
  const params = parseAuthorizeParams(url.searchParams);

  if (
    !params.clientId ||
    !params.redirectUri ||
    params.responseType !== "code" ||
    !params.codeChallenge
  ) {
    return new OAuthError("invalid_request", "Missing required parameters").toResponse();
  }
  if (params.codeChallengeMethod !== "S256") {
    return new OAuthError("invalid_request", "Only S256 code challenges are supported").toResponse();
  }
  if (!hasAdminMcpScope(params.scope)) {
    return new OAuthError("invalid_scope", `${ADMIN_MCP_SCOPE} scope is required`).toResponse();
  }
  if (!isAllowedOAuthRedirectUri(params.redirectUri)) {
    return new OAuthError("invalid_request", "Invalid redirect_uri").toResponse();
  }
  if (!(await oauth.validateClient(params.clientId, params.redirectUri))) {
    return new OAuthError("invalid_client", "Unknown client_id").toResponse();
  }

  const authContext = await requireUserContext(request, context);
  if (!authContext.user.is_superuser) {
    return data({ error: "Only camelAI admins can authorize the admin MCP server." }, { status: 403 });
  }

  const resource = params.resource ?? getAdminMcpResource(request);
  if (resource !== getAdminMcpResource(request)) {
    return new OAuthError("invalid_target", "Invalid resource").toResponse();
  }

  return {
    ...params,
    resource,
    authorizeUrl: url.pathname + url.search,
    userName: authContext.user.name || authContext.user.email || authContext.user.id,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const env = getEnv(context);
  const oauth = getAdminMcpOAuth(env);
  const url = new URL(request.url);
  const formData = new URLSearchParams(await request.text());
  for (const [key, value] of url.searchParams) {
    if (!formData.has(key)) formData.set(key, value);
  }

  const params = parseAuthorizeParams(formData);
  const resource = formData.get("resource") ?? getAdminMcpResource(request);
  if (
    !params.clientId ||
    !params.redirectUri ||
    !params.codeChallenge ||
    params.responseType !== "code"
  ) {
    return new OAuthError("invalid_request", "Missing required parameters").toResponse();
  }
  if (params.codeChallengeMethod !== "S256") {
    return new OAuthError("invalid_request", "Only S256 code challenges are supported").toResponse();
  }
  if (!hasAdminMcpScope(params.scope)) {
    return new OAuthError("invalid_scope", `${ADMIN_MCP_SCOPE} scope is required`).toResponse();
  }
  if (!isAllowedOAuthRedirectUri(params.redirectUri)) {
    return new OAuthError("invalid_request", "Invalid redirect_uri").toResponse();
  }
  if (!(await oauth.validateClient(params.clientId, params.redirectUri))) {
    return new OAuthError("invalid_client", "Unknown client_id").toResponse(401);
  }
  if (resource !== getAdminMcpResource(request)) {
    return new OAuthError("invalid_target", "Invalid resource").toResponse();
  }

  const authContext = await requireUserContext(request, context);
  if (!authContext.user.is_superuser) {
    return new OAuthError("access_denied", "Only admins can authorize this MCP server").toResponse(403);
  }

  const code = await oauth.createAuthorizationCode({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    scope: params.scope,
    user_id: authContext.user.id,
    resource,
    state: params.state || undefined,
  });

  const callbackUrl = new URL(params.redirectUri);
  callbackUrl.searchParams.set("code", code);
  if (params.state) callbackUrl.searchParams.set("state", params.state);
  return redirect(callbackUrl.toString());
}

export default function AdminMcpAuthorizePage({ loaderData }: Route.ComponentProps) {
  const data = loaderData as
    | {
        error: string;
      }
    | {
        clientId: string;
        redirectUri: string;
        responseType: string;
        codeChallenge: string;
        codeChallengeMethod: string;
        state: string;
        scope: string;
        resource: string;
        authorizeUrl: string;
        userName: string;
      };

  if ("error" in data) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Admin access required</CardTitle>
            <CardDescription>{data.error}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg border bg-muted">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <CardTitle>Authorize Admin MCP</CardTitle>
          <CardDescription>
            Allow this MCP client to access the camelAI admin API as {data.userName}.
          </CardDescription>
        </CardHeader>
        <form method="POST" action={data.authorizeUrl}>
          <CardContent className="space-y-4">
            <input type="hidden" name="client_id" value={data.clientId} />
            <input type="hidden" name="redirect_uri" value={data.redirectUri} />
            <input type="hidden" name="response_type" value={data.responseType} />
            <input type="hidden" name="code_challenge" value={data.codeChallenge} />
            <input type="hidden" name="code_challenge_method" value={data.codeChallengeMethod} />
            <input type="hidden" name="state" value={data.state} />
            <input type="hidden" name="scope" value={data.scope} />
            <input type="hidden" name="resource" value={data.resource} />

            <div className="rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground">
              The MCP client will be able to list and call admin API endpoints. Admin status is checked again on every request.
            </div>
          </CardContent>
          <CardFooter className="gap-3">
            <Button type="button" variant="outline" className="flex-1" onClick={() => window.close()}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1">
              Authorize
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
