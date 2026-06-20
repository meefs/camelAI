/**
 * Provider-agnostic reverse-proxy identity primitives.
 *
 * A trusted reverse proxy (Cloudflare Access, Pomerium, ...) authenticates the
 * user at the edge and forwards a signed identity JWT on every request. This
 * module owns the shared engine for those providers: JWT signature/claim
 * verification, JWKS fetching, org-candidate resolution, and the read-only
 * "does this identity still map to the session org" revalidation. Each provider
 * supplies a small adapter (header name, JWKS URL, signing algorithm, identity
 * resolution, logout URL) via {@link ProxyAuthProvider}; everything else lives
 * here so the app-side silent-login path and the Worker-side revalidation path
 * cannot drift apart.
 *
 * Cloudflare Access is implemented in `access-session.ts`; Pomerium in
 * `pomerium-session.ts`.
 */

import type { OrgDO } from "../auth.js";
import { base64urlDecode } from "../signed-session.js";

type JsonObject = Record<string, unknown>;

/** Signing keys rotate on the order of weeks and old keys remain in the JWKS
 * during rollover; a short cache TTL plus the kid-miss bypass keeps rotation
 * safe while removing the per-request certs fetch. */
const JWKS_CACHE_TTL_SECONDS = 3600;

const DEFAULT_CLAIM_PATHS = ["idp.name", "idp.id", "officeLocation"];

/**
 * WebCrypto parameters per supported JWT signing algorithm. Cloudflare Access
 * signs with RS256 (RSA); Pomerium signs with ES256 (ECDSA P-256).
 */
const ALG_PARAMS: Record<
  string,
  {
    importParams: RsaHashedImportParams | EcKeyImportParams;
    verifyParams: AlgorithmIdentifier | EcdsaParams;
  }
> = {
  RS256: {
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyParams: "RSASSA-PKCS1-v1_5",
  },
  ES256: {
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  },
};

export interface ProxyAuthEnv {
  APP_KV: KVNamespace;
}

export interface ProxyAuthValidationEnv extends ProxyAuthEnv {
  ORG: DurableObjectNamespace<OrgDO>;
}

/**
 * Fully resolved, provider-independent configuration. Provider adapters build
 * this from their own environment variables in {@link ProxyAuthProvider.getConfig}.
 */
export interface ProxyAuthConfig {
  /** Stable namespace segment for org-mapping KV keys (e.g. the CF team domain
   * or the Pomerium issuer). Changing this orphans persisted mappings. */
  namespace: string;
  kvPrefix: string;
  lockPrefix: string;
  /** URL of the JWKS endpoint serving the provider's public signing keys. */
  jwksUrl: string;
  /** Signing algorithms accepted for this provider (e.g. ["RS256"], ["ES256"]). */
  allowedAlgs: readonly string[];
  /** Expected `iss` claim. */
  issuer: string;
  /** Accepted `aud` claim values. */
  audiences: string[];
  orgClaimPaths: string[];
  orgMap: Record<string, string>;
  orgGroupPrefix: string | null;
  adminGroupPrefix: string | null;
  defaultOrgName: string | null;
  requiredEmailDomain: string | null;
}

export interface ProxyJwtPayload extends JsonObject {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  name?: string;
  nbf?: number;
  sub?: string;
}

export interface ProxyIdentity {
  email?: unknown;
  name?: unknown;
  user_uuid?: unknown;
  account_id?: unknown;
  idp?: unknown;
  [key: string]: unknown;
}

export interface ProxyOrgCandidate {
  key: string;
  name: string;
  role: "member" | "admin";
  initializesOrg?: boolean;
}

/**
 * Adapter describing one reverse-proxy identity provider. The shared engine
 * calls these to obtain provider-specific behavior; all org/session logic is
 * provider-independent.
 */
export interface ProxyAuthProvider {
  /** `auth_source` tag stamped on minted signed sessions. */
  authSource: string;
  /** Provider string for `createUserFromOAuth` / `linkOAuthProvider`. */
  oauthProvider: "cloudflare_access" | "pomerium";
  /** "added-by" attribution label for org/workspace membership records. */
  membershipSource: string;
  /** Request header carrying the signed identity assertion JWT. */
  jwtHeader: string;
  /** Resolve provider configuration from env, or null when disabled. */
  getConfig(env: ProxyAuthEnv): ProxyAuthConfig | null;
  /**
   * Resolve the identity document used for org mapping. Cloudflare Access
   * fetches a separate get-identity endpoint (may throw
   * {@link ProxyAuthUnavailableError}); Pomerium returns the JWT payload
   * itself because groups/email/name are inline in the signed token.
   */
  resolveIdentity(
    request: Request,
    token: string,
    payload: ProxyJwtPayload,
    config: ProxyAuthConfig,
  ): Promise<ProxyIdentity | null>;
  /** Build the provider's logout URL, or null when disabled. */
  getLogoutUrl(request: Request, env: ProxyAuthEnv): string | null;
}

