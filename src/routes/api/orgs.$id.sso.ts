import type { Route } from "./+types/orgs.$id.sso";
import { requireOrgAdmin, getAuthEnv } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { encryptCredentials, decryptCredentials } from "@/lib/integration-crypto";
import { discoverOidcConfiguration } from "@/lib/org-sso.server";
import {
  buildOrgSsoPublicConfig,
  normalizeSsoEmailDomains,
  normalizeSsoIssuer,
  type OidcClientAuthMethod,
  type OidcEmailClaim,
  type OrgSsoConfig,
} from "../../../workers/main/src/org-sso";

const CLIENT_AUTH_METHODS: OidcClientAuthMethod[] = ["client_secret_post", "client_secret_basic"];
const EMAIL_CLAIMS: OidcEmailClaim[] = ["email", "preferred_username"];

function assertSameOrigin(request: Request, workerBaseUrl: string): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(workerBaseUrl).origin) {
    return Response.json({ error: "Invalid request origin" }, { status: 403 });
  }
  return null;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireOrgAdmin(request, context, params.id);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(params.id));
  const [org, config] = await Promise.all([orgStub.getInfo(), orgStub.getSsoConfig()]);
  if (!org) return Response.json({ error: "Organization not found" }, { status: 404 });
  return Response.json({
    available: org.billing_status === "enterprise",
    configured: Boolean(config),
    config: config ? buildOrgSsoPublicConfig(config, env.WORKER_BASE_URL, org.slug) : null,
    callback_url: new URL("/api/auth/enterprise-oidc/callback", env.WORKER_BASE_URL).toString(),
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const authContext = await requireOrgAdmin(request, context, params.id);
  const env = getEnv(context);
  const originError = assertSameOrigin(request, env.WORKER_BASE_URL);
  if (originError) return originError;
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(params.id));
  const [org, existing] = await Promise.all([orgStub.getInfo(), orgStub.getSsoConfig()]);
  if (!org) return Response.json({ error: "Organization not found" }, { status: 404 });
  if (org.billing_status !== "enterprise") {
    return Response.json({ error: "Self-serve SSO is available to enterprise organizations" }, { status: 403 });
  }

  const leaseToken = await orgStub.claimSsoProvisioning();
  if (!leaseToken) {
    return Response.json({ error: "Another SSO configuration change is already in progress" }, { status: 409 });
  }

  try {
    if (request.method === "DELETE") {
      const disabled = await orgStub.disableSsoConfig(authContext.user.id);
      return Response.json({
        success: true,
        config: disabled ? buildOrgSsoPublicConfig(disabled, env.WORKER_BASE_URL, org.slug) : null,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    let issuer: string;
    let emailDomains: string[];
    try {
      issuer = normalizeSsoIssuer(body.issuer);
      emailDomains = normalizeSsoEmailDomains(body.email_domains);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid SSO configuration" }, { status: 400 });
    }
    const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";
    const providedSecret = typeof body.client_secret === "string" ? body.client_secret : "";
    if (!clientId || clientId.length > 500) {
      return Response.json({ error: "OIDC client ID is required and must be at most 500 characters" }, { status: 400 });
    }
    if (providedSecret.length > 4000) {
      return Response.json({ error: "OIDC client secret must be at most 4000 characters" }, { status: 400 });
    }
    const clientAuthMethod = body.client_auth_method as OidcClientAuthMethod;
    const emailClaim = body.email_claim as OidcEmailClaim;
    if (!CLIENT_AUTH_METHODS.includes(clientAuthMethod)) {
      return Response.json({ error: "Unsupported OIDC client authentication method" }, { status: 400 });
    }
    if (!EMAIL_CLAIMS.includes(emailClaim)) {
      return Response.json({ error: "Unsupported OIDC email claim" }, { status: 400 });
    }
    const sessionHours = Number(body.session_ttl_hours ?? 8);
    if (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 24) {
      return Response.json({ error: "Session duration must be between 1 and 24 hours" }, { status: 400 });
    }

    let clientSecret = providedSecret;
    if (!clientSecret && existing?.client_secret_encrypted) {
      const credentials = await decryptCredentials<{ client_secret: string }>(
        existing.client_secret_encrypted,
        env.INTEGRATION_SECRET_KEY,
      );
      clientSecret = credentials.client_secret;
    }
    if (!clientSecret) {
      return Response.json({ error: "OIDC client secret is required" }, { status: 400 });
    }

    const candidate: OrgSsoConfig = {
      enabled: true,
      connection_id:
        existing?.issuer === issuer && existing.client_id === clientId
          ? existing.connection_id
          : crypto.randomUUID(),
      protocol: "oidc",
      issuer,
      client_id: clientId,
      client_secret_encrypted: await encryptCredentials(
        { client_secret: clientSecret },
        env.INTEGRATION_SECRET_KEY,
      ),
      client_auth_method: clientAuthMethod,
      email_claim: emailClaim,
      email_domains: emailDomains,
      config_version: (existing?.config_version ?? 0) + 1,
      session_ttl_seconds: sessionHours * 60 * 60,
      updated_at: Date.now(),
      updated_by: authContext.user.id,
    };

    try {
      await discoverOidcConfiguration(candidate, clientSecret);
    } catch (error) {
      console.warn("[enterprise-oidc] discovery validation failed", {
        orgId: org.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return Response.json({ error: "Could not validate the OIDC issuer and discovery document" }, { status: 400 });
    }
    await orgStub.setSsoConfig(candidate, authContext.user.id);
    return Response.json({
      success: true,
      config: buildOrgSsoPublicConfig(candidate, env.WORKER_BASE_URL, org.slug),
    });
  } catch (error) {
    console.error("[enterprise-oidc] configuration failed", {
      orgId: org.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json({ error: "Enterprise SSO configuration failed" }, { status: 500 });
  } finally {
    await orgStub.releaseSsoProvisioning(leaseToken);
  }
}
