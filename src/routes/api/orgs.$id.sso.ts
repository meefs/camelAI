import * as oidc from "openid-client";
import type { Route } from "./+types/orgs.$id.sso";
import { requireOrgAdmin, getAuthEnv } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  encryptCredentials,
  decryptCredentials,
} from "@/lib/integration-crypto";
import {
  discoverOidcConfiguration,
  getOidcDiscoveryErrorDiagnostic,
  getOidcDiscoveryErrorMessage,
  validateOidcJwks,
} from "@/lib/org-sso.server";
import {
  createSsoBrowserBinding,
  createSsoBrowserBindingCookie,
  hashSsoBrowserBinding,
} from "@/lib/org-sso-browser.server";
import {
  buildOrgSsoPublicConfig,
  normalizeSsoEmailDomains,
  normalizeSsoIssuer,
  type OidcClientAuthMethod,
  type OidcEmailClaim,
  type OrgSsoConfig,
} from "../../../workers/main/src/org-sso";
import { createSignedEnterpriseSsoState } from "../../../workers/main/src/signed-session";

const CLIENT_AUTH_METHODS: OidcClientAuthMethod[] = [
  "client_secret_post",
  "client_secret_basic",
];
const EMAIL_CLAIMS: OidcEmailClaim[] = ["email", "preferred_username"];
const CONNECTION_TEST_TTL_MS = 10 * 60 * 1000;