/**
 * Thrown when provider infrastructure (JWKS or identity endpoints) cannot be
 * reached or fails upstream. Callers must surface this as a retryable
 * condition (503) rather than treating the identity as invalid or
 * de-provisioned.
 */
export class ProxyAuthUnavailableError extends Error {}

export type ProxySessionValidation = "valid" | "invalid" | "unavailable";

export function emailMatchesRequiredDomain(
  email: string,
  config: ProxyAuthConfig,
): boolean {
  if (!config.requiredEmailDomain) return true;
  return email.endsWith(`@${config.requiredEmailDomain}`);
}

/**
 * Check that the request carries a valid assertion for `expectedEmail` whose
 * current org candidates map to `orgId`, using `provider`. Read-only: never
 * creates or mutates users, orgs, or memberships.
 */
export async function validateProxyIdentityMapsToOrg(
  request: Request,
  env: ProxyAuthValidationEnv,
  provider: ProxyAuthProvider,
  expectedEmail: string | null | undefined,
  orgId: string | null | undefined,
): Promise<ProxySessionValidation> {
  const token = request.headers.get(provider.jwtHeader);
  if (!token) return "invalid";

  const config = provider.getConfig(env);
  if (!config || !orgId) return "invalid";

  let payload: ProxyJwtPayload;
  try {
    payload = await verifyProxyJwt(token, config);
  } catch (error) {
    return error instanceof ProxyAuthUnavailableError ? "unavailable" : "invalid";
  }

  const assertionEmail = normalizeEmail(payload.email);
  const sessionEmail = normalizeEmail(expectedEmail);
  if (!assertionEmail || !sessionEmail || assertionEmail !== sessionEmail) {
    return "invalid";
  }
  if (!emailMatchesRequiredDomain(assertionEmail, config)) return "invalid";

  // Fast path: candidates derived from the JWT alone (operator-configured
  // jwt.* claim paths) can prove the mapping without resolving the full
  // identity. The default-org fallback is excluded here — whether it applies
  // depends on the full identity yielding no candidates.
  const jwtCandidates = resolveOrgCandidates(config, payload, null, {
    includeDefaultFallback: false,
  });
  if (
    jwtCandidates.length > 0 &&
    (await kvMappingMatches(env, config, jwtCandidates, orgId))
  ) {
    return "valid";
  }

  let identity: ProxyIdentity | null = null;
  let identityUnavailable = false;
  try {
    identity = await provider.resolveIdentity(request, token, payload, config);
  } catch (error) {
    if (!(error instanceof ProxyAuthUnavailableError)) throw error;
    // Candidates from the JWT alone may still prove the mapping; only report
    // "unavailable" if they cannot.
    identityUnavailable = true;
  }

  // When identity is unavailable, the default-org fallback must stay excluded:
  // it is the one candidate that needs no identity, so allowing it here would
  // let a stale default-org cookie validate as "valid" during an outage even
  // though the (unseen) identity might now map elsewhere or prove
  // de-provisioning. Report "unavailable" so the caller retries instead.
  const candidates = resolveOrgCandidates(config, payload, identity, {
    includeDefaultFallback: !identityUnavailable,
  });
  if (await kvMappingMatches(env, config, candidates, orgId)) return "valid";
  // APP_KV is eventually consistent across isolates: a mapping written during
  // a just-completed first login may not be visible here yet. The lock DO that
  // created the org holds the authoritative record.
  if (await lockMappingMatches(env, config, candidates, orgId)) return "valid";
  return identityUnavailable ? "unavailable" : "invalid";
}

/**
 * Validate a proxy-backed signed session cookie against the live identity on
 * the request, dispatching on `auth_source` across `providers`. Sessions from
 * other auth sources (password/OAuth) are always "valid". Read-only.
 */
