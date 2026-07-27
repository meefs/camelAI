import type { OrgDO } from "./auth.js";
import { ENTERPRISE_OIDC_AUTH_SOURCE } from "./signed-session.js";
import { validateRemoteMcpUrl } from "../../../src/lib/remote-mcp.js";

export const ORG_SSO_CONFIG_KEY = "enterprise_oidc_config";

export type OidcClientAuthMethod = "client_secret_post" | "client_secret_basic";
export type OidcEmailClaim = "email" | "preferred_username";

export interface OrgSsoConfig {
  enabled: boolean;
  connection_id: string;
  protocol: "oidc";
  issuer: string;
  client_id: string;
  client_secret_encrypted: string;
  client_auth_method: OidcClientAuthMethod;
  email_claim: OidcEmailClaim;
  email_domains: string[];
  config_version: number;
  session_ttl_seconds: number;
  updated_at: number;
  updated_by: string;
}

export interface OrgSsoPublicConfig {
  enabled: boolean;
  connection_id: string;
  protocol: "oidc";
  issuer: string;
  client_id: string;
  has_client_secret: boolean;
  client_auth_method: OidcClientAuthMethod;
  email_claim: OidcEmailClaim;
  email_domains: string[];
  config_version: number;
  session_ttl_seconds: number;
  login_url: string;
  callback_url: string;
  updated_at: number;
}

export interface OrgSsoTransaction {
  id: string;
  connection_id: string;
  config_version: number;
  pkce_verifier: string;
  nonce: string;
  browser_binding_hash: string;
  link_user_id: string | null;
  redirect_path: string;
  created_at: number;
  expires_at: number;
}

export interface OrgSsoConnectionTestChecks {
  discovery_document_found: boolean;
  authorization_endpoint_found: boolean;
  token_endpoint_found: boolean;
  jwks_loaded: boolean;
  token_exchange_succeeded: boolean;
}

export interface OrgSsoConnectionTestIdentity {
  email: string;
  domain: string;
  email_verified: boolean | null;
  hosted_domain: string | null;
}

export interface OrgSsoConnectionTest {
  id: string;
  actor_user_id: string;
  base_config_version: number;
  config: OrgSsoConfig;
  status: "pending" | "succeeded" | "failed";
  checks: OrgSsoConnectionTestChecks;
  identity: OrgSsoConnectionTestIdentity | null;
  error: string | null;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
}

export function normalizeSsoIssuer(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Issuer must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    validateRemoteMcpUrl(url.toString()).length > 0
  ) {
    throw new Error("Issuer must be a public HTTPS URL without credentials, query, or fragment");
  }
  if (url.pathname === "/" && !raw.endsWith("/")) return url.origin;
  return `${url.origin}${url.pathname}`;
}

export function normalizeSsoEmailDomains(values: unknown): string[] {
  const raw = Array.isArray(values) ? values : typeof values === "string" ? values.split(",") : [];
  const domains = raw.map((value) => String(value).trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  const unique = [...new Set(domains)];
  if (unique.length === 0) throw new Error("At least one allowed email domain is required");
  if (unique.length > 20) throw new Error("At most 20 email domains are allowed");
  for (const domain of unique) {
    if (
      domain.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)
    ) {
      throw new Error(`Invalid email domain: ${domain}`);
    }
  }
  return unique;
}

export function isEmailAllowedForOrgSso(email: string, domains: string[]): boolean {
  const normalized = email.trim().toLowerCase();
  return domains.some((domain) => normalized.endsWith(`@${domain}`));
}

export function getSafeSsoRedirect(value: string | null): string {
  if (!value) return "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return "/";
  }
  if (
    !value.startsWith("/") ||
    decodedPath.startsWith("//") ||
    decodedPath.startsWith("/\\") ||
    decodedPath.includes("\\") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return "/";
  }
  try {
    const parsed = new URL(value, "https://sso.invalid");
    return parsed.origin === "https://sso.invalid" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
  } catch {
    return "/";
  }
}

export function buildOrgSsoPublicConfig(
  config: OrgSsoConfig,
  appOrigin: string,
  orgSlug: string,
): OrgSsoPublicConfig {
  const origin = new URL(appOrigin).origin;
  return {
    enabled: config.enabled,
    connection_id: config.connection_id,
    protocol: "oidc",
    issuer: config.issuer,
    client_id: config.client_id,
    has_client_secret: Boolean(config.client_secret_encrypted),
    client_auth_method: config.client_auth_method,
    email_claim: config.email_claim,
    email_domains: [...config.email_domains],
    config_version: config.config_version,
    session_ttl_seconds: config.session_ttl_seconds,
    login_url: `${origin}/sso/${encodeURIComponent(orgSlug)}`,
    callback_url: `${origin}/api/auth/enterprise-oidc/callback`,
    updated_at: config.updated_at,
  };
}

/** Revalidate revocable local constraints without contacting the IdP on every request. */
export async function validateOrgSsoSession(
  env: { ORG: DurableObjectNamespace<OrgDO> },
  session: {
    auth_source?: string | null;
    user_id?: string | null;
    org_id?: string | null;
    user_email?: string | null;
    expires_at?: number | null;
    sso_connection_id?: string | null;
    sso_config_version?: number | null;
  },
): Promise<boolean> {
  if (session.auth_source !== ENTERPRISE_OIDC_AUTH_SOURCE) return true;
  if (
    !session.org_id ||
    !session.user_email ||
    !session.sso_connection_id ||
    !session.sso_config_version ||
    typeof session.expires_at !== "number" ||
    !Number.isFinite(session.expires_at) ||
    session.expires_at <= Date.now()
  ) {
    return false;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(session.org_id));
  const [org, config, member] = await Promise.all([
    orgStub.getInfo(),
    orgStub.getSsoConfig(),
    orgStub.getMember(session.user_id ?? ""),
  ]);
  return Boolean(
    org?.billing_status === "enterprise" &&
      config?.enabled &&
      config.connection_id === session.sso_connection_id &&
      config.config_version === session.sso_config_version &&
      member &&
      isEmailAllowedForOrgSso(session.user_email, config.email_domains),
  );
}