function assertSameOrigin(
  request: Request,
  workerBaseUrl: string,
): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(workerBaseUrl).origin) {
    return Response.json({ error: "Invalid request origin" }, { status: 403 });
  }
  return null;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireOrgAdmin(request, context, params.id);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(params.id));
  if (!(await orgStub.isOwner(authContext.user.id))) {
    return Response.json(
      { error: "Only organization owners can configure SSO" },
      { status: 403 },
    );
  }
  const [org, config] = await Promise.all([
    orgStub.getInfo(),
    orgStub.getSsoConfig(),
  ]);
  if (!org)
    return Response.json({ error: "Organization not found" }, { status: 404 });
  return Response.json({
    available: org.billing_status === "enterprise",
    configured: Boolean(config),
    config: config
      ? buildOrgSsoPublicConfig(config, env.WORKER_BASE_URL, org.slug)
      : null,
    callback_url: new URL(
      "/api/auth/enterprise-oidc/callback",
      env.WORKER_BASE_URL,
    ).toString(),
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
  if (!(await orgStub.isOwner(authContext.user.id))) {
    return Response.json(
      { error: "Only organization owners can configure SSO" },
      { status: 403 },
    );
  }
  const org = await orgStub.getInfo();
  if (!org)
    return Response.json({ error: "Organization not found" }, { status: 404 });
  if (org.billing_status !== "enterprise") {
    return Response.json(
      { error: "Self-serve SSO is available to enterprise organizations" },
      { status: 403 },
    );
  }

  const leaseToken = await orgStub.claimSsoProvisioning();
  if (!leaseToken) {
    return Response.json(
      { error: "Another SSO configuration change is already in progress" },
      { status: 409 },
    );
  }

  try {
    const existing = await orgStub.getSsoConfig();
    if (request.method === "DELETE") {
      const disabled = await orgStub.disableSsoConfig(authContext.user.id);
      return Response.json({
        success: true,
        config: disabled
          ? buildOrgSsoPublicConfig(disabled, env.WORKER_BASE_URL, org.slug)
          : null,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const intent = body.intent;
    if (intent === "enable") {
      const testId = typeof body.test_id === "string" ? body.test_id : "";
      const tested = testId
        ? await orgStub.getSsoConnectionTest(testId, authContext.user.id)
        : null;
      if (!tested || tested.status !== "succeeded") {
        return Response.json(
          {
            error:
              "Run and complete a successful connection test before enabling SSO",
          },
          { status: 409 },
        );
      }
      if ((existing?.config_version ?? 0) !== tested.base_config_version) {
        return Response.json(
          {
            error:
              "The SSO configuration changed after this test; run the test again",
          },
          { status: 409 },
        );
      }
      const consumed = await orgStub.consumeSuccessfulSsoConnectionTest(
        testId,
        authContext.user.id,
      );
      if (!consumed) {
        return Response.json(
          { error: "This connection test has expired or was already used" },
          { status: 409 },
        );
      }
      const enabled = {
        ...consumed.config,
        enabled: true,
        updated_at: Date.now(),
        updated_by: authContext.user.id,
      };
      await orgStub.setSsoConfig(enabled, authContext.user.id);
      return Response.json({
        success: true,
        config: buildOrgSsoPublicConfig(enabled, env.WORKER_BASE_URL, org.slug),
      });
    }
    if (intent !== "test") {
      return Response.json(
        { error: "Run a connection test before enabling SSO" },
        { status: 400 },
      );
    }

    let issuer: string;
    let emailDomains: string[];
    try {
      issuer = normalizeSsoIssuer(body.issuer);
      emailDomains = normalizeSsoEmailDomains(body.email_domains);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid SSO configuration",
        },
        { status: 400 },
      );
    }
    const clientId =
      typeof body.client_id === "string" ? body.client_id.trim() : "";
    const providedSecret =
      typeof body.client_secret === "string" ? body.client_secret : "";
    if (!clientId || clientId.length > 500) {
      return Response.json(
        {
          error:
            "OIDC client ID is required and must be at most 500 characters",
        },
        { status: 400 },
      );
    }
    if (providedSecret.length > 4000) {
      return Response.json(
        { error: "OIDC client secret must be at most 4000 characters" },
        { status: 400 },
      );
    }
    const clientAuthMethod = body.client_auth_method as OidcClientAuthMethod;
    const emailClaim = body.email_claim as OidcEmailClaim;
    if (!CLIENT_AUTH_METHODS.includes(clientAuthMethod)) {
      return Response.json(
        { error: "Unsupported OIDC client authentication method" },
        { status: 400 },
      );
    }
    if (!EMAIL_CLAIMS.includes(emailClaim)) {
      return Response.json(
        { error: "Unsupported OIDC email claim" },
        { status: 400 },
      );
    }
    const sessionHours = Number(body.session_ttl_hours ?? 8);
    if (
      !Number.isInteger(sessionHours) ||
      sessionHours < 1 ||
      sessionHours > 24
    ) {
      return Response.json(
        { error: "Session duration must be between 1 and 24 hours" },
        { status: 400 },
      );
    }

    let clientSecret = providedSecret;
    const canReuseExistingSecret = Boolean(
      existing?.client_secret_encrypted &&
        existing.issuer === issuer &&
        existing.client_id === clientId &&
        existing.client_auth_method === clientAuthMethod,
    );
    if (!clientSecret && canReuseExistingSecret && existing) {
      const credentials = await decryptCredentials<{ client_secret: string }>(
        existing.client_secret_encrypted,
        env.INTEGRATION_SECRET_KEY,
      );
      clientSecret = credentials.client_secret;
    }
    if (!clientSecret) {
      return Response.json(
        {
          error: canReuseExistingSecret
            ? "OIDC client secret is required"
            : "Enter the OIDC client secret when changing the issuer, client ID, or authentication method",
        },
        { status: 400 },
      );
    }

    const candidate: OrgSsoConfig = {
      enabled: false,
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
      jit_provisioning_enabled: body.jit_provisioning_enabled === true,
      config_version: (existing?.config_version ?? 0) + 1,
      session_ttl_seconds: sessionHours * 60 * 60,
      updated_at: Date.now(),
      updated_by: authContext.user.id,
    };

    let oidcConfig: oidc.Configuration;
    try {
      oidcConfig = await discoverOidcConfiguration(candidate, clientSecret);
      await validateOidcJwks(oidcConfig);
    } catch (error) {
      const diagnostic = getOidcDiscoveryErrorDiagnostic(error);
      console.warn("[enterprise-oidc] discovery validation failed", {
        orgId: org.id,
        ...diagnostic,
      });
      return Response.json(
        { error: getOidcDiscoveryErrorMessage(error) },
        { status: 400 },
      );
    }

    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const nonce = oidc.randomNonce();
    const testId = crypto.randomUUID();
    const browserBinding = createSsoBrowserBinding();
    const now = Date.now();
    await orgStub.createSsoConnectionTest({
      id: testId,
      actor_user_id: authContext.user.id,
      base_config_version: existing?.config_version ?? 0,
      config: candidate,
      status: "pending",
      checks: {
        discovery_document_found: true,
        authorization_endpoint_found: true,
        token_endpoint_found: true,
        jwks_loaded: true,
        token_exchange_succeeded: false,
      },
      identity: null,
      error: null,
      created_at: now,
      expires_at: now + CONNECTION_TEST_TTL_MS,
      completed_at: null,
    });
    await orgStub.createSsoTransaction({
      id: testId,
      connection_id: candidate.connection_id,
      config_version: candidate.config_version,
      pkce_verifier: verifier,
      nonce,
      browser_binding_hash: await hashSsoBrowserBinding(browserBinding),
      link_user_id: authContext.user.id,
      redirect_path: "/settings/organization/sso",
      created_at: now,
      expires_at: now + CONNECTION_TEST_TTL_MS,
    });
    const state = await createSignedEnterpriseSsoState(
      env.TOKEN_SIGNING_SECRET,
      {
        org_id: org.id,
        transaction_id: testId,
        connection_id: candidate.connection_id,
        config_version: candidate.config_version,
        purpose: "test",
        created_at: now,
      },
    );
    const callbackUrl = new URL(
      "/api/auth/enterprise-oidc/callback",
      env.WORKER_BASE_URL,
    ).toString();
    const authorizationUrl = oidc.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: callbackUrl,
      scope: "openid email profile",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      nonce,
      state,
    });
    return Response.json(
      {
        success: true,
        test_id: testId,
        authorization_url: authorizationUrl.toString(),
      },
      {
        headers: {
          "Set-Cookie": createSsoBrowserBindingCookie(
            testId,
            browserBinding,
            CONNECTION_TEST_TTL_MS / 1000,
          ),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("[enterprise-oidc] configuration failed", {
      orgId: org.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      { error: "Enterprise SSO configuration failed" },
      { status: 500 },
    );
  } finally {
    await orgStub.releaseSsoProvisioning(leaseToken);
  }
}