export async function validateProxyBackedSignedSession(
  request: Request,
  env: ProxyAuthValidationEnv,
  session: {
    auth_source?: string | null;
    user_email?: string | null;
    org_id?: string | null;
  },
  providers: readonly ProxyAuthProvider[],
): Promise<ProxySessionValidation> {
  const provider = providers.find((p) => p.authSource === session.auth_source);
  if (!provider) return "valid";
  return validateProxyIdentityMapsToOrg(
    request,
    env,
    provider,
    session.user_email,
    session.org_id,
  );
}

// Request-scoped memo for provider identity fetches: getSession and a route
// guard can both validate the same request, and keying by the Request object
// cannot leak state across requests. Used by adapters (e.g. Cloudflare Access)
// whose identity lives behind a separate endpoint; inline-claim providers (e.g.
// Pomerium) do not need it.
const identityRequestCache = new WeakMap<
  Request,
  Promise<ProxyIdentity | null>
>();

/**
 * Memoize a per-request identity fetch by the Request object. Adapters call
 * this from their `resolveIdentity` so repeated validators on one request share
 * a single upstream round-trip.
 */
export function fetchIdentityViaWeakMap(
  request: Request,
  factory: () => Promise<ProxyIdentity | null>,
): Promise<ProxyIdentity | null> {
  const cached = identityRequestCache.get(request);
  if (cached) return cached;
  const result = factory();
  identityRequestCache.set(request, result);
  return result;
}

export function candidateKvKeys(
  config: ProxyAuthConfig,
  candidates: ProxyOrgCandidate[],
): string[] {
  return candidates.map(
    (candidate) => `${config.kvPrefix}${config.namespace}:${candidate.key}`,
  );
}

async function kvMappingMatches(
  env: ProxyAuthValidationEnv,
  config: ProxyAuthConfig,
  candidates: ProxyOrgCandidate[],
  orgId: string,
): Promise<boolean> {
  const mappedOrgIds = await Promise.all(
    candidateKvKeys(config, candidates).map((kvKey) => env.APP_KV.get(kvKey)),
  );
  return mappedOrgIds.includes(orgId);
}

async function lockMappingMatches(
  env: ProxyAuthValidationEnv,
  config: ProxyAuthConfig,
  candidates: ProxyOrgCandidate[],
  orgId: string,
): Promise<boolean> {
  const mappedOrgIds = await Promise.all(
    candidateKvKeys(config, candidates).map((kvKey) =>
      env.ORG.get(env.ORG.idFromName(`${config.lockPrefix}${kvKey}`))
        .getAccessMappedOrgId(),
    ),
  );
  return mappedOrgIds.includes(orgId);
}

/**
 * Verify the assertion JWT signature and standard claims against `config`.
 * Throws {@link ProxyAuthUnavailableError} when the JWKS endpoint cannot be
 * reached, and a plain Error for any invalid token.
 */
export async function verifyProxyJwt(
  token: string,
  config: ProxyAuthConfig,
): Promise<ProxyJwtPayload> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("Invalid proxy identity JWT");
  }

  const header = decodeJwtPart<JsonObject>(encodedHeader);
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (
    !config.allowedAlgs.includes(alg) ||
    !ALG_PARAMS[alg] ||
    typeof header.kid !== "string"
  ) {
    throw new Error("Unsupported proxy identity JWT");
  }
  const { importParams, verifyParams } = ALG_PARAMS[alg];

  let jwks = await loadJwks(config.jwksUrl, { bypassCache: false });
  let jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) {
    // Key rotation: the cached JWKS may predate this kid; refetch from origin.
    jwks = await loadJwks(config.jwksUrl, { bypassCache: true });
    jwk = jwks.keys?.find((key) => key.kid === header.kid);
  }
  if (!jwk) throw new Error("Proxy identity signing key was not found");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    importParams,
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    verifyParams,
    key,
    base64urlDecode(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new Error("Proxy identity JWT signature is invalid");

  const payload = decodeJwtPart<ProxyJwtPayload>(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== config.issuer) {
    throw new Error("Proxy identity issuer is invalid");
  }
  // Require exp: this assertion gates a session-lifetime credential and is the
  // basis for revalidation, so a signed token with no expiry must not be
  // accepted as valid forever. Both Pomerium and Cloudflare Access always set
  // exp; a missing/non-numeric exp means a misconfigured or untrusted issuer.
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new Error("Proxy identity JWT is expired");
  }
  if (typeof payload.nbf === "number" && payload.nbf > now) {
    throw new Error("Proxy identity JWT is not active yet");
  }
  const tokenAudiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  if (!tokenAudiences.some((audience) => config.audiences.includes(audience))) {
    throw new Error("Proxy identity audience is invalid");
  }
  return payload;
}

