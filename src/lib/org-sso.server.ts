import * as oidc from "openid-client";
import type { Organization, User } from "@/types";
import type { AuthEnv, SessionData } from "./auth-helpers";
import { createSession } from "./auth-do";
import { decryptCredentials } from "./integration-crypto";
import { isOrgBanned, isUserBanned } from "../../workers/main/src/ban-list";
import {
  isEmailAllowedForOrgSso,
  normalizeSsoIssuer,
  type OrgSsoConfig,
  type OidcClientAuthMethod,
} from "../../workers/main/src/org-sso";
import { ENTERPRISE_OIDC_AUTH_SOURCE } from "../../workers/main/src/signed-session";

const OIDC_HTTP_TIMEOUT_MS = 10_000;
const MAX_OIDC_RESPONSE_BYTES = 1_000_000;

export interface OrgSsoSessionResult {
  session: SessionData;
  signedToken: string;
}

function oidcClientAuthentication(method: OidcClientAuthMethod, secret: string) {
  return method === "client_secret_basic"
    ? oidc.ClientSecretBasic(secret)
    : oidc.ClientSecretPost(secret);
}

const boundedOidcFetch: oidc.CustomFetch = async (url, options) => {
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body as BodyInit,
    redirect: "error",
    signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
  });
  const length = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_OIDC_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("OIDC provider response is too large");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let received = 0;
  const boundedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      received += chunk.value.byteLength;
      if (received > MAX_OIDC_RESPONSE_BYTES) {
        await reader.cancel();
        controller.error(new Error("OIDC provider response is too large"));
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

function validateProviderEndpoint(value: unknown, label: string): void {
  if (typeof value !== "string") throw new Error(`OIDC provider is missing ${label}`);
  normalizeSsoIssuer(value);
}

export async function discoverOidcConfiguration(
  config: Pick<OrgSsoConfig, "issuer" | "client_id" | "client_auth_method">,
  clientSecret: string,
): Promise<oidc.Configuration> {
  const issuer = normalizeSsoIssuer(config.issuer);
  const resolved = await oidc.discovery(
    new URL(issuer),
    config.client_id,
    { client_secret: clientSecret, redirect_uris: [] },
    oidcClientAuthentication(config.client_auth_method, clientSecret),
    { [oidc.customFetch]: boundedOidcFetch },
  );
  resolved.timeout = Math.ceil(OIDC_HTTP_TIMEOUT_MS / 1000);
  // Verify ID-token signatures even when tokens arrive directly from the TLS
  // token endpoint; tenant identity must never rely on transport alone.
  oidc.enableNonRepudiationChecks(resolved);
  const metadata = resolved.serverMetadata();
  if (normalizeSsoIssuer(metadata.issuer) !== issuer) {
    throw new Error("OIDC discovery issuer does not match the configured issuer");
  }
  validateProviderEndpoint(metadata.authorization_endpoint, "authorization_endpoint");
  validateProviderEndpoint(metadata.token_endpoint, "token_endpoint");
  validateProviderEndpoint(metadata.jwks_uri, "jwks_uri");
  if (!metadata.response_types_supported?.includes("code")) {
    throw new Error("OIDC provider does not support the authorization code flow");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("OIDC provider does not advertise PKCE S256 support");
  }
  if (!metadata.token_endpoint_auth_methods_supported?.includes(config.client_auth_method)) {
    throw new Error("OIDC provider does not support the selected client authentication method");
  }
  const signingAlgorithms = metadata.id_token_signing_alg_values_supported ?? [];
  if (!signingAlgorithms.some((algorithm) => /^(?:RS|PS|ES)\d+$|^EdDSA$/.test(algorithm))) {
    throw new Error("OIDC provider does not advertise an asymmetric ID-token signing algorithm");
  }
  return resolved;
}

export async function getOidcConfiguration(
  config: OrgSsoConfig,
  encryptionKey: string,
): Promise<oidc.Configuration> {
  const credentials = await decryptCredentials<{ client_secret: string }>(
    config.client_secret_encrypted,
    encryptionKey,
  );
  if (!credentials.client_secret) throw new Error("OIDC client secret is missing");
  return discoverOidcConfiguration(config, credentials.client_secret);
}

export async function exchangeOidcCode(input: {
  request: Request;
  callbackUrl: string;
  expectedState: string;
  pkceVerifier: string;
  expectedNonce: string;
  oidcConfig: oidc.Configuration;
}) {
  const callback = new URL(input.callbackUrl);
  callback.search = new URL(input.request.url).search;
  const tokens = await oidc.authorizationCodeGrant(input.oidcConfig, callback, {
    pkceCodeVerifier: input.pkceVerifier,
    expectedState: input.expectedState,
    expectedNonce: input.expectedNonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("OIDC provider did not return an ID token");
  return claims;
}

export async function completeOrgSsoLogin(input: {
  request: Request;
  callbackUrl: string;
  expectedState: string;
  transaction: {
    pkce_verifier: string;
    nonce: string;
    link_user_id: string | null;
  };
  authEnv: AuthEnv;
  org: Organization;
  config: OrgSsoConfig;
  encryptionKey: string;
}): Promise<OrgSsoSessionResult> {
  const { request, authEnv, org, config } = input;
  if (org.billing_status !== "enterprise" || !config.enabled) {
    throw new Response("SSO is not available for this organization", { status: 403 });
  }
  const oidcConfig = await getOidcConfiguration(config, input.encryptionKey);
  let claims;
  try {
    claims = await exchangeOidcCode({
      request,
      callbackUrl: input.callbackUrl,
      expectedState: input.expectedState,
      pkceVerifier: input.transaction.pkce_verifier,
      expectedNonce: input.transaction.nonce,
      oidcConfig,
    });
  } catch (error) {
    console.warn("[enterprise-oidc] authorization code exchange failed", {
      orgId: org.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new Response("Enterprise sign-in could not be verified", { status: 403 });
  }

  
  const subject = typeof claims?.sub === "string" ? claims.sub : "";
  const claimValue = claims?.[config.email_claim];
  const email = typeof claimValue === "string" ? claimValue.trim().toLowerCase() : "";
  if (!subject || !email || !isEmailAllowedForOrgSso(email, config.email_domains)) {
    throw new Response("Enterprise identity is not allowed for this organization", { status: 403 });
  }
  if (await isOrgBanned(authEnv.APP_KV, { orgId: org.id })) {
    throw new Response("Organization is blocked", { status: 403 });
  }
  if (await isUserBanned(authEnv.APP_KV, { email })) {
    throw new Response("Account is blocked", { status: 403 });
  }

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.id));
  const mappedUserId = await orgStub.getSsoIdentityUserId(
    config.connection_id,
    config.issuer,
    subject,
  );
  const resolvedUser = mappedUserId
    ? await getMappedUser(authEnv, mappedUserId, email)
    : input.transaction.link_user_id
      ? await getMappedUser(authEnv, input.transaction.link_user_id, email)
      : null;
  if (!resolvedUser) {
    throw new Response(
      "Sign in normally and link your existing account to enterprise SSO first",
      { status: 403 },
    );
  }
  const { userId, user } = resolvedUser;
  const workspaceId = await ensureOrgMembership(authEnv, org, userId);
  await orgStub.bindSsoIdentity(
    config.connection_id,
    config.issuer,
    subject,
    userId,
    email,
  );
  const expiresAt = Date.now() + config.session_ttl_seconds * 1000;
  const { signedToken, sessionData } = await createSession(
    authEnv,
    userId,
    org.id,
    workspaceId,
    { name: user.name, email: user.email },
    {
      authSource: ENTERPRISE_OIDC_AUTH_SOURCE,
      expiresAt,
      ssoConnectionId: config.connection_id,
      ssoConfigVersion: config.config_version,
    },
  );
  return { signedToken, session: sessionData };
}

async function getMappedUser(
  authEnv: AuthEnv,
  userId: string,
  assertedEmail: string,
): Promise<{ userId: string; user: User }> {
  const user = await authEnv.USER.get(authEnv.USER.idFromName(userId)).getProfile();
  if (!user || user.email.toLowerCase() !== assertedEmail || user.is_superuser) {
    throw new Response("Enterprise identity mapping is invalid", { status: 403 });
  }
  if (await isUserBanned(authEnv.APP_KV, { userId, email: assertedEmail })) {
    throw new Response("Account is blocked", { status: 403 });
  }
  return { userId, user };
}

export async function ensureOrgMembership(
  authEnv: AuthEnv,
  org: Organization,
  userId: string,
): Promise<string | null> {
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.id));
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const member = await orgStub.getMember(userId);
  if (!member) {
    throw new Response("SSO membership has been removed", { status: 403 });
  }
  const memberRole = member.role;
  const [activeWorkspaces, userOrgs] = await Promise.all([
    orgStub.listUserWorkspaces(userId),
    userStub.getOrgs(),
  ]);
  const rememberedWorkspace = userOrgs.find((entry) => entry.org_id === org.id)?.last_workspace_id;
  const workspaceId =
    activeWorkspaces.find((workspace) => workspace.id === rememberedWorkspace)?.id ??
    activeWorkspaces[0]?.id ??
    null;

  if (!(await userStub.hasOrg(org.id))) {
    await userStub.addOrg(org.id, memberRole, workspaceId);
  }
  if (workspaceId) {
    await userStub.setOrgLastWorkspace(org.id, workspaceId);
  }
  return workspaceId;
}