/** Edge cache for the JWKS; null outside the Workers runtime. */
function defaultCache(): Cache | null {
  try {
    const cacheStorage = (globalThis as { caches?: { default?: Cache } }).caches;
    return cacheStorage?.default ?? null;
  } catch {
    // Direct workerd self-host runs may expose CacheStorage without a configured
    // default cache binding. Accessing caches.default throws "No Cache was
    // configured" in that runtime; JWKS caching is an optimization, so fall
    // back to fetching the certs directly.
    return null;
  }
}

async function loadJwks(
  jwksUrl: string,
  options: { bypassCache: boolean },
): Promise<{ keys?: JsonObject[] }> {
  const cache = defaultCache();
  if (cache && !options.bypassCache) {
    try {
      const cached = await cache.match(jwksUrl);
      if (cached) return (await cached.json()) as { keys?: JsonObject[] };
    } catch {
      // Direct workerd self-host may expose a Cache object whose operations
      // throw when no default cache binding is configured. Treat cache as an
      // optional optimization and continue to origin fetch.
    }
  }
  let response: Response;
  try {
    response = await fetch(jwksUrl);
  } catch (error) {
    throw new ProxyAuthUnavailableError(
      `Unable to load proxy identity signing keys: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new ProxyAuthUnavailableError(
      "Unable to load proxy identity signing keys",
    );
  }
  const body = await response.text();
  if (cache) {
    try {
      await cache.put(
        jwksUrl,
        new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${JWKS_CACHE_TTL_SECONDS}`,
          },
        }),
      );
    } catch {
      // Cache writes are best-effort only; self-host direct workerd may not
      // configure Cache API storage.
    }
  }
  return JSON.parse(body) as { keys?: JsonObject[] };
}

export function resolveOrgCandidates(
  config: ProxyAuthConfig,
  payload: ProxyJwtPayload,
  identity: ProxyIdentity | null,
  options: { includeDefaultFallback?: boolean } = {},
): ProxyOrgCandidate[] {
  const root = { jwt: payload, ...(identity ?? {}) };
  const candidates: ProxyOrgCandidate[] = [];

  const claimPaths =
    config.orgClaimPaths.length > 0 ? config.orgClaimPaths : DEFAULT_CLAIM_PATHS;
  const valuesByPath = claimPaths.map(
    (path) => [path, valuesAtPath(root, path)] as const,
  );
  const claimValues = new Set(valuesByPath.flatMap(([, values]) => values));
  // Inline IdP groups are also a valid org-map key source. POMERIUM_ORG_MAP is
  // documented to accept group ids, and groups must map without an orgClaimPaths
  // entry: the self-host default points orgClaimPaths at a deliberately-missing
  // claim (`__selfhost_org__`), so a group-id-keyed map would otherwise never
  // produce a candidate (first login 403s or falls back to the default org).
  // Groups are IdP-assigned rather than user-editable, so they satisfy the
  // operator/IdP-controlled-values-only property below.
  const groupValues = new Set(identityGroupValues(root));

  // Explicit org-map entries match only operator/IdP-designated values
  // (configured claim locations or inline groups), never arbitrary identity
  // fields: any user-editable attribute that happened to equal a map key would
  // otherwise grant membership in the mapped org.
  //
  // A claim-value match stays non-initializing: those values can be
  // user-editable in common IdPs (e.g. officeLocation), so they must not be able
  // to bootstrap an org (creation then requires an admin group or the default-org
  // fallback). A group match, however, is keyed on an IdP-assigned value the user
  // cannot set, so a group-keyed map is a deliberate operator mapping that may
  // bootstrap its org on first login — same trust level and candidate shape as
  // the default-org fallback below. Without this the first user of a documented
  // group-id map gets a 403 (member candidate can't create the org, yet its
  // presence suppresses the default-org fallback).
  for (const [key, name] of Object.entries(config.orgMap)) {
    const matchedByGroup = groupValues.has(key);
    if (!claimValues.has(key) && !matchedByGroup) continue;
    // A group already covered by the prefix rules produces its own
    // `group:<name>` candidate (the prefix loops below consult orgMap purely for
    // that org's display name). Emitting a second `map:<group>` candidate would
    // track a separate org under a different KV key for the same group — and now
    // bootstrap it — so let the prefix path own those groups.
    const handledByGroupPrefix =
      matchedByGroup &&
      ((config.orgGroupPrefix !== null && key.startsWith(config.orgGroupPrefix)) ||
        (config.adminGroupPrefix !== null &&
          key.startsWith(config.adminGroupPrefix)));
    if (handledByGroupPrefix) continue;
    candidates.push({
      key: `map:${key}`,
      name,
      role: "member",
      ...(matchedByGroup ? { initializesOrg: true } : {}),
    });
  }

  for (const [path, values] of valuesByPath) {
    for (const value of values) {
      if (config.orgMap[value] !== undefined) continue;
      candidates.push({
        key: `${path}:${value}`,
        name: humanizeOrgName(value),
        role: "member",
      });
    }
  }

  if (config.orgGroupPrefix) {
    for (const group of identityGroupValues(root)) {
      if (!group.startsWith(config.orgGroupPrefix)) continue;
      if (config.adminGroupPrefix && group.startsWith(config.adminGroupPrefix)) {
        continue;
      }
      const rawName = group.slice(config.orgGroupPrefix.length).trim();
      if (!rawName) continue;
      const name = config.orgMap[group] ?? humanizeOrgName(rawName);
      candidates.push({
        key: `group:${orgKeyFromName(name)}`,
        name,
        role: "member",
      });
    }
  }

  if (config.adminGroupPrefix) {
    for (const group of identityGroupValues(root)) {
      if (!group.startsWith(config.adminGroupPrefix)) continue;
      const rawName = group.slice(config.adminGroupPrefix.length).trim();
      if (!rawName) continue;
      const name = config.orgMap[group] ?? humanizeOrgName(rawName);
      candidates.push({
        key: `group:${orgKeyFromName(name)}`,
        name,
        role: "admin",
      });
    }
  }

  if (
    candidates.length === 0 &&
    config.defaultOrgName &&
    (options.includeDefaultFallback ?? true)
  ) {
    candidates.push({
      key: `default:${config.defaultOrgName}`,
      name: config.defaultOrgName,
      role: "member",
      initializesOrg: true,
    });
  }

  const deduped = new Map<string, ProxyOrgCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.key);
    if (!existing || (existing.role === "member" && candidate.role === "admin")) {
      deduped.set(candidate.key, candidate);
    }
  }
  return [...deduped.values()];
}

/**
 * Normalize an operator-supplied origin or URL to `https://...` with no trailing
 * slash.
 *
 * The JWKS fetched from this origin is the trust root for accepting reverse-proxy
 * identity assertions, so it must never be fetched over plaintext: a network
 * attacker on the path to an `http://` origin could substitute signing keys and
 * have forged assertion headers validated. We therefore upgrade `http://` (and
 * bare hosts) to `https://` rather than preserving the insecure scheme.
 */
export function normalizeHttpsUrl(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("http://")) {
    return `https://${trimmed.slice("http://".length)}`;
  }
  return `https://${trimmed}`;
}

export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizedOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseOrgMap(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (typeof raw === "string" && raw.trim()) {
        result[key] = raw.trim();
      } else if (
        raw &&
        typeof raw === "object" &&
        typeof (raw as { name?: unknown }).name === "string"
      ) {
        result[key] = (raw as { name: string }).name.trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function valuesAtPath(root: unknown, path: string): string[] {
  let current = root;
  for (const segment of path.split(".")) {
    if (!segment) continue;
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return [];
    }
    current = (current as JsonObject)[segment];
  }
  if (typeof current === "string") return [current.trim()].filter(Boolean);
  if (Array.isArray(current)) {
    return current
      .flatMap((item) => {
        if (typeof item === "string") return [item.trim()];
        if (item && typeof item === "object") {
          return [
            firstString(
              (item as JsonObject).id,
              (item as JsonObject).name,
              (item as JsonObject).displayName,
              (item as JsonObject).value,
            ),
          ];
        }
        return [];
      })
      .filter((item): item is string => Boolean(item));
  }
  return [];
}

function identityGroupValues(root: unknown): string[] {
  return [
    ...valuesAtPath(root, "idp.groups"),
    ...valuesAtPath(root, "groups"),
    ...valuesAtPath(root, "idp.groupIds"),
    ...valuesAtPath(root, "groupIds"),
  ];
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function normalizeEmail(value: unknown): string | null {
  const email = firstString(value)?.toLowerCase();
  return email && email.includes("@") ? email : null;
}

export function humanizeOrgName(value: string): string {
  return value
    .replace(/^[^:]+:/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function orgKeyFromName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(value))) as T;
}
